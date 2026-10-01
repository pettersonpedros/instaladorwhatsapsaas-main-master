/* Integração Asaas com a API simulada (fetch interceptado). Não fala com a Asaas de verdade. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
Object.assign(process.env, {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'yuv-asaas-')), TZ: 'America/Sao_Paulo',
  BILLING_PROVIDER: 'asaas', ASAAS_ENV: 'sandbox', ASAAS_API_KEY: '$aact_teste', ASAAS_NF_SERVICO_ID: '123', ASAAS_WEBHOOK_TOKEN: 'tok-webhook-123'
});
delete process.env.SMTP_URL;

const calls = []; let failNF = false;
const realFetch = global.fetch;
global.fetch = async (url, opt = {}) => {
  if (!String(url).startsWith('https://api-sandbox.asaas.com/v3')) return realFetch(url, opt);
  const p = String(url).slice('https://api-sandbox.asaas.com/v3'.length), body = opt.body ? JSON.parse(opt.body) : null;
  calls.push({ method: opt.method, p, body, headers: opt.headers });
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (p.startsWith('/customers?')) return json({ data: [] });
  if (p === '/customers') return json({ id: 'cus_1' });
  if (p === '/payments') return json({ id: 'pay_' + calls.length, invoiceUrl: 'https://www.asaas.com/i/x' });
  if (p === '/invoices') return failNF ? json({ errors: [{ code: 'x', description: 'Serviço municipal inválido' }] }, 400) : json({ id: 'inv_' + calls.length });
  if (/^\/invoices\/.+\/authorize$/.test(p)) return json({ status: 'SYNCHRONIZED' });
  return json({ errors: [{ description: 'rota não simulada ' + p }] }, 404);
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

test('cobrança na Asaas com multa, juros e desconto; NF ao pagar via webhook', async () => {
  const c = (await call('POST', '/clients', { client: { name: 'Cli', cnpj: '12.345.678/0001-90', due: 10, mode: 'later', email: 'f@c.com', rules: ['multa', 'pontualidade'], linhas: [{ linha: 'streamax', ativos: 10, comodato: 0 }] } })).body;
  const comp = (await call('GET', '/state')).body.competencia;
  const r = (await call('POST', '/billing/send', { comp, ids: [c.id] })).body;
  assert.deepStrictEqual(r.errors, []);

  const pay = calls.find(x => x.p === '/payments');
  assert.strictEqual(pay.headers.access_token, '$aact_teste');
  assert.ok(pay.headers['User-Agent']);
  assert.deepStrictEqual(pay.body.fine, { value: 2, type: 'PERCENTAGE' });
  assert.deepStrictEqual(pay.body.interest, { value: 1 });
  assert.deepStrictEqual(pay.body.discount, { value: 5, dueDateLimitDays: 0, type: 'PERCENTAGE' });
  assert.strictEqual(pay.body.customer, 'cus_1');
  assert.strictEqual(pay.body.value, 300);
  assert.strictEqual(calls.find(x => x.p === '/customers').body.cpfCnpj, '12345678000190');
  assert.ok(!calls.some(x => x.p === '/invoices'), 'modo "só boleto" não emite NF antes do pagamento');

  let s = (await call('GET', '/state')).body;
  const inv = s.invoices[0];
  assert.strictEqual(inv.boletoUrl, 'https://www.asaas.com/i/x');
  assert.strictEqual(s.clients[0].asaasId, 'cus_1');

  assert.strictEqual((await call('POST', '/webhooks/asaas', { event: 'PAYMENT_RECEIVED', payment: { id: inv.boletoRef } }, { 'asaas-access-token': 'errado' })).status, 401);
  const ev = { event: 'PAYMENT_RECEIVED', payment: { id: inv.boletoRef, value: 300, paymentDate: '2026-10-10', externalReference: inv.id } };
  assert.strictEqual((await call('POST', '/webhooks/asaas', ev, { 'asaas-access-token': 'tok-webhook-123' })).status, 200);
  const dup = await call('POST', '/webhooks/asaas', { ...ev, event: 'PAYMENT_CONFIRMED' }, { 'asaas-access-token': 'tok-webhook-123' });
  assert.strictEqual(dup.body.duplicate, true);

  s = (await call('GET', '/state')).body;
  assert.strictEqual(s.invoices[0].pago, 300);
  assert.strictEqual(s.invoices[0].nf, 'emitida_pos');
  const nf = calls.find(x => x.p === '/invoices');
  assert.strictEqual(nf.body.payment, inv.boletoRef);
  assert.strictEqual(nf.body.municipalServiceId, '123');
  assert.ok(calls.some(x => /^\/invoices\/.+\/authorize$/.test(x.p)));

  const unknown = await call('POST', '/webhooks/asaas', { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_x' } }, { 'asaas-access-token': 'tok-webhook-123' });
  assert.strictEqual(unknown.status, 200, 'evento desconhecido não pode travar a fila da Asaas');
});

test('falha na NF fica visível e pode ser refeita', async () => {
  failNF = true;
  const c = (await call('POST', '/clients', { client: { name: 'Dois', cnpj: '22.222.222/0001-22', due: 10, mode: 'now', linhas: [{ linha: 'rastreador', ativos: 10, comodato: 0 }] } })).body;
  const comp = (await call('GET', '/state')).body.competencia;
  const r = (await call('POST', '/billing/send', { comp, ids: [c.id] })).body;
  assert.match(r.errors.join(), /Serviço municipal inválido/);
  let inv = (await call('GET', '/state')).body.invoices.find(i => i.cid === c.id);
  assert.strictEqual(inv.nf, 'erro');
  failNF = false;
  assert.strictEqual((await call("POST", `/invoices/${inv.id}/provider`, {})).status, 200);
  inv = (await call('GET', '/state')).body.invoices.find(i => i.cid === c.id);
  assert.strictEqual(inv.nf, 'emitida');
  assert.ok(inv.nfRef);
});
