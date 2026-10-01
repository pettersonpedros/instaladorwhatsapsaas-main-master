/* Integrações de boleto e nota fiscal.
   - "simulado": gera referências locais (desenvolvimento/treino).
   - "asaas": cria cliente e cobrança na Asaas e emite NFS-e pela Asaas.
   Selecione por BILLING_PROVIDER. */
const crypto = require('crypto');
const D = require('../shared/domain');

const simulado = {
  name: 'simulado',
  async createCharge({ invoice }) {
    const ref = 'SIM-BOL-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    return { ref, url: null };
  },
  async issueNF() {
    return { ref: 'SIM-NF-' + crypto.randomBytes(4).toString('hex').toUpperCase() };
  },
  async cancelCharge() {},
  async getCharge() { return null; }
};

/* ---------------- Asaas (API v3) ---------------- */
function asaasConfig(env = process.env) {
  const sandbox = (env.ASAAS_ENV || 'sandbox') !== 'production';
  const num = (k, d = 0) => { const n = parseFloat(String(env[k] ?? d).replace(',', '.')); return isNaN(n) ? d : n; };
  return {
    nfAuto: env.NF_AUTOMATICA === '1',
    base: (sandbox ? 'https://api-sandbox.asaas.com' : 'https://api.asaas.com') + '/v3',
    sandbox,
    key: env.ASAAS_API_KEY || '',
    billingType: env.ASAAS_BILLING_TYPE || 'BOLETO', // BOLETO, PIX ou UNDEFINED (cliente escolhe)
    notify: env.ASAAS_NOTIFY === '1', // e-mails/SMS da própria Asaas ao cliente (o sistema já manda o seu)
    multa: num('ASAAS_MULTA_PCT', 2), juros: num('ASAAS_JUROS_PCT_MES', 1), pontualidade: num('ASAAS_DESCONTO_PONTUALIDADE_PCT', 5),
    nf: {
      serviceDescription: env.ASAAS_NF_DESCRICAO || 'Licença de uso de plataforma de rastreamento e telemetria',
      municipalServiceId: env.ASAAS_NF_SERVICO_ID || '',
      municipalServiceCode: env.ASAAS_NF_SERVICO_CODIGO || '',
      municipalServiceName: env.ASAAS_NF_SERVICO_NOME || '',
      taxes: { retainIss: env.ASAAS_NF_RETER_ISS === '1', iss: num('ASAAS_NF_ISS'), cofins: num('ASAAS_NF_COFINS'), csll: num('ASAAS_NF_CSLL'), inss: num('ASAAS_NF_INSS'), ir: num('ASAAS_NF_IR'), pis: num('ASAAS_NF_PIS') }
    }
  };
}

function makeAsaas(cfg = asaasConfig(), fetchImpl = (...a) => fetch(...a)) {
  if (!cfg.key) throw new Error('BILLING_PROVIDER=asaas exige ASAAS_API_KEY.');
  if (cfg.nfAuto && !cfg.nf.municipalServiceId && !cfg.nf.municipalServiceCode) throw new Error('NF_AUTOMATICA=1 exige ASAAS_NF_SERVICO_ID ou ASAAS_NF_SERVICO_CODIGO (serviço municipal da NFS-e).');

  async function call(method, path, body) {
    const r = await fetchImpl(cfg.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'yuv-financeiro', access_token: cfg.key },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (data.errors || []).map(e => e.description).join('; ') || (r.status === 401 ? 'chave de API inválida ou de outro ambiente (sandbox × produção)' : `HTTP ${r.status}`);
      throw new Error('Asaas: ' + msg);
    }
    return data;
  }

  async function ensureCustomer(client) {
    if (client.asaasId) return client.asaasId;
    const cnpj = D.onlyDigits(client.cnpj);
    if (cnpj.length !== 14) throw new Error('cliente sem CNPJ válido — a Asaas exige CNPJ');
    const found = await call('GET', `/customers?cpfCnpj=${cnpj}`);
    if (found.data && found.data.length) return found.data[0].id;
    const c = await call('POST', '/customers', {
      name: client.name, cpfCnpj: cnpj, email: (client.email || '').split(/[;,]/)[0].trim() || undefined,
      externalReference: client.id, notificationDisabled: !cfg.notify
    });
    return c.id;
  }

  return {
    name: 'asaas',
    config: cfg,
    async createCharge({ invoice, client }) {
      const customer = await ensureCustomer(client);
      const rules = client.rules || [];
      const body = {
        customer, billingType: cfg.billingType, value: invoice.valor, dueDate: invoice.venc,
        description: `YUV — mensalidade ${D.compLabel(invoice.comp)}`,
        externalReference: invoice.id
      };
      if (rules.includes('multa')) { body.fine = { value: cfg.multa, type: 'PERCENTAGE' }; body.interest = { value: cfg.juros }; }
      if (rules.includes('pontualidade')) body.discount = { value: cfg.pontualidade, dueDateLimitDays: 0, type: 'PERCENTAGE' };
      const p = await call('POST', '/payments', body);
      return { ref: p.id, url: p.invoiceUrl || p.bankSlipUrl || null, customerId: customer };
    },
    async cancelCharge(ref) { await call('DELETE', `/payments/${encodeURIComponent(ref)}`); },
    async getCharge(ref) { return call('GET', `/payments/${encodeURIComponent(ref)}`); },
    async check() { await call('GET', '/customers?limit=1'); return { ok: true, ambiente: cfg.sandbox ? 'sandbox' : 'produção' }; },
    async listWebhooks() { const r = await call('GET', '/webhooks'); return r.data || []; },
    async createWebhook({ url, email, authToken, events }) {
      return call('POST', '/webhooks', { name: 'YUV Financeiro', url, email, enabled: true, interrupted: false, apiVersion: 3, authToken, sendType: 'SEQUENTIALLY', events });
    },
    async issueNF({ invoice }) {
      if (!invoice.boletoRef) throw new Error('cobrança sem boleto na Asaas — não dá para emitir a NF vinculada');
      const n = cfg.nf;
      const body = {
        payment: invoice.boletoRef,
        serviceDescription: n.serviceDescription,
        observations: `Competência ${D.compLabel(invoice.comp)}`,
        value: invoice.valor, deductions: 0, effectiveDate: D.todayISO(),
        externalReference: invoice.id,
        taxes: n.taxes
      };
      if (n.municipalServiceId) body.municipalServiceId = n.municipalServiceId;
      else { body.municipalServiceCode = n.municipalServiceCode; body.municipalServiceName = n.municipalServiceName; }
      const nf = await call('POST', '/invoices', body);
      await call('POST', `/invoices/${nf.id}/authorize`);
      return { ref: nf.id };
    }
  };
}

const name = process.env.BILLING_PROVIDER || 'simulado';
let provider;
if (name === 'simulado') provider = simulado;
else if (name === 'asaas') provider = makeAsaas();
else throw new Error(`BILLING_PROVIDER "${name}" não implementado. Use simulado ou asaas.`);

/* NF_AUTOMATICA=1: emite NFS-e pelo provedor. 0: o sistema só controla quais NFs emitir à mão. */
const nfAuto = process.env.NF_AUTOMATICA === '1';

module.exports = { provider, simulated: name === 'simulado', nfAuto, makeAsaas, asaasConfig };
