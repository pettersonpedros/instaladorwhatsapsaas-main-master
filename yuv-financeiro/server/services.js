/* Ações de negócio. Toda regra que mexe em dinheiro roda aqui, no servidor,
   recalculando a partir do banco — nunca confiando em valor vindo da tela. */
const crypto = require('crypto');
const D = require('../shared/domain');
const store = require('./db');
const mailer = require('./mailer');
const { provider, nfAuto } = require('./providers');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => { throw new HttpError(400, msg); };
const pad2 = n => String(n).padStart(2, '0');
const isISO = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const int = (v, min, max, def) => { const n = parseInt(v, 10); if (isNaN(n)) return def; return Math.min(max, Math.max(min, n)); };
const numOrNull = v => { const n = D.optNum(v); if (n === null) return null; if (!(n >= 0)) bad('Valores não podem ser negativos.'); return D.round2(n); };
const devicesOf = c => (c.linhas || []).reduce((s, l) => s + (+l.ativos || 0), 0);

/* ---------- clientes ---------- */
function sanitizeClient(input, existing, S) {
  const c = {};
  c.id = existing ? existing.id : store.newId('c');
  c.name = String(input.name || '').trim(); if (!c.name) bad('Informe o nome do cliente.');
  c.cnpj = String(input.cnpj || '').trim();
  if (c.cnpj && D.onlyDigits(c.cnpj).length !== 14) bad('CNPJ precisa ter 14 dígitos.');
  if (c.cnpj && S.clients.some(x => x.id !== c.id && D.onlyDigits(x.cnpj) === D.onlyDigits(c.cnpj))) bad('Já existe um cliente com esse CNPJ.');
  c.canal = ['Direto', 'Integrador'].includes(input.canal) ? input.canal : 'Direto';
  c.status = ['ativo', 'teste', 'encerrado'].includes(input.status) ? input.status : 'ativo';
  const t = D.tableById(S, input.tabela) || D.tableById(S, 'padrao');
  c.tabela = t.id;
  c.versao = t.versoes.some(v => v.v === input.versao) ? input.versao : D.curVer(t).v;
  c.indicado = !!input.indicado;
  c.diasMin = int(input.diasMin, 0, 30, S.cfg.diasMin);
  c.due = parseInt(input.due, 10); if (!(c.due >= 1 && c.due <= 28)) bad('Dia de vencimento deve ser de 1 a 28.');
  c.mode = input.mode === 'now' ? 'now' : 'later';
  c.email = String(input.email || '').trim();
  if (c.email && !c.email.split(/[;,]/).every(e => D.isEmail(e))) bad('E-mail financeiro inválido.');
  c.rules = (input.rules || []).filter(r => D.RULES[r]);
  c.ajustes = (input.ajustes || []).map(a => {
    const valor = D.parseNum(a.valor), desc = String(a.desc || '').trim();
    if (!desc || isNaN(valor)) bad('Ajuste precisa de descrição e valor.');
    return { desc, valor: D.round2(valor) };
  });
  c.bloqueio = String(input.bloqueio || '').trim();
  c.linhas = (input.linhas || []).map(l => {
    const ativos = int(l.ativos, 0, 1e7, 0), comodato = int(l.comodato, 0, 1e7, 0);
    if (comodato > ativos) bad('Comodato não pode ser maior que os ativos da linha.');
    if (!String(l.linha || '')) bad('Linha de equipamento vazia.');
    return { linha: String(l.linha), ativos, comodato, comodatoPreco: numOrNull(l.comodatoPreco), precoManual: numOrNull(l.precoManual), poucoUso: int(l.poucoUso, 0, ativos, 0) };
  });
  if (!c.linhas.length) bad('Inclua pelo menos uma linha de equipamento.');
  const ids = c.linhas.map(l => l.linha); if (new Set(ids).size !== ids.length) bad('A mesma linha de equipamento aparece duas vezes.');
  c.trial = null;
  if (input.trial || c.status === 'teste') {
    const it = input.trial || {}, prev = existing && existing.trial;
    const inicio = isISO(it.inicio) ? it.inicio : D.todayISO();
    const fim = isISO(it.fim) ? it.fim : D.addDays(inicio, S.cfg.trialDias);
    if (fim < inicio) bad('Confira as datas do teste.');
    const email = String(it.email || c.email || '').trim();
    if (c.status === 'teste' && !D.isEmail(email)) bad('Informe o e-mail que recebe o aviso de fim do teste.');
    c.trial = {
      inicio, fim, email,
      avisos: [...new Set((it.avisos || S.cfg.avisos).map(Number).filter(d => d >= 1 && d <= 60))],
      aoFim: it.aoFim === 'cobrar' ? 'cobrar' : 'suspender',
      enviados: prev && prev.fim === fim ? prev.enviados || [] : []
    };
  }
  // id do cliente na Asaas: mantém, a menos que o CNPJ mude
  c.asaasId = existing && D.onlyDigits(existing.cnpj) === D.onlyDigits(c.cnpj) ? existing.asaasId || null : null;
  c.delta = existing ? (existing.delta || 0) + devicesOf(c) - devicesOf(existing) : devicesOf(c);
  return c;
}

