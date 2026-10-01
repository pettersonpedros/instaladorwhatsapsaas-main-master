/* Regras de negócio compartilhadas entre servidor (Node) e navegador.
   Tudo que decide valor de cobrança, período de apuração e situação de
   cobrança/teste mora aqui, para o que a tela mostra ser exatamente o que
   o servidor cobra. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Domain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RULES = {
    multa: { t: 'Multa 2% + juros 1% a.m.', d: 'após o vencimento' },
    pontualidade: { t: 'Desconto pontualidade', d: '5% se pago até o vencimento' },
    instalacao: { t: 'Taxa de instalação', d: 'por novo equipamento, lançada como ajuste' },
    naodevolvido: { t: 'Equipamento não devolvido', d: 'cobrança por unidade após 30 dias (comodato)' },
    temporario: { t: 'Desconto temporário', d: 'percentual com data fim, expira sozinho' }
  };
  const CAT_PAG = ['Conectividade', 'Infraestrutura', 'Hardware comodato', 'Folha', 'Serviços', 'Ocupação', 'Impostos'];
  const CENTROS = ['Custo do serviço', 'Administrativo', 'Comercial', 'Capex'];
  const REPORT_TYPES = ['Posição de recebimentos', 'Inadimplência', 'NFs pendentes pós-pagamento', 'Fechamento de competência', 'Testes terminando', 'Movimentação de dispositivos', 'Contas a pagar'];
  const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const NFTXT = { emitida: ['Emitida na cobrança', 'mt'], emitida_pos: ['Emitida após pgto', 'ok'], aguardando: ['Aguardando pgto', 'warn'], retida: ['Retida — pgto parcial', 'warn'] };

  /* ---------- números e datas ---------- */
  const clone = o => JSON.parse(JSON.stringify(o));
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const brl = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const nf2 = n => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = n => (n * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
  const dBR = iso => iso ? iso.split('-').reverse().join('/') : '—';
  const dShort = iso => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '—';
  const isoOf = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const todayISO = () => isoOf(new Date());
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoOf(d); };
  const diffDays = (a, b) => Math.round((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 864e5);
  const nowBR = () => new Date().toLocaleDateString('pt-BR');
  const compLabel = comp => { const [y, m] = comp.split('-'); return MESES[+m - 1] + '/' + y; };
  const nextComp = comp => { let [y, m] = comp.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return y + '-' + String(m).padStart(2, '0'); };
  const prevComp = comp => { let [y, m] = comp.split('-').map(Number); m--; if (m < 1) { m = 12; y--; } return y + '-' + String(m).padStart(2, '0'); };
  const parseNum = v => { if (typeof v === 'number') return v; v = String(v == null ? '' : v).trim().replace(/[R$\s]/g, ''); if (v === '') return NaN; if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.'); return parseFloat(v); };
  const optNum = v => { if (v === null || v === undefined || v === '') return null; const n = parseNum(v); return isNaN(n) ? null : n; };
  const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
  const onlyDigits = s => String(s || '').replace(/\D/g, '');
  const PAID_EPS = 0.005;

  /* ---------- cobranças ---------- */
  const isPaid = i => i.pago >= i.valor - PAID_EPS;
  const daysLate = i => isPaid(i) ? 0 : Math.max(0, diffDays(todayISO(), i.venc));
  function invStatus(i) {
    if (isPaid(i)) return ['Pago', 'ok'];
    if (i.pago > 0) return ['Parcial', 'warn'];
    const dl = daysLate(i);
    return dl > 0 ? ['Vencido ' + dl + ' dia' + (dl > 1 ? 's' : ''), 'bad'] : ['Em aberto', 'mt'];
  }
  /* Estado da NF a partir do modo e do quanto foi pago */
  function nfState(mode, valor, pago) {
    if (mode === 'now') return 'emitida';
    if (pago >= valor - PAID_EPS) return 'emitida_pos';
    return pago > 0 ? 'retida' : 'aguardando';
  }

  /* ---------- período de apuração ---------- */
  function periodo(cfg, comp) {
    const [y, m] = comp.split('-').map(Number); const p = prevComp(comp).split('-').map(Number);
    const pad = n => String(n).padStart(2, '0');
    const ini = `${p[0]}-${pad(p[1])}-${pad(cfg.inicio)}`;
    const fim = addDays(`${y}-${pad(m)}-${pad(cfg.inicio)}`, -1);
    const n = nextComp(comp).split('-');
    return { ini, fim, envio: `${pad(cfg.envioDe)} a ${pad(cfg.envioAte)}/${pad(m)}`, vencMes: `${n[0]}-${n[1]}` };
  }

  /* ---------- tabelas de preço ---------- */
  const tableById = (S, id) => S.tables.find(t => t.id === id);
  const curVer = t => t.versoes[t.versoes.length - 1];
  function tableVer(S, c) {
    const t = tableById(S, c.tabela) || tableById(S, 'padrao') || S.tables[0];
    const v = t.versoes.find(x => x.v === c.versao) || curVer(t);
    return { t, v };
  }
  function allLineDefs(S) {
    const m = new Map();
    S.tables.forEach(t => t.versoes.forEach(v => v.linhas.forEach(l => { if (!m.has(l.id)) m.set(l.id, l.nome); })));
    return m;
  }
  function faixaPreco(def, q) {
    for (const f of def.faixas) { if (q <= f.ate) return { p: f.preco, acima: false }; }
    return { p: def.faixas[def.faixas.length - 1].preco, acima: true };
  }
  function escalonado(def, n) {
    let rest = n, prev = 0, val = 0;
    for (const f of def.faixas) { const take = Math.min(rest, Math.max(0, f.ate - prev)); val += take * f.preco; rest -= take; prev = f.ate; if (rest <= 0) break; }
    if (rest > 0) val += rest * def.faixas[def.faixas.length - 1].preco;
    return val;
  }
  function validTableVersion(d) {
    if (!d || !Array.isArray(d.linhas)) return 'Tabela inválida.';
    if (!['linha', 'total'].includes(d.faixaBase) || !['volume', 'escalonado'].includes(d.modo)) return 'Configuração de faixa inválida.';
    for (const l of d.linhas) {
      if (!l.id || !l.nome) return 'Toda linha precisa de nome.';
      if (!Array.isArray(l.faixas) || !l.faixas.length) return `${l.nome}: precisa de pelo menos uma faixa.`;
      let prev = 0;
      for (const f of l.faixas) { if (!(f.ate > prev) || !(f.preco >= 0)) return `${l.nome}: faixas precisam ser crescentes e com preço válido.`; prev = f.ate; }
      if (l.comodatoPreco !== null && l.comodatoPreco !== undefined && !(l.comodatoPreco >= 0)) return `${l.nome}: preço de comodato inválido.`;
    }
    return '';
  }

  /* ---------- cálculo da cobrança de um cliente ---------- */
  const hasVal = x => x !== null && x !== undefined && x !== '';
  function calc(S, c) {
    const { t, v } = tableVer(S, c); const items = [], flags = []; const dmin = +c.diasMin || 0;
    const bill = c.linhas.map(l => Math.max(0, (+l.ativos || 0) - (dmin > 0 ? (+l.poucoUso || 0) : 0)));
    const totalQ = bill.reduce((s, x) => s + x, 0);
    let cort = c.indicado ? (+v.cortesia || 0) : 0;
    let lic = 0, com = 0, pouco = 0, free = 0;
    c.linhas.forEach((l, i) => {
      const def = v.linhas.find(x => x.id === l.linha);
      if (!def) { flags.push({ blk: true, msg: `${allLineDefs(S).get(l.linha) || l.linha} não existe na tabela ${t.nome} ${v.v}` }); return; }
      const comQ = Math.min(+l.comodato || 0, bill[i]); let licQ = bill[i] - comQ;
      const fr = Math.min(cort, licQ); cort -= fr; licQ -= fr; free += fr;
      const q = v.faixaBase === 'total' ? totalQ : bill[i];
      let unit, val, origem;
      if (hasVal(l.precoManual)) { unit = +l.precoManual; val = licQ * unit; origem = 'negociado'; }
      else if (v.modo === 'escalonado') {
        val = escalonado(def, licQ); unit = licQ ? val / licQ : 0; origem = 'escalonado';
        if (licQ > def.faixas[def.faixas.length - 1].ate) flags.push({ blk: false, msg: `${def.nome}: acima da última faixa da tabela` });
      } else {
        const f = faixaPreco(def, q); unit = f.p; val = licQ * unit;
        const fx = def.faixas.find(x => q <= x.ate);
        origem = 'faixa até ' + (fx ? fx.ate : '∞');
        if (f.acima) flags.push({ blk: false, msg: `${def.nome}: ${q} ${def.unid}s, acima da última faixa — negociar preço` });
      }
      items.push({ tipo: 'lic', linha: def.id, nome: def.nome, qtd: licQ, unit, valor: round2(val), origem, free: fr, pouco: dmin > 0 ? (+l.poucoUso || 0) : 0 });
      if (comQ) {
        const cp = hasVal(l.comodatoPreco) ? +l.comodatoPreco : def.comodatoPreco;
        if (!hasVal(cp)) { flags.push({ blk: true, msg: `${def.nome}: preço de comodato não definido` }); items.push({ tipo: 'com', linha: def.id, nome: def.nome, qtd: comQ, unit: 0, valor: 0 }); }
        else items.push({ tipo: 'com', linha: def.id, nome: def.nome, qtd: comQ, unit: +cp, valor: round2(comQ * (+cp)) });
      }
      lic += licQ; com += comQ; pouco += dmin > 0 ? (+l.poucoUso || 0) : 0;
    });
    const devices = c.linhas.reduce((s, l) => s + (+l.ativos || 0), 0);
    const base = round2(items.reduce((s, x) => s + x.valor, 0)), aj = round2((c.ajustes || []).reduce((s, a) => s + a.valor, 0));
    return { items, flags, lic, com, pouco, free, devices, base, aj, total: round2(base + aj), tabela: t.nome, versao: v.v, oldVer: !!t.padrao && v.v !== curVer(t).v };
  }
  const sumTipo = (k, tipo) => k.items.filter(x => x.tipo === tipo).reduce((s, x) => s + x.valor, 0);

  /* Decide se o cliente entra na cobrança da competência */
  function billState(S, c, comp) {
    const P = periodo(S.cfg, comp);
    if (c.status === 'encerrado') return { skip: true, txt: 'Contrato encerrado', cls: 'mt' };
    if (c.status === 'teste' && c.trial) {
      if (c.trial.fim >= P.fim) return { skip: true, txt: `Em teste até ${dBR(c.trial.fim)} — não cobrado`, cls: 'pur' };
      if (c.trial.aoFim === 'suspender') return { skip: true, txt: 'Teste terminou — aguardando conversão', cls: 'warn' };
      const dias = diffDays(P.fim, c.trial.fim);
      if (dias < (+c.diasMin || 0)) return { skip: true, txt: `Teste terminou há ${dias} dia(s) no período — abaixo de ${c.diasMin}, não cobra`, cls: 'pur' };
    }
    if ((S.invoices || []).some(i => i.cid === c.id && i.comp === comp)) return { skip: true, sent: true, txt: 'Cobrança já emitida', cls: 'ok' };
    const k = calc(S, c);
    if (c.bloqueio) return { skip: false, blocked: true, txt: c.bloqueio, cls: 'bad' };
    const b = k.flags.find(f => f.blk); if (b) return { skip: false, blocked: true, txt: b.msg, cls: 'bad' };
    if (!(k.total > 0)) return { skip: false, blocked: true, txt: 'Valor da cobrança é zero', cls: 'bad' };
    return { skip: false, blocked: false };
  }

  function trialInfo(c) {
    if (c.status !== 'teste' || !c.trial) return null;
    const today = todayISO();
    const rest = diffDays(c.trial.fim, today);
    const ag = c.trial.avisos.slice().sort((a, b) => b - a).map(d => {
      const em = addDays(c.trial.fim, -d); const env = (c.trial.enviados || []).find(x => x.d === d);
      return { d, em, env: env ? env.em : null, atrasado: !env && em < today };
    });
    return { rest, ag, next: ag.find(a => !a.env) };
  }
  function trialMail(S, c, d) {
    const fim = dBR(c.trial.fim);
    return {
      assunto: `Seu teste gratuito da YUV termina em ${fim}`,
      corpo: `Olá, equipe ${c.name}.\n\nO período de teste gratuito de ${S.cfg.trialDias} dias da plataforma YUV termina em ${fim}${d ? ` (faltam ${d} dia${d > 1 ? 's' : ''})` : ''}.\n\n${c.trial.aoFim === 'cobrar' ? `A partir de ${dBR(addDays(c.trial.fim, 1))}, os dispositivos ativos passam a ser cobrados conforme o Termo de Aquisição dos Serviços.` : `Para continuar usando a plataforma sem interrupção, responda este e-mail ou fale com seu consultor YUV antes dessa data.`}\n\nDúvidas: ${S.cfg.emailFinanceiro || 'financeiro@yuv.com.br'}\n\nEquipe YUV`
    };
  }
  function describe(S, c) { const k = calc(S, c); return `${k.devices} dispositivos (${k.com} comodato) · ${k.tabela} ${k.versao} · ${brl(k.total)}/mês`; }

  /* ---------- relatórios (mesmas linhas no "gerar agora" e no agendado) ---------- */
  function reportRows(S, tipo) {
    const client = id => S.clients.find(c => c.id === id);
    const nm = id => (client(id) || {}).name || '—';
    const comps = [...new Set(S.invoices.map(i => i.comp))].sort();
    const comp = comps[comps.length - 1];
    const inv = S.invoices.filter(i => i.comp === comp);
    if (tipo === 'Posição de recebimentos' || tipo === 'Fechamento de competência')
      return [['cliente', 'competência', 'vencimento', 'cobrado', 'recebido', 'status'], ...inv.map(i => [nm(i.cid), compLabel(i.comp), dBR(i.venc), nf2(i.valor), nf2(i.pago), invStatus(i)[0]])];
    if (tipo === 'Inadimplência')
      return [['cliente', 'competência', 'vencimento', 'em aberto', 'dias de atraso'], ...S.invoices.filter(i => !isPaid(i) && daysLate(i) > 0).map(i => [nm(i.cid), compLabel(i.comp), dBR(i.venc), nf2(i.valor - i.pago), daysLate(i)])];
    if (tipo === 'NFs pendentes pós-pagamento')
      return [['cliente', 'situação da NF', 'cobrado', 'recebido'], ...S.invoices.filter(i => i.nf === 'aguardando' || i.nf === 'retida').map(i => [nm(i.cid), NFTXT[i.nf][0], nf2(i.valor), nf2(i.pago)])];
    if (tipo === 'Testes terminando')
      return [['cliente', 'fim do teste', 'dias restantes', 'e-mail de aviso', 'ao terminar', 'dispositivos'], ...S.clients.filter(c => c.status === 'teste' && c.trial).map(c => [c.name, dBR(c.trial.fim), trialInfo(c).rest, c.trial.email, c.trial.aoFim === 'cobrar' ? 'Começa a cobrar' : 'Suspende', calc(S, c).devices])];
    if (tipo === 'Movimentação de dispositivos')
      return [['cliente', 'linha', 'ativos', 'comodato', 'abaixo do mínimo', 'variação no mês (cliente)'], ...S.clients.flatMap(c => c.linhas.map(l => [c.name, l.linha, l.ativos, l.comodato, l.poucoUso || 0, c.delta]))];
    return [['fornecedor', 'categoria', 'centro de custo', 'vencimento', 'valor', 'status'], ...S.payables.map(p => [p.forn, p.cat, p.cc, dBR(p.venc), nf2(p.valor), p.pago ? 'Pago' : 'A pagar'])];
  }
  function toCSV(rows) {
    return '﻿' + rows.map(r => r.map(x => { x = String(x == null ? '' : x); return /[;"\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; }).join(';')).join('\n');
  }
  const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\W+/g, '-');

  /* Próxima execução de um relatório agendado (fim de semana → próximo dia útil) */
  function shiftBusiness(d) { const x = new Date(d); while (x.getDay() === 0 || x.getDay() === 6) x.setDate(x.getDate() + 1); return x; }
  function nextRun(r, now) {
    now = now || new Date();
    for (let k = -3; k < 62; k++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k);
      if (r.dias.includes(d.getDate())) {
        const x = shiftBusiness(d); const [h, m] = r.hora.split(':'); x.setHours(+h, +m, 0, 0);
        if (x > now) return x;
      }
    }
    return null;
  }
  /* O relatório deve rodar hoje? Devolve a data de referência (dia agendado) ou null */
  function dueToday(r, now) {
    now = now || new Date();
    const today = isoOf(now);
    for (let k = 0; k <= 3; k++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - k);
      if (r.dias.includes(d.getDate()) && isoOf(shiftBusiness(d)) === today) {
        const [h, m] = r.hora.split(':'); const at = new Date(now); at.setHours(+h, +m, 0, 0);
        if (now >= at) return isoOf(d);
      }
    }
    return null;
  }

  /* ---------- planilha de importação: compara com o que existe ---------- */
  function diffRows(S, rows) {
    const pick = (o, ...ks) => { for (const k of ks) { if (o[k] !== undefined && o[k] !== '') return o[k]; } return ''; };
    const defs = allLineDefs(S);
    return rows.map(o => {
      const name = String(pick(o, 'cliente', 'nome')).trim(), cnpj = String(pick(o, 'cnpj')).trim(), cnpjD = onlyDigits(cnpj);
      let linha = String(pick(o, 'linha', 'equipamento')).trim().toLowerCase();
      const byName = [...defs].find(([, n]) => n.toLowerCase() === linha); if (byName) linha = byName[0];
      const ativos = parseInt(pick(o, 'ativos', 'dispositivos', 'quantidade'), 10), comodato = parseInt(pick(o, 'comodato'), 10) || 0, pouco = parseInt(pick(o, 'abaixo_dias_min', 'poucos_dias'), 10) || 0;
      const preco = optNum(pick(o, 'preco_licenca', 'preço_licença', 'valor_licenca'));
      const r = { name, cnpj, cnpjD, linha, ativos, comodato, pouco, preco, changes: [], kind: 'igual', dec: 'keep' };
      if (!name) return Object.assign(r, { kind: 'erro', changes: ['Nome do cliente vazio'] });
      if (cnpjD.length !== 14) return Object.assign(r, { kind: 'erro', changes: ['CNPJ inválido: ' + (cnpj || 'vazio')] });
      if (!defs.has(linha)) return Object.assign(r, { kind: 'erro', changes: [`Linha "${linha || 'vazia'}" não existe nas tabelas`] });
      if (isNaN(ativos) || ativos < 0 || comodato < 0 || pouco < 0 || comodato > ativos) return Object.assign(r, { kind: 'erro', changes: ['Quantidade inválida (comodato maior que ativos?)'] });
      if (preco !== null && !(preco >= 0)) return Object.assign(r, { kind: 'erro', changes: ['Preço de licença inválido'] });
      const c = S.clients.find(x => onlyDigits(x.cnpj) === cnpjD); if (c) r.cid = c.id;
      const L = c && c.linhas.find(x => x.linha === linha);
      if (!L) { r.kind = 'novo'; r.changes = [`${ativos} ativos · ${comodato} comodato`]; return r; }
      if (ativos !== L.ativos) r.changes.push(`Ativos ${L.ativos} → ${ativos}`);
      if (comodato !== L.comodato) r.changes.push(`Comodato ${L.comodato} → ${comodato}`);
      if (pouco !== (L.poucoUso || 0)) r.changes.push(`Abaixo do mínimo ${L.poucoUso || 0} → ${pouco}`);
      const precoMuda = preco !== null && Math.abs(preco - (hasVal(L.precoManual) ? L.precoManual : -1)) > 0.001;
      if (precoMuda) r.changes.push(`Preço licença ${hasVal(L.precoManual) ? brl(L.precoManual) : 'tabela'} → ${brl(preco)}`);
      if (!r.changes.length) return r;
      r.kind = precoMuda && hasVal(L.precoManual) ? 'conflito' : 'alterado'; return r;
    });
  }

  return {
    RULES, CAT_PAG, CENTROS, REPORT_TYPES, MESES, NFTXT,
    clone, round2, brl, nf2, pct, dBR, dShort, isoOf, todayISO, addDays, diffDays, nowBR,
    compLabel, nextComp, prevComp, parseNum, optNum, isEmail, onlyDigits, hasVal,
    isPaid, daysLate, invStatus, nfState, periodo,
    tableById, curVer, tableVer, allLineDefs, faixaPreco, escalonado, validTableVersion,
    calc, sumTipo, billState, trialInfo, trialMail, describe,
    reportRows, toCSV, slug, nextRun, dueToday, diffRows
  };
});
