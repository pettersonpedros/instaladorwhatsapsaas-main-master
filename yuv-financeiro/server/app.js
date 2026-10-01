const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const D = require('../shared/domain');
const store = require('./db');
const auth = require('./auth');
const svc = require('./services');
const mailer = require('./mailer');
const { simulated, provider, nfAuto } = require('./providers');
const { HttpError } = svc;

const UPLOADS = path.join(store.DATA_DIR, 'anexos');
fs.mkdirSync(UPLOADS, { recursive: true });
const upload = multer({ dest: UPLOADS, limits: { fileSize: 10 * 1024 * 1024 } });
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const bad = m => { throw new HttpError(400, m); };
const who = req => req.user.name;

function sanitizeVersion(d) {
  const linhas = (d.linhas || []).map(l => ({
    id: String(l.id || '').trim() || 'l' + crypto.randomBytes(4).toString('hex'),
    nome: String(l.nome || '').trim(),
    unid: String(l.unid || 'dispositivo'),
    comodatoPreco: D.optNum(l.comodatoPreco),
    faixas: (l.faixas || []).map(f => ({ ate: parseInt(f.ate, 10), preco: D.round2(D.parseNum(f.preco)) }))
  }));
  const v = { faixaBase: d.faixaBase, modo: d.modo, cortesia: Math.max(0, parseInt(d.cortesia, 10) || 0), linhas };
  const e = D.validTableVersion(v); if (e) bad(e);
  return v;
}
const safeEq = (got, secret) => { got = String(got || ''); return !!secret && got.length === secret.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(secret)); };
const csv = (res, name, rows) => { res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send(D.toCSV(rows)); };