/* Descreve em texto o que mudou — vira o histórico/auditoria do cliente */
function diffClient(S, a, b) {
  const out = [];
  const lab = { status: 'Situação', canal: 'Canal', due: 'Vencimento', diasMin: 'Mín. dias ativos', email: 'E-mail financeiro', bloqueio: 'Bloqueio', name: 'Nome', cnpj: 'CNPJ' };
  Object.keys(lab).forEach(k => { if (String(a[k] ?? '') !== String(b[k] ?? '')) out.push(`${lab[k]}: ${a[k] || '—'} → ${b[k] || '—'}`); });
  if (a.indicado !== b.indicado) out.push(b.indicado ? 'Marcado como indicado por parceiro' : 'Desmarcado como indicado');
  if (a.mode !== b.mode) out.push(`Modo de faturamento → ${b.mode === 'now' ? 'Boleto + NF' : 'Só boleto'}`);
  if (a.tabela !== b.tabela || a.versao !== b.versao) out.push(`Tabela: ${(D.tableById(S, a.tabela) || {}).nome || a.tabela} ${a.versao} → ${(D.tableById(S, b.tabela) || {}).nome || b.tabela} ${b.versao}`);
  if (JSON.stringify([...a.rules].sort()) !== JSON.stringify([...b.rules].sort())) out.push(`Regras: ${b.rules.map(r => D.RULES[r].t).join(', ') || 'nenhuma'}`);
  const nm = id => D.allLineDefs(S).get(id) || id;
  const la = new Map(a.linhas.map(l => [l.linha, l])), lb = new Map(b.linhas.map(l => [l.linha, l]));
  lb.forEach((l, id) => {
    const o = la.get(id);
    if (!o) { out.push(`${nm(id)}: linha adicionada (${l.ativos} ativos, ${l.comodato} comodato)`); return; }
    const ch = [];
    if (o.ativos !== l.ativos) ch.push(`ativos ${o.ativos} → ${l.ativos}`);
    if (o.comodato !== l.comodato) ch.push(`comodato ${o.comodato} → ${l.comodato}`);
    if ((o.poucoUso || 0) !== (l.poucoUso || 0)) ch.push(`abaixo do mínimo ${o.poucoUso || 0} → ${l.poucoUso || 0}`);
    if (o.precoManual !== l.precoManual) ch.push(`licença ${o.precoManual != null ? D.brl(o.precoManual) : 'tabela'} → ${l.precoManual != null ? D.brl(l.precoManual) : 'tabela'}`);
    if (o.comodatoPreco !== l.comodatoPreco) ch.push(`comodato R$ ${o.comodatoPreco != null ? D.nf2(o.comodatoPreco) : 'tabela'} → ${l.comodatoPreco != null ? D.nf2(l.comodatoPreco) : 'tabela'}`);
    if (ch.length) out.push(`${nm(id)}: ${ch.join(', ')}`);
  });
  la.forEach((l, id) => { if (!lb.has(id)) out.push(`${nm(id)}: linha removida`); });
  const aj = x => JSON.stringify(x.ajustes);
  if (aj(a) !== aj(b)) out.push(`Ajustes: ${b.ajustes.map(x => `${x.desc} (${D.brl(x.valor)})`).join('; ') || 'nenhum'}`);
  const ta = a.trial, tb = b.trial;
  if (JSON.stringify(ta && { ...ta, enviados: 0 }) !== JSON.stringify(tb && { ...tb, enviados: 0 }))
    out.push(tb ? `Teste: ${D.dBR(tb.inicio)} a ${D.dBR(tb.fim)}, avisos ${tb.avisos.join('/')} dias, ao fim ${tb.aoFim === 'cobrar' ? 'cobra' : 'suspende'}` : 'Teste removido');
  return out;
}

