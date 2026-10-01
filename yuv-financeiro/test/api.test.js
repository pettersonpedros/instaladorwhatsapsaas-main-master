const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yuv-test-'));
process.env.TZ = 'America/Sao_Paulo';
process.env.NF_AUTOMATICA = '1';
delete process.env.SMTP_URL;
const store = require('../server/db');
const { build } = require('../server/app');
const auth = require('../server/auth');
const scheduler = require('../server/scheduler');
const D = require('../shared/domain');

let base, server, cookie = '';
const call = async (method, url, body) => {
  const o = { method, headers: { cookie } };
  if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch(base + '/api' + url, o);
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};

test.before(async () => {
  auth.createUser({ email: 'a@a.com', name: 'Ana', password: 'senha-forte' });
  server = build().listen(0); await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

test('fluxo completo: cliente → cobrança → pagamento → NF', async () => {
  assert.strictEqual((await call('GET', '/state')).status, 401);
  assert.strictEqual((await call('POST', '/login', { email: 'a@a.com', password: 'x' })).status, 401);
  assert.strictEqual((await call('POST', '/login', { email: 'a@a.com', password: 'senha-forte' })).status, 200);

  const bad = await call('POST', '/clients', { client: { name: 'X', due: 15, linhas: [{ linha: 'streamax', ativos: 5, comodato: 9 }] } });
  assert.strictEqual(bad.status, 400);

  const c = (await call('POST', '/clients', { client: { name: 'Cliente Um', cnpj: '12.345.678/0001-90', due: 10, mode: 'later', email: 'fin@um.com', linhas: [{ linha: 'streamax', ativos: 10, comodato: 0 }] } })).body;
  const st = (await call('GET', '/state')).body;
  const send = await call('POST', '/billing/send', { comp: st.competencia, ids: [c.id] });
  assert.strictEqual(send.body.created, 1);
  assert.strictEqual(send.body.total, 300);
  const again = await call('POST', '/billing/send', { comp: st.competencia, ids: [c.id] });
  assert.strictEqual(again.body.created, 0);

  const inv = (await call('GET', '/state')).body.invoices[0];
  assert.strictEqual(inv.nf, 'aguardando');
  assert.ok(inv.boletoRef);
  const p1 = (await call('POST', `/invoices/${inv.id}/payments`, { valor: 100 })).body;
  assert.strictEqual(p1.nf, 'retida');
  const p2 = (await call('POST', `/invoices/${inv.id}/payments`, { valor: '200,00' })).body;
  assert.strictEqual(p2.nf, 'emitida_pos');
  assert.ok(p2.nfRef);

  const upd = await call('PUT', `/clients/${c.id}`, { client: { ...c, due: 12 }, why: '' });
  assert.strictEqual(upd.status, 400);
  await call('PUT', `/clients/${c.id}`, { client: { ...c, due: 12 }, why: 'pedido do cliente' });
  const h = (await call('GET', '/state')).body.clients[0].history;
  assert.match(h[0].what, /Vencimento: 10 → 12/);
  assert.strictEqual(h[0].who, 'Ana');
});

test('extrato bancário: baixa automática e entrada pendente', async () => {
  const c = (await call('POST', '/clients', { client: { name: 'Dois', cnpj: '22.222.222/0001-22', due: 10, mode: 'now', linhas: [{ linha: 'rastreador', ativos: 20, comodato: 0 }] } })).body;
  const comp = (await call('GET', '/state')).body.competencia;
  await call('POST', '/billing/send', { comp, ids: [c.id] });
  const fd = new FormData();
  fd.append('file', new Blob(['data;valor;pagador\n02/10/2026;100,00;DOIS LTDA\n02/10/2026;55,00;OUTRO\n']), 'ext.csv');
  const r = await (await fetch(base + '/api/bank/import', { method: 'POST', body: fd, headers: { cookie } })).json();
  assert.deepStrictEqual([r.baixados, r.pendentes], [1, 1]);
  const s = (await call('GET', '/state')).body;
  assert.ok(D.isPaid(s.invoices.find(i => i.cid === c.id)));
  assert.strictEqual(s.unmatched.length, 1);
});

test('relatório agendado sai uma vez só', async () => {
  const now = new Date();
  const dia = Math.min(now.getDate(), 28);
  if (now.getDay() === 0 || now.getDay() === 6 || now.getDate() > 28) return; // depende do calendário
  await call('POST', '/reports', { tipo: 'Inadimplência', dias: [dia], hora: '00:00', dest: 'x@y.com', fmt: 'CSV anexo' });
  await scheduler.runReports(now); await scheduler.runReports(now);
  const sent = store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE subject LIKE '%Inadimplência%'").get().n;
  assert.strictEqual(sent, 1);
});