function build() {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin'); next(); });
  app.use(express.json({ limit: '5mb' }));
  app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const api = express.Router();
  api.use(auth.requireJson);
  api.post('/login', auth.login);
  api.post('/logout', auth.logout);

  /* Baixa automática vinda do provedor de boleto (protegida por segredo) */
  api.post('/webhooks/payment', async (req, res) => {
    if (!safeEq(req.headers['x-webhook-secret'], process.env.WEBHOOK_SECRET)) return res.status(401).json({ error: 'não autorizado' });
    const { invoiceId, boletoRef, valor, data } = req.body || {};
    const inv = invoiceId ? store.getInvoice(invoiceId) : store.listInvoices().find(i => i.boletoRef && i.boletoRef === boletoRef);
    if (!inv) return res.status(404).json({ error: 'cobrança não encontrada' });
    const r = await svc.applyPayment(inv.id, valor, data, 'webhook', 'provedor', req.body.paymentId || null);
    res.json({ ok: true, duplicate: !!r.duplicate });
  });
  api.post('/webhooks/asaas', async (req, res) => {
    if (!safeEq(req.headers['asaas-access-token'], process.env.ASAAS_WEBHOOK_TOKEN)) return res.status(401).json({ error: 'não autorizado' });
    try { res.json(await svc.asaasWebhook(req.body)); }
    catch (e) { console.error('[asaas webhook]', e.message); res.json({ ignored: e.message }); }
  });

  api.use(auth.requireAuth);
  api.get('/me', (req, res) => res.json({ ...req.user, mail: mailer.enabled ? 'smtp' : 'simulado', provider: simulated ? 'simulado' : provider.name, sandbox: !!(provider.config && provider.config.sandbox), nfAuto }));
  api.get('/state', (req, res) => res.json(store.state()));

  /* ---- clientes ---- */
  api.post('/clients', (req, res) => res.json(svc.createClient(req.body.client || {}, req.user)));
  api.put('/clients/:id', (req, res) => res.json(svc.updateClient(req.params.id, req.body.client || {}, req.body.why, req.user)));
  api.post('/clients/:id/mode', (req, res) => res.json(svc.setMode(req.params.id, req.body.mode, req.user)));
  api.post('/clients/:id/own-table', (req, res) => res.json(svc.ownTable(req.params.id, req.user)));
  api.post('/clients/:id/trial-notice', async (req, res) => res.json(await svc.sendTrialNotice(req.params.id, req.body, who(req))));

  /* ---- tabelas e regras gerais ---- */
  api.put('/config', (req, res) => {
    const b = req.body.cfg || {}, cur = store.state({ history: false }).cfg;
    const g = (k, min, max) => { const n = parseInt(b[k], 10); return isNaN(n) ? cur[k] : Math.min(max, Math.max(min, n)); };
    const cfg = { ...cur, inicio: g('inicio', 1, 28), venc: g('venc', 1, 28), envioDe: g('envioDe', 1, 28), envioAte: g('envioAte', 1, 28), diasMin: g('diasMin', 0, 30), trialDias: g('trialDias', 1, 90) };
    if (b.emailFinanceiro !== undefined) { if (!D.isEmail(b.emailFinanceiro)) bad('E-mail do financeiro inválido.'); cfg.emailFinanceiro = b.emailFinanceiro.trim(); }
    if (b.emailComercial !== undefined) { if (b.emailComercial && !D.isEmail(b.emailComercial)) bad('E-mail do comercial inválido.'); cfg.emailComercial = b.emailComercial.trim(); }
    if (cfg.envioAte < cfg.envioDe) bad('Período de envio inválido.');
    store.setSetting('cfg', cfg); res.json(cfg);
  });
  api.post('/tables/:id/versions', (req, res) => {
    const t = store.getTable(req.params.id); if (!t || !t.padrao) throw new HttpError(404, 'Tabela padrão não encontrada.');
    const nome = String(req.body.nome || '').trim(); if (!nome) bad('Informe o nome da versão.');
    if (t.versoes.some(v => v.v === nome)) bad('Já existe uma versão com esse nome.');
    const v = sanitizeVersion(req.body.versao || {});
    const cur = D.curVer(t);
    if (JSON.stringify(v) === JSON.stringify({ faixaBase: cur.faixaBase, modo: cur.modo, cortesia: cur.cortesia, linhas: cur.linhas })) bad('Nada mudou em relação à versão atual.');
    t.versoes.push({ v: nome, data: D.nowBR(), ...v }); store.saveTable(t); res.json(t);
  });
  api.put('/tables/:id', (req, res) => {
    const t = store.getTable(req.params.id); if (!t || t.padrao) throw new HttpError(404, 'Tabela própria não encontrada.');
    const v = sanitizeVersion(req.body.versao || {});
    const users = store.listClients().filter(c => c.tabela === t.id);
    const missing = users.flatMap(c => c.linhas.filter(l => !v.linhas.some(x => x.id === l.linha)).map(l => `${c.name} usa ${l.linha}`));
    if (missing.length) bad('Há clientes usando linhas removidas: ' + missing.join('; '));
    const last = t.versoes[t.versoes.length - 1];
    t.versoes[t.versoes.length - 1] = { ...last, ...v, data: D.nowBR() };
    store.tx(() => { store.saveTable(t); users.forEach(c => store.addHistory(c.id, `Tabela ${t.nome} alterada`, who(req))); })();
    res.json(t);
  });
  api.post('/tables', (req, res) => {
    const nome = String(req.body.nome || '').trim(); if (!nome) bad('Informe o nome da tabela.');
    const v = sanitizeVersion(req.body.versao || {});
    const t = { id: store.newId('t_'), nome, padrao: false, versoes: [{ v: 'v1', data: D.nowBR(), ...v }] };
    store.saveTable(t); res.json(t);
  });
  api.post('/tables/:id/migrate', (req, res) => {
    const t = store.getTable(req.params.id); if (!t || !t.padrao) throw new HttpError(404, 'Tabela padrão não encontrada.');
    const to = D.curVer(t).v, from = req.body.from;
    const list = store.listClients().filter(c => c.tabela === t.id && c.versao === from);
    store.tx(() => list.forEach(c => { store.addHistory(c.id, `Migrado de ${c.versao} para ${to}`, who(req), 'Reajuste de tabela'); c.versao = to; store.saveClient(c); }))();
    res.json({ migrated: list.length });
  });

  /* ---- importação de planilha ---- */
  api.post('/import/preview', (req, res) => res.json(D.diffRows(store.state({ history: false }), req.body.rows || [])));
  api.post('/import/apply', (req, res) => res.json({ imported: svc.applyImport(req.body.rows || [], req.body.decisions || {}, String(req.body.file || 'planilha'), who(req)) }));

  /* ---- cobrança ---- */
  api.post('/billing/send', async (req, res) => res.json(await svc.sendBilling(req.body.comp, req.body.ids, req.user)));
  api.post('/billing/next', (req, res) => {
    const S = store.state({ history: false });
    if (!S.sentComp.includes(S.competencia)) bad('Envie as cobranças da competência atual antes de abrir a próxima.');
    store.setSetting('competencia', D.nextComp(S.competencia)); res.json({ competencia: D.nextComp(S.competencia) });
  });
  api.get('/billing/prefatura.csv', (req, res) => {
    const S = store.state({ history: false }), comp = S.competencia;
    csv(res, `pre-fatura_${comp}.csv`, [['cliente', 'cnpj', 'tabela', 'item', 'tipo', 'quantidade', 'valor_unit', 'valor', 'situacao'],
      ...S.clients.flatMap(c => { const k = D.calc(S, c), st = D.billState(S, c, comp); return k.items.map(x => [c.name, c.cnpj, k.tabela + ' ' + k.versao, x.nome, x.tipo === 'com' ? 'Comodato' : 'Licença', x.qtd, D.nf2(x.unit), D.nf2(x.valor), st.skip || st.blocked ? st.txt : 'Pronto']); })]);
  });

  /* ---- conciliação ---- */
  api.post('/invoices/:id/payments', async (req, res) => res.json(await svc.applyPayment(req.params.id, req.body.valor, req.body.data, 'manual', who(req))));
  api.post('/invoices/:id/nf-manual', (req, res) => res.json(svc.markNfManual(req.params.id, req.body.numero, who(req))));
  api.post('/invoices/:id/provider', async (req, res) => res.json(await svc.retryProvider(req.params.id)));
  api.post('/invoices/:id/reminder', async (req, res) => res.json(await svc.sendReminder(req.params.id, who(req))));
  api.post('/bank/import', memUpload.single('file'), async (req, res) => {
    if (!req.file) bad('Envie o arquivo do extrato (.ofx ou .csv).');
    let text = req.file.buffer.toString('utf8');
    if (text.includes('\uFFFD')) text = req.file.buffer.toString('latin1'); // OFX de banco costuma vir em latin1
    res.json(await svc.importStatement(text, req.file.originalname, who(req)));
  });
  api.post('/bank/:id/link', async (req, res) => res.json(await svc.linkBankEntry(req.params.id, req.body.cid, who(req))));
  api.post('/bank/:id/ignore', (req, res) => { store.db.prepare("UPDATE bank_entries SET status='descartado' WHERE id=? AND status='pendente'").run(req.params.id); res.json({ ok: true }); });

  /* ---- contas a pagar ---- */
  api.post('/payables', upload.single('anexo'), (req, res) => { svc.addPayable(req.body, req.file); res.json({ ok: true }); });
  api.post('/payables/:id/pay', (req, res) => { svc.payPayable(req.params.id); res.json({ ok: true }); });
  api.delete('/payables/:id', (req, res) => {
    const p = store.db.prepare('SELECT anexo FROM payables WHERE id=?').get(req.params.id);
    store.db.prepare('DELETE FROM payables WHERE id=?').run(req.params.id);
    if (p && p.anexo) fs.rm(path.join(UPLOADS, path.basename(p.anexo)), () => {});
    res.json({ ok: true });
  });
  api.get('/payables/:id/anexo', (req, res) => {
    const p = store.db.prepare('SELECT anexo, anexo_nome FROM payables WHERE id=?').get(req.params.id);
    if (!p || !p.anexo) throw new HttpError(404, 'Sem anexo.');
    res.download(path.join(UPLOADS, path.basename(p.anexo)), p.anexo_nome || 'anexo');
  });

  /* ---- relatórios ---- */
  api.post('/reports', (req, res) => {
    const b = req.body, dias = [...new Set((b.dias || []).map(Number).filter(d => d >= 1 && d <= 28))].sort((a, c) => a - c);
    if (!D.REPORT_TYPES.includes(b.tipo)) bad('Tipo de relatório inválido.');
    if (!dias.length) bad('Escolha pelo menos um dia.');
    if (!/^\d{2}:\d{2}$/.test(b.hora || '')) bad('Horário inválido.');
    const dest = String(b.dest || '').split(/[;,]/).map(x => x.trim()).filter(Boolean);
    if (!dest.length || !dest.every(D.isEmail)) bad('Informe e-mails completos dos destinatários, separados por vírgula.');
    const fmt = ['CSV anexo', 'E-mail'].includes(b.fmt) ? b.fmt : 'CSV anexo';
    store.db.prepare('INSERT INTO reports(id,tipo,dias,hora,dest,fmt) VALUES(?,?,?,?,?,?)').run(store.newId('r'), b.tipo, JSON.stringify(dias), b.hora, dest.join(', '), fmt);
    res.json({ ok: true });
  });
  api.patch('/reports/:id', (req, res) => { store.db.prepare('UPDATE reports SET ativo=? WHERE id=?').run(req.body.on ? 1 : 0, req.params.id); res.json({ ok: true }); });
  api.delete('/reports/:id', (req, res) => { store.db.prepare('DELETE FROM reports WHERE id=?').run(req.params.id); res.json({ ok: true }); });
  api.get('/reports/generate', (req, res) => {
    const tipo = String(req.query.tipo || ''); if (!D.REPORT_TYPES.includes(tipo)) bad('Tipo de relatório inválido.');
    csv(res, `relatorio_${D.slug(tipo)}.csv`, D.reportRows(store.state({ history: false }), tipo));
  });

  /* ---- painel e caixa de saída ---- */
  api.put('/widgets', (req, res) => { const w = {}; Object.keys(req.body.widgets || {}).filter(k => /^w\d$/.test(k)).forEach(k => { w[k] = !!req.body.widgets[k]; }); store.setSetting('widgets', w); res.json(w); });
  api.get('/outbox', (req, res) => res.json(store.db.prepare('SELECT id,to_addr,subject,body,attachments,status,error,created_at FROM outbox ORDER BY id DESC LIMIT 200').all()));

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || (err.type === 'entity.parse.failed' || err instanceof multer.MulterError ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Erro interno. Tente de novo.' : err.message });
  });
  return app;
}

module.exports = { build };