function createClient(input, user) {
  const S = store.state({ history: false });
  const c = sanitizeClient(input, null, S);
  store.tx(() => {
    store.saveClient(c);
    store.addHistory(c.id, c.status === 'teste' ? `Teste gratuito iniciado (${D.dBR(c.trial.inicio)} a ${D.dBR(c.trial.fim)})` : 'Cliente cadastrado: ' + D.describe(S, c), user.name, input.why || '');
  })();
  return c;
}
function updateClient(id, input, why, user) {
  const S = store.state({ history: false });
  const old = store.getClient(id); if (!old) throw new HttpError(404, 'Cliente não encontrado.');
  if (!String(why || '').trim()) bad('Escreva o motivo da alteração antes de salvar.');
  const c = sanitizeClient(input, old, S);
  const changes = diffClient(S, old, c);
  store.tx(() => {
    store.saveClient(c);
    store.addHistory(id, changes.length ? changes.join(' · ') : 'Salvo sem alterações', user.name, why);
  })();
  return c;
}
function setMode(id, mode, user) {
  const c = store.getClient(id); if (!c) throw new HttpError(404, 'Cliente não encontrado.');
  if (!['now', 'later'].includes(mode)) bad('Modo inválido.');
  if (c.mode === mode) return c;
  c.mode = mode; store.saveClient(c);
  store.addHistory(id, `Modo de faturamento → ${mode === 'now' ? 'Boleto + NF' : 'Só boleto'}`, user.name, 'Alterado na lista');
  return c;
}
function ownTable(id, user) {
  const S = store.state({ history: false });
  const c = store.getClient(id); if (!c) throw new HttpError(404, 'Cliente não encontrado.');
  const { t, v } = D.tableVer(S, c);
  const nt = { id: store.newId('t_'), nome: 'Personalizada — ' + c.name, padrao: false, versoes: [Object.assign(D.clone(v), { v: 'v1', data: D.nowBR() })] };
  store.tx(() => {
    store.saveTable(nt); c.tabela = nt.id; c.versao = 'v1'; store.saveClient(c);
    store.addHistory(id, `Tabela própria criada a partir de ${t.nome} ${v.v}`, user.name);
  })();
  return nt;
}

/* ---------- aviso de fim de teste ---------- */
async function sendTrialNotice(id, { d, to, subject, body }, who) {
  const S = store.state({ history: false });
  const c = store.getClient(id); if (!c || !c.trial) throw new HttpError(404, 'Cliente sem teste.');
  to = String(to || c.trial.email).trim(); if (!D.isEmail(to)) bad('Informe um e-mail válido.');
  const m = D.trialMail(S, c, d);
  const r = await mailer.send({ to, subject: subject || m.assunto, text: body || m.corpo });
  if (!r.ok) throw new HttpError(502, 'Falha ao enviar e-mail: ' + r.error);
  const cur = store.getClient(id);
  cur.trial.email = to;
  cur.trial.enviados = (cur.trial.enviados || []).filter(x => x.d !== d).concat({ d: +d || 0, em: D.todayISO() });
  store.saveClient(cur);
  store.addHistory(id, `Aviso de fim de teste${d ? ` (${d} dias)` : ''} enviado para ${to}${r.simulated ? ' (simulado)' : ''}`, who);
  return r;
}

