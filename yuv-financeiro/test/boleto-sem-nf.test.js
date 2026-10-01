/* Asaas só com boleto (NF_AUTOMATICA desligada): nenhuma chamada de NF, controle manual */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'yuv-boleto-')), TZ: 'America/Sao_Paulo',
  BILLING_PROVIDER: 'asaas', APP_URL: 'https://fin.exemplo.com', ASAAS_ENV: 'sandbox', ASAAS_API_KEY: '$aact_teste', ASAAS_WEBHOOK_TOKEN: 'tok', NF_AUTOMATICA: '0'
});
delete process.env.ASAAS_NF_SERVICO_ID; delete process.env.SMTP_URL;

const calls = []; const realFetch = global.fetch; const paidIds = new Set(); const hooks = []; let webhookBody = null;
global.fetch = async (url, opt = {}) => {
  if (!String(url).startsWith('https://api-sandbox.asaas.com/v3')) return realFetch(url, opt);
  const p = String(url).slice('https://api-sandbox.asaas.com/v3'.length); calls.push(p);
  const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (p.startsWith('/customers?')) return json({ data: [{ id: 'cus_9' }] });
  if (p === '/payments') return json({ id: 'pay_' + calls.length, bankSlipUrl: 'https://x/b.pdf' });
  if (opt.method === 'DELETE' && p.startsWith('/payments/')) return json({ deleted: true });
  if (opt.method === 'GET' && p.startsWith('/payments/')) { const id = p.split('/')[2]; return json({ id, status: paidIds.has(id) ? 'RECEIVED' : 'PENDING', value: 300, paymentDate: '2026-10-12' }); }
  if (p === '/webhooks' && opt.method === 'GET') return json({ data: hooks });
  if (p === '/webhooks') { hooks.push(JSON.parse(opt.body)); webhookBody = JSON.parse(opt.body); return json({ id: 'wh_1' }); }
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

test('cancelar cobrança cancela o boleto na Asaas e libera reenviar', async () => {
  const c = (await call('POST', '/clients', { client: { name: 'Tres', cnpj: '33.333.333/0001-33', due: 10, mode: 'later', email: 'f@c.com', linhas: [{ linha: 'streamax', ativos: 10, comodato: 0 }], ajustes: [{ desc: 'Instalação', valor: 50 }] } })).body;
  const comp = (await call('GET', '/state')).body.competencia;
  await call('POST', '/billing/send', { comp, ids: [c.id] });
  const inv = (await call('GET', '/state')).body.invoices.find(i => i.cid === c.id);
  assert.strictEqual(inv.valor, 350);
  assert.strictEqual((await call('POST', `/invoices/${inv.id}/cancel`, { why: '' })).status, 400);
  assert.strictEqual((await call('POST', `/invoices/${inv.id}/cancel`, { why: 'quantidade errada' })).status, 200);
  assert.ok(calls.includes('/payments/' + inv.boletoRef));
  const s = (await call('GET', '/state')).body;
  assert.ok(!s.invoices.some(i => i.id === inv.id));
  assert.deepStrictEqual(s.clients.find(x => x.id === c.id).ajustes, [{ desc: 'Instalação', valor: 50 }]);
  assert.strictEqual((await call('POST', '/billing/send', { comp, ids: [c.id] })).body.created, 1);
});

test('conferência pega pagamento sem webhook, sem duplicar', async () => {
  const s = (await call('GET', '/state')).body;
  const inv = s.invoices.find(i => !i.pago);
  paidIds.add(inv.boletoRef);
  const r1 = (await call('POST', '/provider/sync', {})).body;
  assert.strictEqual(r1.baixadas, 1);
  const r2 = (await call('POST', '/provider/sync', {})).body;
  assert.strictEqual(r2.baixadas, 0);
  assert.strictEqual((await call('GET', '/state')).body.invoices.find(i => i.id === inv.id).pago, 300);
});

test('webhook cadastrado com campos obrigatórios e só eventos de cobrança', async () => {
  let ck = (await call('GET', '/provider/check')).body;
  assert.strictEqual(ck.ok, true); assert.strictEqual(ck.webhook, null);
  const r = await call('POST', '/provider/webhook', {});
  assert.strictEqual(r.status, 400); // token curto demais
  process.env.ASAAS_WEBHOOK_TOKEN = 'x'.repeat(40);
  assert.strictEqual((await call('POST', '/provider/webhook', {})).status, 200);
  assert.strictEqual(webhookBody.url, 'https://fin.exemplo.com/api/webhooks/asaas');
  for (const k of ['name', 'sendType', 'apiVersion', 'events', 'authToken']) assert.ok(webhookBody[k], k);
  assert.ok(!webhookBody.events.some(e => e.startsWith('INVOICE_')));
  assert.strictEqual((await call('POST', '/provider/webhook', {})).body.existente, true);
});
