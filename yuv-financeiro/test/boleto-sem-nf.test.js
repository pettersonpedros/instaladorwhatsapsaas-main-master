/* Asaas só com boleto (NF_AUTOMATICA desligada): nenhuma chamada de NF, controle manual */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'yuv-boleto-')), TZ: 'America/Sao_Paulo',
  BILLING_PROVIDER: 'asaas', ASAAS_ENV: 'sandbox', ASAAS_API_KEY: '$aact_teste', ASAAS_WEBHOOK_TOKEN: 'tok', NF_AUTOMATICA: '0'
});
delete process.env.ASAAS_NF_SERVICO_ID; delete process.env.SMTP_URL;

const calls = []; const realFetch = global.fetch;
global.fetch = async (url, opt = {}) => {
  if (!String(url).startsWith('https://api-sandbox.asaas.com/v3')) return realFetch(url, opt);
  const p = String(url).slice('https://api-sandbox.asaas.com/v3'.length); calls.push(p);
  const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (p.startsWith('/customers?')) return json({ data: [{ id: 'cus_9' }] });
  if (p === '/payments') return json({ id: 'pay_' + calls.length, bankSlipUrl: 'https://x/b.pdf' });
  return new Response('{}', { status: 404 });
};
const { build } = require('../server/app');
const auth = require('../server/auth');
let base, server, cookie = '';
const call = async (method, url, body, headers = {}) => {
  const o = { method, headers: { cookie, ...headers } };
  if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await realFetch(base + '/api' + url, o);
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
};
test.before(async () => {
  auth.createUser({ email: 'a@a.com', name: 'Ana', password: 'senha-forte' });
  server = build().listen(0); await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  await call('POST', '/login', { email: 'a@a.com', password: 'senha-forte' });
});
test.after(() => server.close());

test('sobe sem serviço municipal e cobra só com boleto', async () => {
  assert.strictEqual((await call('GET', '/me')).body.nfAuto, false);
  const mk = (name, cnpj, mode) => call('POST', '/clients', { client: { name, cnpj, due: 10, mode, email: 'f@c.com', linhas: [{ linha: 'streamax', ativos: 10, comodato: 0 }] } });
  const a = (await mk('Agora', '11.111.111/0001-11', 'now')).body, b = (await mk('Depois', '22.222.222/0001-22', 'later')).body;
  const comp = (await call('GET', '/state')).body.competencia;
  const r = (await call('POST', '/billing/send', { comp, ids: [a.id, b.id] })).body;
  assert.deepStrictEqual(r.errors, []);
  assert.ok(!calls.some(p => p.startsWith('/invoices')), 'não pode chamar NF');

  let inv = (await call('GET', '/state')).body.invoices;
  const ia = inv.find(i => i.cid === a.id), ib = inv.find(i => i.cid === b.id);
  assert.strictEqual(ia.nf, 'manual');         // Boleto + NF → NF à mão já
  assert.strictEqual(ib.nf, 'aguardando');     // Só boleto → espera pagamento
  assert.strictEqual(ib.boletoUrl, 'https://x/b.pdf');

  await call('POST', '/webhooks/asaas', { event: 'PAYMENT_RECEIVED', payment: { id: ib.boletoRef, value: 300, paymentDate: '2026-10-10' } }, { 'asaas-access-token': 'tok' });
  inv = (await call('GET', '/state')).body.invoices.find(i => i.id === ib.id);
  assert.strictEqual(inv.pago, 300);
  assert.strictEqual(inv.nf, 'manual');

  const m = await call('POST', `/invoices/${inv.id}/nf-manual`, { numero: '1234' });
  assert.strictEqual(m.body.nf, 'manual_ok');
  const h = (await call('GET', '/state')).body.clients.find(c => c.id === b.id).history;
  assert.match(h[0].what, /NF nº 1234 emitida manualmente/);
});