/* ---------- cobrança mensal ---------- */
function chargeMail(S, c, inv, k, P) {
  const linhas = k.items.map(x => `  ${x.nome} — ${x.tipo === 'com' ? 'comodato' : 'licença'}: ${x.qtd} × ${D.brl(x.unit)} = ${D.brl(x.valor)}`).join('\n');
  const aj = (c.ajustes || []).map(a => `  ${a.desc}: ${D.brl(a.valor)}`).join('\n');
  return {
    subject: `YUV — cobrança ${D.compLabel(inv.comp)} · vencimento ${D.dBR(inv.venc)}`,
    text: `Olá, equipe ${c.name}.\n\nSegue a cobrança da competência ${D.compLabel(inv.comp)} (apuração de ${D.dBR(P.ini)} a ${D.dBR(P.fim)}).\n\nDispositivos ativos: ${k.devices}${k.com ? ` (${k.com} em comodato)` : ''}${k.pouco ? `\nAbaixo de ${c.diasMin} dias ativos, sem cobrança: ${k.pouco}` : ''}${k.free ? `\nCortesia: ${k.free}` : ''}\n\n${linhas}${aj ? '\n\nAjustes:\n' + aj : ''}\n\nTotal: ${D.brl(inv.valor)}\nVencimento: ${D.dBR(inv.venc)}${inv.boletoRef ? `\nBoleto: ${inv.boletoUrl || inv.boletoRef}` : ''}\n${!nfAuto ? (inv.mode === 'now' ? 'A nota fiscal será enviada separadamente.' : 'A nota fiscal será enviada após a confirmação do pagamento.') : inv.mode === 'now' ? `Nota fiscal: ${inv.nfRef || 'emitida junto com esta cobrança'}` : 'A nota fiscal será emitida após a confirmação do pagamento.'}\n\nDúvidas: ${S.cfg.emailFinanceiro}\n\nEquipe YUV`
  };
}
async function sendBilling(comp, ids, user) {
  const S = store.state({ history: false });
  if (comp !== S.competencia) bad('Competência diferente da que está aberta.');
  if (!Array.isArray(ids) || !ids.length) bad('Selecione pelo menos uma cobrança.');
  const P = D.periodo(S.cfg, comp);
  const created = [], errors = [];
  for (const id of ids) {
    const c = S.clients.find(x => x.id === id);
    if (!c) { errors.push(`${id}: cliente não encontrado`); continue; }
    const st = D.billState(S, c, comp);
    if (st.skip || st.blocked) { errors.push(`${c.name}: ${st.txt}`); continue; }
    const k = D.calc(S, c);
    const items = k.items.concat((c.ajustes || []).map(a => ({ tipo: 'aj', nome: a.desc, qtd: 1, unit: a.valor, valor: a.valor })));
    const inv = { id: store.newId('i'), cid: c.id, comp, valor: k.total, venc: `${P.vencMes}-${pad2(c.due)}`, mode: c.mode, pago: 0, nf: D.nfState(c.mode, k.total, 0), items, createdBy: user.name };
    try {
      store.tx(() => {
        store.insertInvoice(inv);
        const cur = store.getClient(c.id);
        if (cur.ajustes.length) store.addHistory(c.id, 'Ajustes cobrados em ' + D.compLabel(comp), user.name);
        cur.ajustes = []; cur.delta = 0;
        if (cur.status === 'teste' && cur.trial && cur.trial.aoFim === 'cobrar') { cur.status = 'ativo'; store.addHistory(c.id, 'Teste encerrado — cobrança iniciada automaticamente', user.name); }
        store.saveClient(cur);
        store.addHistory(c.id, `Cobrança ${D.compLabel(comp)} emitida: ${D.brl(inv.valor)}, venc. ${D.dBR(inv.venc)}`, user.name);
      })();
    } catch (e) {
      errors.push(`${c.name}: ${/UNIQUE/.test(e.message) ? 'cobrança desta competência já existe' : e.message}`); continue;
    }
    // integrações fora da transação: a cobrança já está registrada e não duplica
    const perr = await syncProvider(inv);
    perr.forEach(e => errors.push(`${c.name}: ${e}`));
    if (!inv.boletoRef) errors.push(`${c.name}: e-mail não enviado porque o boleto não foi gerado — use "Gerar boleto/NF" na Conciliação`);
    else if (c.email) await sendChargeMail(inv, errors);
    else errors.push(`${c.name}: sem e-mail financeiro — cobrança registrada, envie manualmente`);
    created.push(inv);
  }
  if (created.length) { const sent = store.getSetting('sentComp', []); if (!sent.includes(comp)) store.setSetting('sentComp', sent.concat(comp)); }
  return { created: created.length, total: D.round2(created.reduce((s, i) => s + i.valor, 0)), nfNow: created.filter(i => i.mode === 'now').length, errors };
}

