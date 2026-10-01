/* Integrações de boleto e nota fiscal.
   Só existe o driver "simulado": gera referências locais e não fala com
   banco nem prefeitura. Para produção, implemente um driver com a mesma
   interface (createCharge / issueNF) para o provedor escolhido e selecione
   por BILLING_PROVIDER. */
const crypto = require('crypto');

const simulado = {
  name: 'simulado',
  async createCharge({ invoice }) {
    const ref = 'SIM-BOL-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    return { ref, url: null, note: `Boleto simulado ${ref} de R$ ${invoice.valor.toFixed(2)} venc. ${invoice.venc}` };
  },
  async issueNF({ invoice }) {
    const ref = 'SIM-NF-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    return { ref, note: `NF simulada ${ref} (${invoice.comp})` };
  }
};

const drivers = { simulado };
const name = process.env.BILLING_PROVIDER || 'simulado';
if (!drivers[name]) throw new Error(`BILLING_PROVIDER "${name}" não implementado. Disponíveis: ${Object.keys(drivers).join(', ')}`);

module.exports = { provider: drivers[name], simulated: name === 'simulado' };