/* Gera o que falta no provedor (boleto e, quando cabe, a NF). Devolve a lista de erros. */
async function syncProvider(inv) {
  const errs = [];
  const c = store.getClient(inv.cid);
  if (!inv.boletoRef) {
    try {
      const b = await provider.createCharge({ invoice: inv, client: c });
      inv.boletoRef = b.ref; inv.boletoUrl = b.url; store.updateInvoice(inv);
      if (b.customerId && b.customerId !== c.asaasId) { c.asaasId = b.customerId; store.saveClient(c); }
    } catch (e) { errs.push('falha ao gerar boleto: ' + e.message); store.addHistory(inv.cid, `Falha ao gerar boleto (${D.compLabel(inv.comp)}): ${e.message}`, 'sistema'); return errs; }
  }
  const needNF = inv.mode === 'now' || D.isPaid(inv);
  if (needNF && !inv.nfRef && !nfAuto) {
    if (inv.nf !== 'manual') { inv.nf = 'manual'; store.updateInvoice(inv); }
    return errs;
  }
  if (needNF && !inv.nfRef) {
    try {
      const n = await provider.issueNF({ invoice: inv, client: c });
      inv.nfRef = n.ref; inv.nf = inv.mode === 'now' ? 'emitida' : 'emitida_pos'; store.updateInvoice(inv);
      if (inv.mode === 'later') store.addHistory(inv.cid, `NF emitida após pagamento (${n.ref})`, 'sistema');
    } catch (e) { inv.nf = 'erro'; store.updateInvoice(inv); errs.push('falha ao emitir NF: ' + e.message); store.addHistory(inv.cid, `Falha ao emitir NF (${D.compLabel(inv.comp)}): ${e.message}`, 'sistema'); }
  }
  return errs;
}
async function sendChargeMail(inv, errors) {
  const S = store.state({ history: false });
  const c = S.clients.find(x => x.id === inv.cid);
  if (!c.email) return;
  const k = { ...D.calc(S, c), items: inv.items.filter(x => x.tipo !== 'aj') };
  const m = chargeMail(S, { ...c, ajustes: inv.items.filter(x => x.tipo === 'aj').map(x => ({ desc: x.nome, valor: x.valor })) }, inv, k, D.periodo(S.cfg, inv.comp));
  const r = await mailer.send({ to: c.email, subject: m.subject, text: m.text });
  if (!r.ok && errors) errors.push(`${c.name}: e-mail não enviado (${r.error})`);
}
/* Botão "Gerar boleto/NF": refaz o que falhou no provedor */
async function retryProvider(invId) {
  const inv = store.getInvoice(invId); if (!inv) throw new HttpError(404, 'Cobrança não encontrada.');
  const hadBoleto = !!inv.boletoRef;
  const errs = await syncProvider(inv);
  if (errs.length) throw new HttpError(502, errs.join('; '));
  if (!hadBoleto) await sendChargeMail(inv);
  return inv;
}

/* NF emitida fora do sistema (enquanto a NF automática estiver desligada) */
function markNfManual(invId, numero, user) {
  const inv = store.getInvoice(invId); if (!inv) throw new HttpError(404, 'Cobrança não encontrada.');
  if (inv.nf !== 'manual') bad('Esta cobrança não está aguardando NF manual.');
  numero = String(numero || '').trim();
  inv.nf = 'manual_ok'; inv.nfRef = 'manual:' + (numero || '-'); store.updateInvoice(inv);
  store.addHistory(inv.cid, `NF ${numero ? 'nº ' + numero + ' ' : ''}emitida manualmente (${D.compLabel(inv.comp)})`, user);
  return inv;
}

/* ---------- pagamentos ---------- */
async function applyPayment(invId, valor, data, origem, user, ref) {
  valor = D.round2(D.parseNum(valor)); if (!(valor > 0)) bad('Informe um valor maior que zero.');
  if (!isISO(data)) data = D.todayISO();
  let inv;
  store.tx(() => {
    inv = store.getInvoice(invId); if (!inv) throw new HttpError(404, 'Cobrança não encontrada.');
    if (ref && store.db.prepare('SELECT 1 FROM payments WHERE ref=?').get(ref)) { inv.duplicate = true; return; }
    store.db.prepare('INSERT INTO payments(invoice_id,valor,data,origem,ref,created_by) VALUES(?,?,?,?,?,?)').run(invId, valor, data, origem, ref || null, user);
    inv.pago = D.round2(inv.pago + valor); inv.pagoEm = data;
    if (inv.mode === 'later' && !['emitida_pos', 'erro', 'manual', 'manual_ok'].includes(inv.nf)) inv.nf = D.nfState('later', inv.valor, inv.pago);
    store.updateInvoice(inv);
    store.addHistory(inv.cid, `Pagamento ${D.brl(valor)} em ${D.dBR(data)} (${origem}) — ${D.compLabel(inv.comp)}`, user);
  })();
  if (inv.duplicate) return inv;
  if (inv.mode === 'later' && D.isPaid(inv) && !inv.nfRef && inv.nf !== 'manual_ok') await syncProvider(inv);
  return inv;
}
async function sendReminder(invId, user) {
  const S = store.state({ history: false });
  const inv = store.getInvoice(invId); if (!inv) throw new HttpError(404, 'Cobrança não encontrada.');
  const c = store.getClient(inv.cid);
  if (!c.email) bad('Cliente sem e-mail financeiro cadastrado.');
  const falta = inv.valor - inv.pago;
  const r = await mailer.send({ to: c.email, subject: `YUV — lembrete de pagamento ${D.compLabel(inv.comp)}`, text: `Olá, equipe ${c.name}.\n\nNão identificamos o pagamento integral da cobrança de ${D.compLabel(inv.comp)}, vencida em ${D.dBR(inv.venc)}.\nValor em aberto: ${D.brl(falta)}${inv.boletoRef ? `\nBoleto: ${inv.boletoUrl || inv.boletoRef}` : ''}\n\nSe já pagou, desconsidere ou responda com o comprovante.\n\nDúvidas: ${S.cfg.emailFinanceiro}\n\nEquipe YUV` });
  if (!r.ok) throw new HttpError(502, 'Falha ao enviar e-mail: ' + r.error);
  store.addHistory(c.id, `Lembrete de pagamento enviado (${D.compLabel(inv.comp)})${r.simulated ? ' (simulado)' : ''}`, user);
  return r;
}

/* ---------- webhook da Asaas ----------
   Sempre responde 200 para eventos que não interessam ou não acham a cobrança:
   a Asaas pausa a fila de webhooks quando o endpoint devolve erro. */
async function asaasWebhook(body) {
  const ev = body && body.event;
  if (ev === 'PAYMENT_RECEIVED' || ev === 'PAYMENT_CONFIRMED') {
    const p = body.payment || {};
    const inv = (p.id && store.db.prepare('SELECT id FROM invoices WHERE boleto_ref=?').get(p.id)) || (p.externalReference && store.getInvoice(p.externalReference));
    if (!inv) return { ignored: 'cobrança não encontrada' };
    const data = p.clientPaymentDate || p.paymentDate || D.todayISO();
    const r = await applyPayment(inv.id, p.value, data, 'Asaas', 'Asaas', 'asaas:' + p.id);
    return { ok: true, duplicate: !!r.duplicate };
  }
  if (/^PAYMENT_(DELETED|REFUNDED|PARTIALLY_REFUNDED|CHARGEBACK_REQUESTED)$/.test(ev || '')) {
    const p = body.payment || {}; const inv = p.id && store.db.prepare('SELECT * FROM invoices WHERE boleto_ref=?').get(p.id);
    if (inv) store.addHistory(inv.cid, `Asaas: ${ev} na cobrança ${D.compLabel(inv.comp)} — confira manualmente`, 'Asaas');
    return { ok: true };
  }
  if (ev === 'INVOICE_AUTHORIZED' || ev === 'INVOICE_ERROR' || ev === 'INVOICE_CANCELED') {
    const n = body.invoice || {}; const row = n.id && store.db.prepare('SELECT id FROM invoices WHERE nf_ref=?').get(n.id);
    if (!row) return { ignored: 'NF não encontrada' };
    const inv = store.getInvoice(row.id);
    if (ev === 'INVOICE_AUTHORIZED') { inv.nfUrl = n.pdfUrl || null; store.updateInvoice(inv); store.addHistory(inv.cid, `NF ${n.number ? 'nº ' + n.number + ' ' : ''}autorizada (${D.compLabel(inv.comp)})`, 'Asaas'); }
    else store.addHistory(inv.cid, `NF ${ev === 'INVOICE_ERROR' ? 'com erro' : 'cancelada'} na prefeitura (${D.compLabel(inv.comp)})${n.statusDescription ? ': ' + n.statusDescription : ''}`, 'Asaas');
    return { ok: true };
  }
  return { ignored: ev || 'sem evento' };
}

/* ---------- extrato bancário (OFX ou CSV) ---------- */
function parseStatement(text, filename) {
  text = String(text || '').replace(/^﻿/, '');
  const out = [];
  if (/<OFX>|<STMTTRN>/i.test(text)) {
    const tag = (blk, t) => { const m = blk.match(new RegExp('<' + t + '>([^<\\r\\n]*)', 'i')); return m ? m[1].trim() : ''; };
    text.split(/<STMTTRN>/i).slice(1).forEach(blk => {
      const dt = tag(blk, 'DTPOSTED');
      out.push({ data: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`, valor: parseFloat(tag(blk, 'TRNAMT').replace(',', '.')), pagador: tag(blk, 'NAME'), memo: tag(blk, 'MEMO'), fitid: tag(blk, 'FITID') });
    });
  } else {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const sep = (lines[0].match(/;/g) || []).length ? ';' : ',';
    const h = lines.shift().split(sep).map(x => x.trim().toLowerCase().replace(/^"|"$/g, ''));
    const col = (...ks) => h.findIndex(x => ks.includes(x));
    const iD = col('data', 'date'), iV = col('valor', 'value', 'amount'), iP = col('pagador', 'nome', 'descricao', 'descrição', 'historico', 'histórico'), iM = col('documento', 'memo', 'cnpj', 'detalhe'), iF = col('id', 'fitid', 'identificador');
    if (iD < 0 || iV < 0) bad('CSV do extrato precisa das colunas "data" e "valor".');
    lines.forEach(l => {
      const v = l.split(sep).map(x => x.replace(/^"|"$/g, '').trim());
      let d = v[iD]; if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) d = d.split('/').reverse().join('-');
      out.push({ data: d, valor: D.parseNum(v[iV]), pagador: iP >= 0 ? v[iP] : '', memo: iM >= 0 ? v[iM] : '', fitid: iF >= 0 ? v[iF] : '' });
    });
  }
  return out.filter(e => isISO(e.data) && e.valor > 0).map(e => ({ ...e, valor: D.round2(e.valor), fitid: e.fitid || crypto.createHash('sha1').update([filename, e.data, e.valor, e.pagador, e.memo].join('|')).digest('hex') }));
}
function guessClient(S, e) {
  const txt = (e.pagador + ' ' + e.memo);
  const digits = D.onlyDigits(txt);
  const byCnpj = S.clients.find(c => D.onlyDigits(c.cnpj).length === 14 && digits.includes(D.onlyDigits(c.cnpj)));
  if (byCnpj) return byCnpj.id;
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\W+/).filter(w => w.length > 3 && !['ltda', 'eireli', 'transportes', 'logistica'].includes(w));
  const words = new Set(norm(txt)); let best = null, score = 0;
  S.clients.forEach(c => { const sc = norm(c.name).filter(w => [...words].some(x => x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)))).length; if (sc > score) { score = sc; best = c.id; } });
  return best;
}
async function importStatement(text, filename, user) {
  const entries = parseStatement(text, filename);
  let novos = 0, baixados = 0, pendentes = 0, repetidos = 0;
  for (const e of entries) {
    if (store.db.prepare('SELECT 1 FROM bank_entries WHERE fitid=?').get(e.fitid)) { repetidos++; continue; }
    novos++;
    const S = store.state({ history: false });
    const sug = guessClient(S, e);
    let cand = S.invoices.filter(i => !D.isPaid(i) && Math.abs((i.valor - i.pago) - e.valor) < 0.005);
    if (sug && cand.some(i => i.cid === sug)) cand = cand.filter(i => i.cid === sug);
    // várias cobranças do mesmo cliente com o mesmo valor: quita a mais antiga
    if (cand.length > 1 && new Set(cand.map(i => i.cid)).size === 1) cand = [cand.sort((a, b) => a.venc.localeCompare(b.venc))[0]];
    const id = store.newId('b');
    if (cand.length === 1) {
      store.db.prepare("INSERT INTO bank_entries(id,fitid,data,valor,pagador,memo,status,invoice_id,sug_cid) VALUES(?,?,?,?,?,?,'conciliado',?,?)").run(id, e.fitid, e.data, e.valor, e.pagador, e.memo, cand[0].id, cand[0].cid);
      await applyPayment(cand[0].id, e.valor, e.data, 'extrato', user, e.fitid); baixados++;
    } else {
      store.db.prepare("INSERT INTO bank_entries(id,fitid,data,valor,pagador,memo,status,sug_cid) VALUES(?,?,?,?,?,?,'pendente',?)").run(id, e.fitid, e.data, e.valor, e.pagador, e.memo, sug || (cand[0] && cand[0].cid) || null);
      pendentes++;
    }
  }
  return { lidos: entries.length, novos, baixados, pendentes, repetidos };
}
async function linkBankEntry(id, cid, user) {
  const e = store.db.prepare("SELECT * FROM bank_entries WHERE id=? AND status='pendente'").get(id);
  if (!e) throw new HttpError(404, 'Entrada não encontrada ou já tratada.');
  const inv = store.listInvoices().filter(x => x.cid === cid && !D.isPaid(x)).sort((a, b) => a.venc.localeCompare(b.venc))[0];
  if (!inv) bad('Esse cliente não tem cobrança em aberto.');
  store.db.prepare("UPDATE bank_entries SET status='conciliado', invoice_id=? WHERE id=?").run(inv.id, id);
  return applyPayment(inv.id, e.valor, e.data, 'extrato (vínculo manual)', user, e.fitid);
}

/* ---------- importação de planilha ---------- */
function applyImport(rows, decisions, file, user) {
  const S = store.state({ history: false });
  const diff = D.diffRows(S, rows);
  let n = 0; const created = {};
  store.tx(() => {
    diff.forEach((r, idx) => {
      if (r.kind === 'erro' || r.kind === 'igual') return;
      let c = r.cid ? store.getClient(r.cid) : created[r.cnpjD];
      if (!c) {
        const t = D.tableById(S, 'padrao');
        c = { id: store.newId('c'), name: r.name, cnpj: r.cnpj, canal: 'Direto', status: 'ativo', tabela: t.id, versao: D.curVer(t).v, indicado: false, diasMin: S.cfg.diasMin, due: S.cfg.venc, mode: 'later', email: '', rules: ['multa'], ajustes: [], bloqueio: '', delta: 0, trial: null, linhas: [] };
        created[r.cnpjD] = c; store.saveClient(c); store.addHistory(c.id, 'Criado via importação', user, file);
      }
      let L = c.linhas.find(x => x.linha === r.linha);
      if (!L) { L = { linha: r.linha, ativos: 0, comodato: 0, comodatoPreco: null, precoManual: null, poucoUso: 0 }; c.linhas.push(L); }
      c.delta = (c.delta || 0) + r.ativos - L.ativos; L.ativos = r.ativos; L.comodato = r.comodato; L.poucoUso = r.pouco;
      if (r.preco !== null && (r.kind !== 'conflito' || (decisions || {})[idx] === 'use')) L.precoManual = r.preco;
      store.saveClient(c);
      store.addHistory(c.id, `Importação: ${r.linha} — ${r.changes.join(' · ') || 'atualizado'}`, user, file); n++;
    });
  })();
  return n;
}

/* ---------- contas a pagar ---------- */
function addPayable(b, file) {
  const forn = String(b.forn || '').trim(), valor = D.round2(D.parseNum(b.valor)), venc = b.venc, rec = ['Única', 'Mensal', 'Parcelado'].includes(b.rec) ? b.rec : 'Única';
  const n = int(b.parcelas, 1, 120, 1);
  if (!forn || !(valor > 0) || !isISO(venc)) bad('Preencha fornecedor, valor e vencimento.');
  const base = { forn, cat: D.CAT_PAG.includes(b.cat) ? b.cat : D.CAT_PAG[0], cc: D.CENTROS.includes(b.cc) ? b.cc : D.CENTROS[0], forma: ['Boleto', 'PIX', 'TED'].includes(b.forma) ? b.forma : 'Boleto' };
  const ins = store.db.prepare('INSERT INTO payables(id,forn,cat,cc,venc,valor,rec,forma,anexo,anexo_nome) VALUES(?,?,?,?,?,?,?,?,?,?)');
  store.tx(() => {
    if (rec === 'Parcelado') {
      const parc = D.round2(valor / n); // última parcela absorve o arredondamento
      for (let k = 0; k < n; k++) {
        const d = new Date(venc + 'T12:00:00'); d.setMonth(d.getMonth() + k);
        const v = k === n - 1 ? D.round2(valor - parc * (n - 1)) : parc;
        ins.run(store.newId('p'), base.forn, base.cat, base.cc, D.isoOf(d), v, `Parcela ${k + 1}/${n}`, base.forma, k === 0 && file ? file.filename : null, k === 0 && file ? file.originalname : null);
      }
    } else ins.run(store.newId('p'), base.forn, base.cat, base.cc, venc, valor, rec, base.forma, file ? file.filename : null, file ? file.originalname : null);
  })();
}
/* Ao pagar uma conta mensal, já cria a do mês seguinte */
function payPayable(id) {
  const p = store.db.prepare('SELECT * FROM payables WHERE id=?').get(id); if (!p) throw new HttpError(404, 'Conta não encontrada.');
  if (p.pago) return;
  store.tx(() => {
    store.db.prepare('UPDATE payables SET pago=1, pago_em=? WHERE id=?').run(D.todayISO(), id);
    if (/^Mensal/.test(p.rec)) {
      const d = new Date(p.venc + 'T12:00:00'); d.setMonth(d.getMonth() + 1);
      store.db.prepare('INSERT INTO payables(id,forn,cat,cc,venc,valor,rec,forma) VALUES(?,?,?,?,?,?,?,?)').run(store.newId('p'), p.forn, p.cat, p.cc, D.isoOf(d), p.valor, p.rec, p.forma);
    }
  })();
}

module.exports = {
  HttpError, sanitizeClient, diffClient, createClient, updateClient, setMode, ownTable,
  sendTrialNotice, sendBilling, applyPayment, sendReminder, asaasWebhook, retryProvider, markNfManual,
  parseStatement, importStatement, linkBankEntry, applyImport, addPayable, payPayable
};
