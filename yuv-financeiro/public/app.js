'use strict';
/* YUV Financeiro — interface. As regras de cálculo vêm de /shared/domain.js
   (as mesmas que o servidor usa) e todo dado é lido/gravado pela API. */
const { RULES, CAT_PAG, CENTROS, REPORT_TYPES, MESES, NFTXT, clone, brl, nf2, pct, dBR, dShort, todayISO, addDays, diffDays, nowBR, compLabel, nextComp, parseNum, optNum, isEmail, isPaid, daysLate, invStatus, curVer, sumTipo } = Domain;

let S = null, ME = null, BUSY = false;
const table = id => Domain.tableById(S, id);
const tableVer = c => Domain.tableVer(S, c);
const allLineDefs = () => Domain.allLineDefs(S);
const calc = c => Domain.calc(S, c);
const billState = (c, comp) => Domain.billState(S, c, comp);
const periodo = comp => Domain.periodo(S.cfg, comp);
const trialInfo = c => Domain.trialInfo(c);
const client = id => S.clients.find(c => c.id === id);

/* ===================== API ===================== */
async function api(method, url, body) {
  const o = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) o.body = body;
  else if (method !== 'GET') { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body || {}); }
  const r = await fetch('/api' + url, o);
  if (r.status === 401 && url !== '/login') { showLogin(); throw new Error('Sessão expirada. Entre novamente.'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Falha na comunicação com o servidor.');
  return d;
}
async function reload() { S = await api('GET', '/state'); }
/* Executa uma ação no servidor, recarrega os dados e redesenha a tela.
   errEl: onde mostrar o erro (senão vira toast). Devolve o resultado ou null. */
async function act(fn, okMsg, errEl) {
  if (BUSY) return null; BUSY = true; document.body.style.cursor = 'progress';
  try {
    const r = await fn();
    const V = $('#view'); V._snap = null; V._orig = null;
    await reload(); render();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    return r || {};
  } catch (e) {
    if (errEl) errEl.textContent = e.message; else toast(e.message);
    return null;
  } finally { BUSY = false; document.body.style.cursor = ''; }
}

/* ===================== Utilidades de tela ===================== */
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
function toast(msg) { document.querySelectorAll('.toast').forEach(x => x.remove()); const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 4200); }
function modal(html, onMount) {
  const L = $('#layer'); L.innerHTML = '<div class="scrim"><div class="modal" role="dialog" aria-modal="true">' + html + '</div></div>';
  const sc = L.firstChild; sc.addEventListener('click', e => { if (e.target === sc) closeModal(); });
  if (onMount) onMount(sc.firstChild);
  const f = sc.querySelector('input,select,textarea,button'); if (f) f.focus();
}
function closeModal() { $('#layer').innerHTML = ''; }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#layer').innerHTML && !$('#login')) closeModal(); });
function download(name, rows) {
  const blob = new Blob([Domain.toCSV(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function fetchFile(url) { const a = document.createElement('a'); a.href = url; a.click(); }
const simNote = r => r && r.simulated ? ' (modo simulado — configure o SMTP)' : '';

/* ===================== Login ===================== */
function showLogin() {
  $('#layer').innerHTML = `<div class="scrim" id="login" style="background:var(--bg)"><form class="modal" style="width:min(400px,100%)" autocomplete="on">
    <div style="font-size:22px;font-weight:700">YUV <span style="font-weight:400;color:var(--mut)">Financeiro</span></div>
    <label class="fld">E-mail<input id="lg_e" type="email" autocomplete="username" required></label>
    <label class="fld">Senha<input id="lg_p" type="password" autocomplete="current-password" required></label>
    <div id="lg_err" class="err"></div>
    <button class="btn pri" type="submit">Entrar</button></form></div>`;
  const f = $('#login form'); $('#lg_e').focus();
  f.addEventListener('submit', async e => {
    e.preventDefault();
    try { ME = await api('POST', '/login', { email: $('#lg_e').value, password: $('#lg_p').value }); ME = await api('GET', '/me'); await reload(); closeModal(); paintFoot(); render(); }
    catch (er) { $('#lg_err').textContent = er.message; }
  });
}
function paintFoot() {
  const sim = [ME.mail === 'simulado' ? 'e-mail' : '', ME.provider === 'simulado' ? 'boleto/NF' : '', ME.sandbox ? 'Asaas sandbox' : ''].filter(Boolean);
  $('#foot').innerHTML = `Conectado como <strong>${esc(ME.name)}</strong><br>${sim.length ? `<span style="color:#F3C77A">Modo simulado: ${sim.join(' e ')}.</span><br>` : ''}<button id="logout">Sair</button>`;
  $('#logout').addEventListener('click', async () => { await api('POST', '/logout').catch(() => {}); S = null; $('#view').innerHTML = ''; showLogin(); });
}

/* ===================== Roteamento ===================== */
let route = 'clientes', routeArg = null;
async function go(r, arg = null) {
  const V = $('#view'); V._snap = null; V._orig = null;
  route = r; routeArg = arg;
  try { await reload(); } catch (e) { toast(e.message); return; }
  render(); try { window.scrollTo(0, 0); } catch (e) { /* noop */ }
}
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
  if (route === 'cliente' && dirtyNow() && !confirm('Há alterações não salvas. Sair mesmo assim?')) return;
  go(b.dataset.go);
}));
function render() {
  if (!S) return;
  document.querySelectorAll('[data-go]').forEach(b => { const on = b.dataset.go === route || (route === 'cliente' && b.dataset.go === 'clientes'); b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  const V = { clientes: vClientes, cliente: vCliente, tabelas: vTabelas, importar: vImportar, cobranca: vCobranca, conciliacao: vConciliacao, relatorios: vRelatorios, pagamentos: vPagamentos, insights: vInsights }[route];
  $('#view').innerHTML = ''; V($('#view'));
}

/* ===================== Clientes ===================== */
let fCli = { q: '', mode: '', status: '' };
function vClientes(el) {
  const act_ = S.clients.filter(c => c.status === 'ativo');
  const dev = S.clients.reduce((s, c) => s + calc(c).devices, 0), com = S.clients.reduce((s, c) => s + calc(c).com, 0);
  const mrr = act_.reduce((s, c) => s + calc(c).total, 0);
  const trials = S.clients.filter(c => c.status === 'teste' && c.trial).map(c => ({ c, ti: trialInfo(c) })).sort((a, b) => a.ti.rest - b.ti.rest);
  const list = S.clients.filter(c => (!fCli.q || (c.name + c.cnpj).toLowerCase().includes(fCli.q.toLowerCase())) && (!fCli.mode || c.mode === fCli.mode) && (!fCli.status || c.status === fCli.status));
  el.innerHTML = `
  <header class="pg"><div><div class="sub">Quantidades atualizadas pela importação de planilha</div><h1>Clientes e contratos</h1></div>
   <div class="row"><button class="btn" data-a="imp">Importar planilha</button><button class="btn" data-a="teste">Novo teste gratuito</button><button class="btn pri" data-a="novo">Novo cliente</button></div></header>
  <div class="grid g4">
   <div class="card kpi"><div class="k">Dispositivos ativos</div><div class="v num">${dev}</div><div class="s">${com} em comodato</div></div>
   <div class="card kpi"><div class="k">Receita mensal estimada</div><div class="v num">${brl(mrr)}</div><div class="s">clientes ativos, sem testes</div></div>
   <div class="card kpi"><div class="k">Em teste gratuito</div><div class="v num">${trials.length}</div><div class="s">${trials.reduce((s, x) => s + calc(x.c).devices, 0)} dispositivos</div></div>
   <div class="card kpi"><div class="k">NF só após pagamento</div><div class="v num">${S.clients.filter(c => c.mode === 'later').length}</div><div class="s">de ${S.clients.length} clientes</div></div>
  </div>
  ${trials.filter(x => x.ti.rest <= 10).map(({ c, ti }) => `<div class="alert p"><div><strong>${esc(c.name)}:</strong> teste termina em ${dBR(c.trial.fim)} (${ti.rest >= 0 ? ti.rest + ' dia' + (ti.rest !== 1 ? 's' : '') : 'encerrado'}). ${ti.next ? (ti.next.atrasado ? `Aviso de ${ti.next.d} dias <strong>não enviado</strong>.` : `Próximo aviso por e-mail em ${dBR(ti.next.em)}.`) : 'Todos os avisos enviados.'} Ao terminar: ${c.trial.aoFim === 'cobrar' ? 'começa a cobrar' : 'suspende e avisa o comercial'}.</div><div class="row"><button class="btn sm" data-mail="${c.id}">Enviar aviso agora</button><button class="btn sm" data-open="${c.id}">Abrir</button></div></div>`).join('')}
  <div class="row">
   <label class="fld" style="flex:1;min-width:220px">Buscar cliente<input id="fq" value="${esc(fCli.q)}" placeholder="Nome ou CNPJ"></label>
   <label class="fld" style="width:180px">Situação<select id="fs"><option value="">Todas</option><option value="ativo" ${fCli.status === 'ativo' ? 'selected' : ''}>Ativo</option><option value="teste" ${fCli.status === 'teste' ? 'selected' : ''}>Em teste</option><option value="encerrado" ${fCli.status === 'encerrado' ? 'selected' : ''}>Encerrado</option></select></label>
   <label class="fld" style="width:250px">Modo de faturamento<select id="fm"><option value="">Todos</option><option value="now" ${fCli.mode === 'now' ? 'selected' : ''}>Boleto + NF na emissão</option><option value="later" ${fCli.mode === 'later' ? 'selected' : ''}>Só boleto (NF após pagamento)</option></select></label>
  </div>
  <div class="card tbw"><table>
   <thead><tr><th>Cliente</th><th>Situação</th><th>Tabela</th><th class="r">Dispositivos</th><th class="r">Comodato</th><th class="r">Licenças cobradas</th><th class="r">Mensal</th><th>Venc.</th><th>Faturamento</th><th></th></tr></thead>
   <tbody>${list.map(c => { const k = calc(c), ti = trialInfo(c); return `<tr>
    <td><div style="font-weight:600">${esc(c.name)}</div><div class="num" style="font-size:12px;color:var(--mut)">${esc(c.cnpj)}</div></td>
    <td>${c.status === 'teste' ? `<span class="b pur">Teste · ${ti.rest >= 0 ? ti.rest + 'd' : 'fim'}</span>` : c.status === 'encerrado' ? '<span class="b mt">Encerrado</span>' : c.bloqueio ? '<span class="b bad">Bloqueio</span>' : '<span class="b ok">Ativo</span>'}${c.indicado ? ' <span class="b info" title="Indicado por parceiro: cortesia dos primeiros dispositivos">Indicado</span>' : ''}</td>
    <td>${esc(k.tabela.replace('Personalizada — ', 'Pers. '))} <span class="sub">${esc(k.versao)}</span>${k.oldVer ? ' <span class="b warn">versão antiga</span>' : ''}</td>
    <td class="r num">${k.devices}</td><td class="r num">${k.com || '—'}</td><td class="r num">${k.lic}</td>
    <td class="r num" style="font-weight:600">${c.status === 'teste' ? '<span style="color:var(--mut)">grátis</span>' : nf2(k.total)}</td>
    <td class="num">dia ${c.due}</td>
    <td><div class="seg" role="group" aria-label="Modo de faturamento de ${esc(c.name)}"><button class="${c.mode === 'now' ? 'a' : ''}" data-mode="now" data-id="${c.id}" aria-pressed="${c.mode === 'now'}">Boleto + NF</button><button class="${c.mode === 'later' ? 'l' : ''}" data-mode="later" data-id="${c.id}" aria-pressed="${c.mode === 'later'}">Só boleto</button></div></td>
    <td><button class="link" data-open="${c.id}">Abrir</button></td></tr>`; }).join('') || `<tr><td colspan="10" class="hint" style="padding:24px">${S.clients.length ? 'Nenhum cliente com esses filtros.' : 'Nenhum cliente ainda. Cadastre um ou importe a planilha.'}</td></tr>`}</tbody>
  </table></div>
  <div class="hint">Licenças cobradas = dispositivos ativos − comodato − dispositivos abaixo do mínimo de dias ativos − cortesia (indicados).</div>`;
  const keep = (id, fn) => { const i = $(id, el); i.addEventListener('input', e => { fn(e.target.value); const p = e.target.selectionStart; vClientes(el); const n = $(id, el); n.focus(); n.setSelectionRange(p, p); }); };
  keep('#fq', v => fCli.q = v);
  $('#fs', el).addEventListener('change', e => { fCli.status = e.target.value; vClientes(el); });
  $('#fm', el).addEventListener('change', e => { fCli.mode = e.target.value; vClientes(el); });
  el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    const c = client(b.dataset.id); if (c.mode === b.dataset.mode) return; const to = b.dataset.mode === 'now' ? 'Boleto + NF' : 'Só boleto';
    act(() => api('POST', `/clients/${c.id}/mode`, { mode: b.dataset.mode }), `${c.name}: ${to}`);
  }));
  el.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => go('cliente', b.dataset.open)));
  el.querySelectorAll('[data-mail]').forEach(b => b.addEventListener('click', () => { const c = client(b.dataset.mail); mailTrial(c, trialInfo(c).next?.d ?? 0); }));
  el.querySelector('[data-a="imp"]').addEventListener('click', () => go('importar'));
  el.querySelector('[data-a="novo"]').addEventListener('click', () => novoCliente(false));
  el.querySelector('[data-a="teste"]').addEventListener('click', () => novoCliente(true));
}
function mailTrial(c, d) {
  const m = Domain.trialMail(S, c, d);
  modal(`<h2>Aviso de fim de teste</h2>
   <label class="fld">Para<input id="mt" value="${esc(c.trial.email)}"></label>
   <label class="fld">Assunto<input id="ms" value="${esc(m.assunto)}"></label>
   <label class="fld">Mensagem<textarea id="mb" style="min-height:220px">${esc(m.corpo)}</textarea></label>
   <div id="merr" class="err"></div>
   <div class="row" style="justify-content:flex-end"><button class="btn" data-x>Cancelar</button><button class="btn pri" data-ok>Enviar e-mail</button></div>`, md => {
    md.querySelector('[data-x]').addEventListener('click', closeModal);
    md.querySelector('[data-ok]').addEventListener('click', async () => {
      const to = $('#mt').value.trim(); if (!isEmail(to)) { $('#merr').textContent = 'Informe um e-mail válido.'; return; }
      const r = await act(() => api('POST', `/clients/${c.id}/trial-notice`, { d, to, subject: $('#ms').value, body: $('#mb').value }), r => 'E-mail enviado' + simNote(r) + '.', $('#merr'));
      if (r) closeModal();
    });
  });
}
function novoCliente(teste) {
  const P = S.tables.map(t => `<option value="${t.id}">${esc(t.nome)} ${esc(curVer(t).v)}</option>`).join('');
  const lineOpts = t => curVer(t).linhas.map(l => `<option value="${l.id}">${esc(l.nome)}</option>`).join('');
  modal(`<h2>${teste ? 'Novo teste gratuito' : 'Novo cliente'}</h2>
   <div class="grid g2">
    <label class="fld" style="grid-column:1/-1">Nome<input id="n1"></label>
    <label class="fld">CNPJ<input id="n2" placeholder="00.000.000/0000-00"></label>
    <label class="fld">Canal<select id="n3"><option>Direto</option><option>Integrador</option></select></label>
    <label class="fld">Tabela de preço<select id="n4">${P}</select></label>
    <label class="fld">Linha de equipamento<select id="n5">${lineOpts(S.tables[0])}</select></label>
    <label class="fld">Dispositivos ativos<input id="n6" type="number" min="0" value="10"></label>
    <label class="fld">Desses, em comodato<input id="n7" type="number" min="0" value="0"></label>
    ${teste ? `<label class="fld" style="grid-column:1/-1">E-mail para aviso de fim do teste<input id="n8" placeholder="gestor@cliente.com.br"></label>
    <label class="fld">Início do teste<input id="n9" type="date" value="${todayISO()}"></label>
    <label class="fld">Ao terminar<select id="n10"><option value="suspender">Suspender e avisar comercial</option><option value="cobrar">Começar a cobrar</option></select></label>` : `<label class="fld" style="grid-column:1/-1">E-mail financeiro<input id="n8"></label>`}
    <label class="rule" style="grid-column:1/-1;border:0"><input type="checkbox" id="n11"><span><strong>Indicado por parceiro</strong> — cortesia dos primeiros dispositivos</span></label>
   </div>
   <div id="nerr" class="err"></div>
   <div class="row" style="justify-content:flex-end"><button class="btn" data-x>Cancelar</button><button class="btn pri" data-ok>${teste ? 'Iniciar teste' : 'Cadastrar cliente'}</button></div>`, m => {
    $('#n4').addEventListener('change', () => { $('#n5').innerHTML = lineOpts(table($('#n4').value)); });
    m.querySelector('[data-x]').addEventListener('click', closeModal);
    m.querySelector('[data-ok]').addEventListener('click', async () => {
      const name = $('#n1').value.trim(), at = parseInt($('#n6').value, 10), co = parseInt($('#n7').value, 10) || 0;
      if (!name || !(at >= 0) || co > at) { $('#nerr').textContent = 'Preencha o nome e confira as quantidades (comodato não pode passar do total).'; return; }
      if (teste && !isEmail($('#n8').value)) { $('#nerr').textContent = 'Informe o e-mail que vai receber o aviso de fim do teste.'; return; }
      const t = table($('#n4').value), ini = teste ? ($('#n9').value || todayISO()) : null;
      const doc = { name, cnpj: $('#n2').value.trim(), canal: $('#n3').value, status: teste ? 'teste' : 'ativo', tabela: t.id, versao: curVer(t).v, indicado: $('#n11').checked, diasMin: S.cfg.diasMin, due: S.cfg.venc, mode: 'later', email: teste ? '' : $('#n8').value.trim(), rules: ['multa'], ajustes: [], bloqueio: '',
        linhas: [{ linha: $('#n5').value, ativos: at, comodato: co, comodatoPreco: null, precoManual: null, poucoUso: 0 }],
        trial: teste ? { inicio: ini, fim: addDays(ini, S.cfg.trialDias), email: $('#n8').value.trim(), avisos: S.cfg.avisos.slice(), aoFim: $('#n10').value } : null };
      try {
        const c = await api('POST', '/clients', { client: doc });
        closeModal(); await go('cliente', c.id); toast(teste ? 'Teste iniciado. Avisos por e-mail programados.' : 'Cliente cadastrado.');
      } catch (e) { $('#nerr').textContent = e.message; }
    });
  });
}

/* ===================== Detalhe do cliente ===================== */
const snapOf = c => JSON.stringify({ linhas: c.linhas, tabela: c.tabela, versao: c.versao, trial: c.trial, ajustes: c.ajustes });
function dirtyNow() { const V = $('#view'), c = route === 'cliente' && client(routeArg); return !!(c && V._snap && (V._snap !== snapOf(c) || ($('#e_why') && $('#e_why').value.trim()))); }
function vCliente(el) {
  const c = client(routeArg); if (!c) { go('clientes'); return; }
  const k = calc(c), { t, v } = tableVer(c), ti = trialInfo(c), defs = v.linhas;
  el.innerHTML = `
  <div><button class="link" data-back>← Clientes e contratos</button></div>
  <header class="pg"><div><div class="row" style="gap:8px;align-items:center">${c.status === 'teste' ? '<span class="b pur">Em teste</span>' : c.status === 'encerrado' ? '<span class="b mt">Encerrado</span>' : '<span class="b ok">Ativo</span>'}<span class="b mt">${esc(c.canal)}</span><span class="num sub">${esc(c.cnpj)}</span></div><h1>${esc(c.name)}</h1></div>
   <div class="row"><button class="btn" data-cob>Ver cobranças</button>${c.status === 'teste' ? '<button class="btn" data-conv>Converter em cliente</button>' : ''}<button class="btn pri" data-save>Salvar alterações</button></div></header>
  <div class="split">
   <div class="grow stack">
    <section class="card pad stack">
     <div class="row" style="justify-content:space-between;align-items:center"><h2>Equipamentos e cobrança</h2><button class="btn sm" data-addl>+ Linha de equipamento</button></div>
     <div class="row" style="gap:12px">
      <label class="fld" style="flex:1;min-width:220px">Tabela de preço<select id="e_tab">${S.tables.map(x => `<option value="${x.id}" ${x.id === t.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></label>
      <label class="fld" style="width:150px">Versão<select id="e_ver">${t.versoes.map(x => `<option ${x.v === v.v ? 'selected' : ''}>${esc(x.v)}</option>`).join('')}</select></label>
      <button class="btn" data-dup title="Cria uma tabela só deste cliente a partir da atual">Criar tabela própria</button>
     </div>
     ${k.oldVer ? `<div class="alert w"><div>Este cliente está na <strong>${esc(v.v)}</strong>. A tabela padrão atual é a <strong>${esc(curVer(t).v)}</strong>. Mudar de versão altera o preço — só faça com o reajuste previsto em contrato.</div></div>` : ''}
     ${c.linhas.map((l, i) => { const it = k.items.filter(x => x.linha === l.linha); return `<div class="lineblk">
      <div class="grid" style="grid-template-columns:2fr 1fr 1fr 1fr 1fr 1fr auto;gap:10px;align-items:end">
       <label class="fld">Equipamento<select class="inp" data-l="${i}" data-k="linha">${defs.map(d => `<option value="${d.id}" ${d.id === l.linha ? 'selected' : ''}>${esc(d.nome)}</option>`).join('')}${defs.some(d => d.id === l.linha) ? '' : `<option value="${esc(l.linha)}" selected>${esc(l.linha)} (fora da tabela)</option>`}</select></label>
       <label class="fld">Ativos na plataforma<input class="inp num" data-l="${i}" data-k="ativos" type="number" min="0" value="${l.ativos}"></label>
       <label class="fld">Desses, comodato<input class="inp num" data-l="${i}" data-k="comodato" type="number" min="0" value="${l.comodato}"></label>
       <label class="fld">R$ comodato/un.<input class="inp num" data-l="${i}" data-k="comodatoPreco" value="${l.comodatoPreco != null ? nf2(l.comodatoPreco) : ''}" placeholder="${defs.find(d => d.id === l.linha)?.comodatoPreco ?? 'definir'}"></label>
       <label class="fld">R$ licença negociado<input class="inp num" data-l="${i}" data-k="precoManual" value="${l.precoManual != null ? nf2(l.precoManual) : ''}" placeholder="tabela"></label>
       <label class="fld">Abaixo de ${c.diasMin || 0} dias<input class="inp num" data-l="${i}" data-k="poucoUso" type="number" min="0" value="${l.poucoUso || 0}" title="Dispositivos com poucos dias ativos no período"></label>
       <button class="link del" data-rml="${i}" aria-label="Remover linha">remover</button>
      </div>
      <div class="brk" style="margin-top:8px">${it.map(x => x.tipo === 'lic' ? `Licenças: <strong class="num">${x.qtd} × ${brl(x.unit)} = ${brl(x.valor)}</strong> (${x.origem})${x.free ? ` · ${x.free} em cortesia` : ''}${x.pouco ? ` · ${x.pouco} sem cobrança por poucos dias ativos` : ''}` : `Comodato: <strong class="num">${x.qtd} × ${brl(x.unit)} = ${brl(x.valor)}</strong>`).join('<br>')}</div>
     </div>`; }).join('')}
     ${k.flags.map(f => `<div class="alert ${f.blk ? 'w' : 'd'}"><div>${f.blk ? '<strong>Bloqueia a cobrança:</strong> ' : ''}${esc(f.msg)}</div></div>`).join('')}
     <div style="padding:12px 14px;background:var(--bg);border-radius:8px">Prévia da cobrança mensal: <strong class="num">${brl(k.total)}</strong><span class="hint"> · licenças ${brl(sumTipo(k, 'lic'))} · comodato ${brl(sumTipo(k, 'com'))}${k.aj ? ' · ajustes ' + brl(k.aj) : ''}</span></div>
    </section>
    ${ti ? `<section class="card pad stack" style="border-color:#CFC4EE">
     <h2>Teste gratuito</h2>
     <div class="grid g4" style="gap:12px">
      <label class="fld">Início<input id="t_ini" type="date" value="${c.trial.inicio}"></label>
      <label class="fld">Fim<input id="t_fim" type="date" value="${c.trial.fim}"></label>
      <label class="fld" style="grid-column:span 2">E-mail que recebe o aviso<input id="t_mail" value="${esc(c.trial.email)}"></label>
     </div>
     <div class="row" style="align-items:center"><span class="fld" style="margin-right:6px">Avisar quantos dias antes</span>${[15, 7, 5, 3, 1].map(d => `<button class="chip ${c.trial.avisos.includes(d) ? 'on' : ''}" data-av="${d}" aria-pressed="${c.trial.avisos.includes(d)}">${d} dia${d > 1 ? 's' : ''}</button>`).join('')}</div>
     <label class="fld" style="max-width:340px">Quando o teste terminar<select id="t_fimacao"><option value="cobrar" ${c.trial.aoFim === 'cobrar' ? 'selected' : ''}>Começar a cobrar automaticamente</option><option value="suspender" ${c.trial.aoFim === 'suspender' ? 'selected' : ''}>Suspender e avisar o comercial</option></select></label>
     <div>${ti.ag.map(a => `<div class="ln"><span>Aviso de ${a.d} dia${a.d > 1 ? 's' : ''} · ${dBR(a.em)}</span><span>${a.env ? `<span class="b ok">Enviado ${dShort(a.env)}</span>` : a.atrasado ? `<span class="b bad">Não enviado</span> <button class="link" data-send="${a.d}">enviar agora</button>` : `<span class="b mt">Programado</span>`}</span></div>`).join('')}</div>
     <div class="hint">Os avisos saem sozinhos por e-mail no dia programado. Regra de ${c.diasMin} dias: se o teste acabar e o cliente ficar ${c.diasMin}+ dias ativo dentro do período de apuração, cobra o mês cheio.</div>
    </section>` : ''}
    ${(() => { const inv = S.invoices.filter(i => i.cid === c.id).sort((a, b) => b.comp.localeCompare(a.comp)); return inv.length ? `<section class="card tbw"><div class="pad" style="padding-bottom:0"><h2>Cobranças</h2></div><table><thead><tr><th>Competência</th><th>Venc.</th><th class="r">Valor</th><th class="r">Recebido</th><th>Status</th><th>NF</th></tr></thead><tbody>${inv.map(i => `<tr><td>${compLabel(i.comp)}</td><td class="num">${dBR(i.venc)}</td><td class="r num">${nf2(i.valor)}</td><td class="r num">${i.pago ? nf2(i.pago) : '—'}</td><td><span class="b ${invStatus(i)[1]}">${invStatus(i)[0]}</span></td><td><span class="b ${NFTXT[i.nf][1]}">${NFTXT[i.nf][0]}</span></td></tr>`).join('')}</tbody></table></section>` : ''; })()}
   </div>
   <aside class="stack" style="width:380px;flex-shrink:0">
    <section class="card pad stack">
     <h2>Contrato</h2>
     <label class="fld">Nome<input id="e_name" value="${esc(c.name)}"></label>
     <label class="fld">CNPJ<input id="e_cnpj" value="${esc(c.cnpj)}"></label>
     <div class="grid g2" style="gap:12px">
      <label class="fld">Situação<select id="e_st">${[['ativo', 'Ativo'], ['teste', 'Em teste'], ['encerrado', 'Encerrado']].map(([a, b]) => `<option value="${a}" ${c.status === a ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
      <label class="fld">Canal<select id="e_can">${['Direto', 'Integrador'].map(x => `<option ${c.canal === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="fld">Dia de vencimento<input id="e_due" class="num" type="number" min="1" max="28" value="${c.due}"></label>
      <label class="fld" title="0 = cobra ao ativar (padrão do termo)">Mín. dias ativos p/ mês cheio<input id="e_dmin" class="num" type="number" min="0" max="30" value="${c.diasMin}"></label>
     </div>
     <label class="fld">E-mail financeiro<input id="e_mail" value="${esc(c.email)}"></label>
     <label class="rule" style="border:0;padding:0"><input type="checkbox" id="e_ind" ${c.indicado ? 'checked' : ''}><span><strong>Indicado por parceiro</strong><br><span class="hint">Cortesia dos ${v.cortesia || 0} primeiros dispositivos</span></span></label>
     <fieldset style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0;display:flex;flex-direction:column;gap:10px">
      <legend style="font-size:13px;font-weight:600;color:var(--ink2);padding:0 6px">Modo de faturamento</legend>
      <label style="display:flex;gap:10px;cursor:pointer"><input type="radio" name="e_mode" value="now" ${c.mode === 'now' ? 'checked' : ''} class="ck"><span><strong>Boleto + NF na emissão</strong></span></label>
      <label style="display:flex;gap:10px;cursor:pointer"><input type="radio" name="e_mode" value="later" ${c.mode === 'later' ? 'checked' : ''} class="ck"><span><strong>Só boleto</strong> — NF ao confirmar pagamento</span></label>
     </fieldset>
     <label class="fld">Bloqueio de cobrança<input id="e_blq" value="${esc(c.bloqueio)}" placeholder="vazio = sem bloqueio"></label>
    </section>
    <section class="card pad">
     <h2 style="margin-bottom:4px">Regras e ajustes</h2>
     ${Object.entries(RULES).map(([key, r]) => `<label class="rule"><input type="checkbox" data-rule="${key}" ${c.rules.includes(key) ? 'checked' : ''}><span><strong>${r.t}</strong> ${r.d}</span></label>`).join('')}
     <div class="hint" style="margin-top:6px">As regras ficam registradas no contrato; multa, juros e descontos são aplicados pelo provedor de boleto.</div>
     <div style="margin-top:10px">${c.ajustes.map((a, i) => `<div class="ln"><span>${esc(a.desc)}</span><span class="num">${brl(a.valor)} <button class="link del" data-rmaj="${i}">remover</button></span></div>`).join('') || '<div class="hint">Nenhum ajuste para a próxima cobrança.</div>'}</div>
     <div class="row" style="margin-top:10px"><label class="fld" style="flex:1">Ajuste<input id="aj_d" placeholder="Ex.: instalação 2 equip."></label><label class="fld" style="width:100px">Valor (±)<input id="aj_v" placeholder="300,00"></label><button class="btn" data-addaj>Adicionar</button></div>
    </section>
    <section class="card pad stack">
     <label class="fld">Motivo da alteração (obrigatório para salvar)<textarea id="e_why" placeholder="Ex.: renovação 24 meses com desconto por volume"></textarea></label>
     <div id="e_err" class="err"></div>
     <button class="btn pri" data-save>Salvar alterações</button>
    </section>
    <section class="card pad"><h2 style="margin-bottom:6px">Histórico</h2>${c.history.map(h => `<div class="ev"><strong>${esc(h.what)}</strong><small>${esc(h.when)} · ${esc(h.who)}${h.why ? ' · ' + esc(h.why) : ''}</small></div>`).join('') || '<div class="hint">Sem registros.</div>'}</section>
   </aside>
  </div>`;
  /* rascunho em memória: mudanças nas linhas recalculam a prévia na hora; só grava ao salvar */
  const draftLines = () => { el.querySelectorAll('[data-l]').forEach(i => { const L = c.linhas[+i.dataset.l], key = i.dataset.k; if (key === 'linha') L.linha = i.value; else if (key === 'comodatoPreco' || key === 'precoManual') L[key] = optNum(i.value); else L[key] = Math.max(0, parseInt(i.value, 10) || 0); }); };
  el._snap = el._snap || snapOf(c);
  el.querySelectorAll('[data-l]').forEach(i => i.addEventListener('change', () => { draftLines(); vClienteKeep(el); }));
  el.querySelector('[data-back]').addEventListener('click', () => { if (dirtyNow() && !confirm('Há alterações não salvas. Sair mesmo assim?')) return; go('clientes'); });
  el.querySelector('[data-cob]').addEventListener('click', () => { if (dirtyNow() && !confirm('Há alterações não salvas. Sair mesmo assim?')) return; fConc.q = c.name; fConc.comp = null; go('conciliacao'); });
  el.querySelector('[data-addl]').addEventListener('click', () => { draftLines(); const free = defs.find(d => !c.linhas.some(l => l.linha === d.id)); if (!free) { toast('Todas as linhas da tabela já estão no cliente.'); return; } c.linhas.push({ linha: free.id, ativos: 0, comodato: 0, comodatoPreco: null, precoManual: null, poucoUso: 0 }); vClienteKeep(el); });
  el.querySelectorAll('[data-rml]').forEach(b => b.addEventListener('click', () => { draftLines(); c.linhas.splice(+b.dataset.rml, 1); vClienteKeep(el); }));
  $('#e_tab', el).addEventListener('change', e => { draftLines(); c.tabela = e.target.value; c.versao = curVer(table(c.tabela)).v; vClienteKeep(el); });
  $('#e_ver', el).addEventListener('change', e => { draftLines(); c.versao = e.target.value; vClienteKeep(el); });
  el.querySelector('[data-dup]').addEventListener('click', () => {
    if (dirtyNow() && !confirm('Criar a tabela própria descarta as alterações não salvas. Continuar?')) return;
    act(() => api('POST', `/clients/${c.id}/own-table`), 'Tabela própria criada. Edite os preços em Tabelas de preço.');
  });
  el.querySelectorAll('[data-av]').forEach(b => b.addEventListener('click', () => { draftLines(); const d = +b.dataset.av, a = c.trial.avisos; a.includes(d) ? a.splice(a.indexOf(d), 1) : a.push(d); vClienteKeep(el); }));
  el.querySelectorAll('[data-send]').forEach(b => b.addEventListener('click', () => { if (dirtyNow()) { toast('Salve as alterações antes de enviar o aviso.'); return; } mailTrial(c, +b.dataset.send); }));
  const conv = el.querySelector('[data-conv]'); if (conv) conv.addEventListener('click', () => { $('#e_st').value = 'ativo'; $('#e_why').value = $('#e_why').value || 'Teste convertido em contrato'; toast('Situação alterada para Ativo. Confira e salve.'); });
  el.querySelectorAll('[data-rmaj]').forEach(b => b.addEventListener('click', () => { draftLines(); c.ajustes.splice(+b.dataset.rmaj, 1); vClienteKeep(el); }));
  el.querySelector('[data-addaj]').addEventListener('click', () => { draftLines(); const d = $('#aj_d').value.trim(), val = parseNum($('#aj_v').value); if (!d || isNaN(val)) { toast('Informe descrição e valor do ajuste.'); return; } c.ajustes.push({ desc: d, valor: val }); vClienteKeep(el); });
  el.querySelectorAll('[data-save]').forEach(btn => btn.addEventListener('click', () => {
    draftLines();
    const why = $('#e_why').value.trim(), errEl = $('#e_err'), err = m => { errEl.textContent = m; };
    const doc = { ...c, name: $('#e_name').value.trim(), cnpj: $('#e_cnpj').value.trim(), status: $('#e_st').value, canal: $('#e_can').value, due: parseInt($('#e_due').value, 10), diasMin: Math.max(0, parseInt($('#e_dmin').value, 10) || 0), email: $('#e_mail').value.trim(), indicado: $('#e_ind').checked, mode: el.querySelector('[name=e_mode]:checked').value, bloqueio: $('#e_blq').value.trim(), rules: [...el.querySelectorAll('[data-rule]:checked')].map(x => x.dataset.rule) };
    delete doc.history;
    if (c.trial) doc.trial = { ...c.trial, inicio: $('#t_ini') ? $('#t_ini').value : c.trial.inicio, fim: $('#t_fim') ? $('#t_fim').value : c.trial.fim, email: $('#t_mail') ? $('#t_mail').value.trim() : c.trial.email, aoFim: $('#t_fimacao') ? $('#t_fimacao').value : c.trial.aoFim };
    if (!why) { err('Escreva o motivo da alteração antes de salvar.'); $('#e_why').focus(); return; }
    act(() => api('PUT', `/clients/${c.id}`, { client: doc, why }), 'Alterações salvas.', errEl);
  }));
}
function vClienteKeep(el) {
  const ids = ['e_why', 'e_name', 'e_cnpj', 'e_st', 'e_due', 'e_dmin', 'e_mail', 'e_blq', 't_ini', 't_fim', 't_mail', 't_fimacao', 'aj_d', 'aj_v'];
  const keep = {}; ids.forEach(id => { const x = $('#' + id); if (x) keep[id] = x.value; });
  const ind = $('#e_ind')?.checked, mode = el.querySelector('[name=e_mode]:checked')?.value, can = $('#e_can')?.value;
  const rules = [...el.querySelectorAll('[data-rule]')].map(x => [x.dataset.rule, x.checked]);
  const snap = el._snap; vCliente(el); el._snap = snap;
  ids.forEach(id => { const x = $('#' + id); if (x && keep[id] !== undefined) x.value = keep[id]; });
  if ($('#e_ind')) $('#e_ind').checked = ind; if (can) $('#e_can').value = can;
  if (mode) { const r = el.querySelector(`[name=e_mode][value=${mode}]`); if (r) r.checked = true; }
  rules.forEach(([k, v]) => { const x = el.querySelector(`[data-rule="${k}"]`); if (x) x.checked = v; });
}

/* ===================== Tabelas de preço ===================== */
let selTab = null;
function vTabelas(el) {
  if (!el._orig) el._orig = JSON.stringify(S.tables);
  if (!selTab || !table(selTab.id)) selTab = { id: S.tables[0].id, v: curVer(S.tables[0]).v };
  const t = table(selTab.id); let v = t.versoes.find(x => x.v === selTab.v) || curVer(t); selTab.v = v.v;
  const isCur = v.v === curVer(t).v, ro = t.padrao && !isCur;
  const using = S.clients.filter(c => c.tabela === t.id && (c.versao === v.v || (!t.padrao)));
  el.innerHTML = `
  <header class="pg"><div><div class="sub">Base do Termo de Aquisição · use a padrão ou crie uma por cliente</div><h1>Tabelas de preço</h1></div></header>
  <div class="split">
   <aside class="stack" style="width:290px;flex-shrink:0">
    <section class="card" style="padding:8px"><div class="tlist">
     ${S.tables.map(x => `<button class="${x.id === t.id ? 'on' : ''}" data-t="${x.id}"><div style="font-weight:600">${esc(x.nome)}</div><div class="sub">${x.padrao ? 'Atual: ' + esc(curVer(x).v) + ' · ' + x.versoes.length + ' versões' : 'Própria'} · ${S.clients.filter(c => c.tabela === x.id).length} cliente(s)</div></button>`).join('')}
    </div></section>
    <section class="card pad stack">
     <h2>Regras gerais de faturamento</h2>
     <div class="grid g2" style="gap:10px">
      <label class="fld">Apuração começa dia<input id="g_ini" class="num" type="number" min="1" max="28" value="${S.cfg.inicio}"></label>
      <label class="fld">Vencimento padrão<input id="g_ven" class="num" type="number" min="1" max="28" value="${S.cfg.venc}"></label>
      <label class="fld">Envio de<input id="g_e1" class="num" type="number" min="1" max="28" value="${S.cfg.envioDe}"></label>
      <label class="fld">até<input id="g_e2" class="num" type="number" min="1" max="28" value="${S.cfg.envioAte}"></label>
      <label class="fld">Mín. dias ativos<input id="g_dm" class="num" type="number" min="0" max="30" value="${S.cfg.diasMin}"></label>
      <label class="fld">Dias de teste<input id="g_td" class="num" type="number" min="1" max="90" value="${S.cfg.trialDias}"></label>
     </div>
     <label class="fld">E-mail do financeiro (responde clientes)<input id="g_ef" value="${esc(S.cfg.emailFinanceiro || '')}"></label>
     <label class="fld">E-mail do comercial (fim de teste)<input id="g_ec" value="${esc(S.cfg.emailComercial || '')}" placeholder="vazio = financeiro"></label>
     <div class="hint">Período de apuração atual: ${dBR(periodo(S.competencia).ini)} a ${dBR(periodo(S.competencia).fim)}. Valem para clientes novos; os existentes mantêm o que está no contrato.</div>
     <div id="g_err" class="err"></div>
     <button class="btn" data-gsave>Salvar regras gerais</button>
    </section>
   </aside>
   <section class="card pad stack grow">
    <div class="row" style="justify-content:space-between;align-items:flex-end">
     <div><h2>${esc(t.nome)}</h2><div class="sub">${t.padrao ? `Versão ${esc(v.v)} de ${esc(v.data)}${isCur ? ' · atual' : ' · antiga, só consulta'}` : 'Tabela própria'} · ${using.length} cliente(s) nesta ${t.padrao ? 'versão' : 'tabela'}</div></div>
     <div class="row">${t.padrao ? `<label class="fld" style="width:150px">Versão<select id="t_v">${t.versoes.map(x => `<option ${x.v === v.v ? 'selected' : ''}>${esc(x.v)}</option>`).join('')}</select></label>` : ''}
      <button class="btn" data-copy>Duplicar</button>${t.padrao ? `<button class="btn pri" data-newv ${isCur ? '' : 'disabled'}>Salvar como nova versão</button>` : `<button class="btn pri" data-savet>Salvar tabela</button>`}</div>
    </div>
    ${t.padrao ? '<div class="alert d"><div>Alterar a tabela padrão cria uma <strong>nova versão</strong>. Clientes atuais continuam na versão que assinaram até você migrá-los — preço não muda sozinho.</div></div>' : `<div class="alert w"><div>Tabela própria: salvar altera o preço de <strong>${using.length} cliente(s)</strong> já na próxima cobrança.</div></div>`}
    <div class="grid g3" style="gap:12px">
     <label class="fld">Faixa calculada por<select id="t_base" ${ro ? 'disabled' : ''}><option value="linha" ${v.faixaBase === 'linha' ? 'selected' : ''}>Quantidade da linha</option><option value="total" ${v.faixaBase === 'total' ? 'selected' : ''}>Total do cliente</option></select></label>
     <label class="fld">Como aplica a faixa<select id="t_modo" ${ro ? 'disabled' : ''}><option value="volume" ${v.modo === 'volume' ? 'selected' : ''}>Preço da faixa em todas as unidades</option><option value="escalonado" ${v.modo === 'escalonado' ? 'selected' : ''}>Escalonado (cada faixa no seu preço)</option></select></label>
     <label class="fld">Cortesia para indicados<input id="t_cort" class="num" type="number" min="0" value="${v.cortesia || 0}" ${ro ? 'disabled' : ''}></label>
    </div>
    ${v.linhas.map((l, i) => `<div class="lineblk">
      <div class="row" style="justify-content:space-between;align-items:flex-end">
       <label class="fld" style="flex:1;min-width:220px">Linha de equipamento<input class="inp" data-ln="${i}" value="${esc(l.nome)}" ${ro ? 'disabled' : ''}></label>
       <label class="fld" style="width:150px">Comodato R$/un. padrão<input class="inp num" data-cp="${i}" value="${l.comodatoPreco != null ? nf2(l.comodatoPreco) : ''}" placeholder="definir" ${ro ? 'disabled' : ''}></label>
       ${ro ? '' : `<button class="link del" data-rmline="${i}">remover linha</button>`}
      </div>
      <div class="tbw" style="margin-top:10px"><table><thead><tr><th>Faixa</th><th>Até (${esc(l.unid)}s)</th><th>R$ por ${esc(l.unid)}</th><th></th></tr></thead><tbody>
       ${l.faixas.map((f, j) => `<tr><td class="sub">${j === 0 ? '1' : (l.faixas[j - 1].ate + 1).toLocaleString('pt-BR')} a ${f.ate.toLocaleString('pt-BR')}</td><td><input class="inp sm num" style="max-width:120px" data-fa="${i}-${j}" value="${f.ate}" ${ro ? 'disabled' : ''}></td><td><input class="inp sm num" style="max-width:120px" data-fp="${i}-${j}" value="${nf2(f.preco)}" ${ro ? 'disabled' : ''}></td><td class="r">${ro ? '' : `<button class="link del" data-rmf="${i}-${j}">remover</button>`}</td></tr>`).join('')}
      </tbody></table></div>
      ${ro ? '' : `<button class="link" data-addf="${i}">+ faixa</button>`}
     </div>`).join('')}
    ${ro ? '' : '<div><button class="btn" data-addline>+ Linha de equipamento</button></div>'}
    <div id="t_err" class="err"></div>
    ${using.length ? `<div><h3 style="margin:6px 0">Clientes nesta ${t.padrao ? 'versão' : 'tabela'}</h3><div class="hint">${using.map(c => esc(c.name)).join(', ')}</div>${ro ? `<button class="btn sm" style="margin-top:8px" data-migr>Migrar todos para ${esc(curVer(t).v)}</button>` : ''}</div>` : ''}
   </section>
  </div>`;
  const readT = () => {
    const L = clone(v.linhas);
    el.querySelectorAll('[data-ln]').forEach(x => L[+x.dataset.ln].nome = x.value.trim() || L[+x.dataset.ln].nome);
    el.querySelectorAll('[data-cp]').forEach(x => L[+x.dataset.cp].comodatoPreco = optNum(x.value));
    el.querySelectorAll('[data-fa]').forEach(x => { const [i, j] = x.dataset.fa.split('-').map(Number); L[i].faixas[j].ate = parseInt(String(x.value).replace(/\D/g, ''), 10); });
    el.querySelectorAll('[data-fp]').forEach(x => { const [i, j] = x.dataset.fp.split('-').map(Number); L[i].faixas[j].preco = parseNum(x.value); });
    return { faixaBase: $('#t_base').value, modo: $('#t_modo').value, cortesia: parseInt($('#t_cort').value, 10) || 0, linhas: L };
  };
  const live = fn => () => { const d = readT(); Object.assign(v, d); fn(); vTabelas(el); };
  const discard = () => { S.tables = JSON.parse(el._orig); el._orig = null; };
  el.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => { discard(); selTab = { id: b.dataset.t, v: curVer(table(b.dataset.t)).v }; vTabelas(el); }));
  const tv = $('#t_v', el); if (tv) tv.addEventListener('change', () => { discard(); selTab.v = tv.value; vTabelas(el); });
  el.querySelectorAll('[data-addf]').forEach(b => b.addEventListener('click', live(() => { const l = v.linhas[+b.dataset.addf]; const last = l.faixas[l.faixas.length - 1]; l.faixas.push({ ate: (last ? last.ate * 2 : 100), preco: last ? last.preco : 0 }); })));
  el.querySelectorAll('[data-rmf]').forEach(b => b.addEventListener('click', live(() => { const [i, j] = b.dataset.rmf.split('-').map(Number); v.linhas[i].faixas.splice(j, 1); })));
  el.querySelectorAll('[data-rmline]').forEach(b => b.addEventListener('click', live(() => { const l = v.linhas[+b.dataset.rmline]; if (S.clients.some(c => c.tabela === t.id && c.versao === v.v && c.linhas.some(x => x.linha === l.id))) { toast('Há clientes usando esta linha. Mude os clientes antes de remover.'); return; } v.linhas.splice(+b.dataset.rmline, 1); })));
  const al = el.querySelector('[data-addline]'); if (al) al.addEventListener('click', live(() => { v.linhas.push({ id: 'l' + Date.now().toString(36), nome: 'Nova linha', unid: 'dispositivo', faixas: [{ ate: 100, preco: 0 }], comodatoPreco: null }); }));
  const valid = d => Domain.validTableVersion(d);
  const nv = el.querySelector('[data-newv]'); if (nv) nv.addEventListener('click', () => {
    const d = readT(), e = valid(d); if (e) { $('#t_err').textContent = e; return; }
    const sug = v.v.replace(/(\d+)$/, m => String(+m + 1)); const nome = prompt('Nome da nova versão', sug); if (!nome) return;
    act(async () => { const r = await api('POST', `/tables/${t.id}/versions`, { nome: nome.trim(), versao: d }); selTab.v = nome.trim(); return r; }, `Versão ${nome} criada. Clientes novos já usam ela; os atuais continuam na versão deles.`, $('#t_err'));
  });
  const st = el.querySelector('[data-savet]'); if (st) st.addEventListener('click', () => {
    const d = readT(), e = valid(d); if (e) { $('#t_err').textContent = e; return; }
    act(() => api('PUT', `/tables/${t.id}`, { versao: d }), 'Tabela salva.', $('#t_err'));
  });
  el.querySelector('[data-copy]').addEventListener('click', () => {
    const d = readT(); const nome = prompt('Nome da nova tabela', 'Personalizada — '); if (!nome) return;
    act(async () => { const r = await api('POST', '/tables', { nome: nome.trim(), versao: d }); selTab = { id: r.id, v: 'v1' }; return r; }, 'Tabela duplicada. Vincule clientes a ela na tela do cliente.', $('#t_err'));
  });
  const mg = el.querySelector('[data-migr]'); if (mg) mg.addEventListener('click', () => {
    if (!confirm(`Migrar ${using.length} cliente(s) para ${curVer(t).v}? O preço deles muda na próxima cobrança.`)) return;
    act(() => api('POST', `/tables/${t.id}/migrate`, { from: v.v }), r => `${r.migrated} cliente(s) migrado(s).`);
  });
  el.querySelector('[data-gsave]').addEventListener('click', () => {
    const g = id => parseInt($(id).value, 10);
    act(() => api('PUT', '/config', { cfg: { inicio: g('#g_ini'), venc: g('#g_ven'), envioDe: g('#g_e1'), envioAte: g('#g_e2'), diasMin: g('#g_dm'), trialDias: g('#g_td'), emailFinanceiro: $('#g_ef').value, emailComercial: $('#g_ec').value } }), 'Regras gerais salvas.', $('#g_err'));
  });
}

/* ===================== Importação ===================== */
let imp = null;
function vImportar(el) {
  if (!imp) {
    el.innerHTML = `
    <header class="pg"><div><div class="sub">Uma linha por cliente e equipamento: cliente, cnpj, linha, ativos, comodato, abaixo_dias_min, preco_licenca (opcional)</div><h1>Importar planilha</h1></div><button class="btn" data-tpl>Baixar modelo da planilha</button></header>
    <div class="steps"><span class="on"><span class="dot">1</span>Enviar arquivo</span><span><span class="dot">2</span>Revisar diferenças</span><span><span class="dot">3</span>Confirmar</span></div>
    <label class="drop" style="cursor:pointer;display:block"><div style="font-size:16px;font-weight:600">Escolha a planilha (.xlsx ou .csv)</div><div class="hint" style="margin-top:6px">Use para a carga inicial ou para atualizar quantidades enquanto a sincronização com a plataforma não existe.</div><input type="file" id="fl" accept=".xlsx,.xls,.csv" style="margin-top:16px"></label>
    <div class="hint">Linhas aceitas: ${[...allLineDefs()].map(([id, n]) => `<span class="num">${esc(id)}</span> (${esc(n)})`).join(', ')}. Preço negociado no sistema nunca é sobrescrito sem confirmação.</div>`;
    el.querySelector('[data-tpl]').addEventListener('click', () => download('modelo_dispositivos.csv', [['cliente', 'cnpj', 'linha', 'ativos', 'comodato', 'abaixo_dias_min', 'preco_licenca'], ...S.clients.flatMap(c => c.linhas.map(l => [c.name, c.cnpj, l.linha, l.ativos, l.comodato, l.poucoUso || 0, l.precoManual != null ? nf2(l.precoManual) : '']))]));
    $('#fl', el).addEventListener('change', e => readFile(e.target.files[0], el));
    return;
  }
  const cnt = k => imp.rows.filter(r => r.kind === k).length, valid = imp.rows.filter(r => !['erro', 'igual'].includes(r.kind)).length;
  el.innerHTML = `
  <header class="pg"><div><div class="sub">Arquivo: ${esc(imp.file)} · ${imp.rows.length} linhas</div><h1>Importar planilha</h1></div><button class="btn" data-cancel>Escolher outro arquivo</button></header>
  <div class="steps"><span class="dn"><span class="dot">✓</span>Enviar arquivo</span><span class="on"><span class="dot">2</span>Revisar diferenças</span><span><span class="dot">3</span>Confirmar</span></div>
  <div class="grid g5">
   <div class="card kpi"><div class="k">Novos</div><div class="v num">${cnt('novo')}</div></div>
   <div class="card kpi"><div class="k">Alterados</div><div class="v num">${cnt('alterado')}</div></div>
   <div class="card kpi"><div class="k">Sem mudança</div><div class="v num">${cnt('igual')}</div></div>
   <div class="card kpi" style="border-color:#F0B8AA"><div class="k" style="color:var(--bf)">Com erro</div><div class="v num" style="color:var(--bf)">${cnt('erro')}</div></div>
   <div class="card kpi" style="border-color:#EBC98A"><div class="k" style="color:var(--wf)">Conflito com negociação</div><div class="v num" style="color:var(--wf)">${cnt('conflito')}</div></div>
  </div>
  <div class="card tbw"><table><thead><tr><th>Cliente</th><th>Linha</th><th>O que muda</th><th>Situação</th><th>Ação</th></tr></thead><tbody>
  ${imp.rows.map((r, idx) => r.kind === 'igual' ? '' : `<tr><td style="font-weight:600">${esc(r.name || '(sem nome)')}</td><td>${esc(r.linha || '—')}</td><td>${r.changes.map(esc).join('<br>') || '—'}</td>
   <td><span class="b ${({ novo: 'ok', alterado: 'info', erro: 'bad', conflito: 'warn' })[r.kind]}">${({ novo: 'Novo', alterado: 'Alterado', erro: 'Erro', conflito: 'Conflito' })[r.kind]}</span></td>
   <td>${r.kind === 'conflito' ? `<select class="inp sm" data-dec="${idx}"><option value="keep">Manter negociado</option><option value="use" ${imp.dec[idx] === 'use' ? 'selected' : ''}>Usar planilha</option></select>` : r.kind === 'erro' ? 'Ignorar linha' : r.kind === 'novo' ? (r.cid ? 'Adicionar linha ao cliente' : 'Criar cliente · tabela padrão') : 'Atualizar'}</td></tr>`).join('')}
  </tbody></table></div>
  <div class="row" style="justify-content:flex-end"><button class="btn" data-cancel>Cancelar</button><button class="btn pri" data-apply ${valid ? '' : 'disabled'}>Importar ${valid} linha${valid !== 1 ? 's' : ''}</button></div>`;
  el.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => { imp = null; vImportar(el); }));
  el.querySelectorAll('[data-dec]').forEach(s => s.addEventListener('change', () => { imp.dec[s.dataset.dec] = s.value; }));
  el.querySelector('[data-apply]').addEventListener('click', async () => {
    const cur = imp; imp = null;
    const r = await act(() => api('POST', '/import/apply', { rows: cur.raw, decisions: cur.dec, file: cur.file }), r => `${r.imported} linha${r.imported !== 1 ? 's' : ''} importada${r.imported !== 1 ? 's' : ''}.`);
    if (r) go('clientes'); else { imp = cur; vImportar(el); }
  });
}
function readFile(file, el) {
  if (!file) return;
  const done = async rows => {
    try { const diff = await api('POST', '/import/preview', { rows }); imp = { file: file.name, raw: rows, rows: diff, dec: {} }; vImportar(el); }
    catch (e) { toast(e.message); }
  };
  const rd = new FileReader();
  if (/\.csv$/i.test(file.name)) {
    rd.onload = () => { const txt = String(rd.result).replace(/^﻿/, ''); const sep = (txt.split('\n')[0].match(/;/g) || []).length ? ';' : ','; const lines = txt.split(/\r?\n/).filter(Boolean); const h = lines.shift().split(sep).map(x => x.trim().toLowerCase()); done(lines.map(l => { const v = l.split(sep); const o = {}; h.forEach((k, i) => o[k] = (v[i] || '').replace(/^"|"$/g, '').trim()); return o; })); };
    rd.readAsText(file, 'utf-8');
  } else {
    if (typeof XLSX === 'undefined') { toast('Para ler .xlsx é preciso estar conectado à internet. Salve como .csv e tente de novo.'); return; }
    rd.onload = () => { const wb = XLSX.read(rd.result, { type: 'array' }); const ws = wb.Sheets[wb.SheetNames[0]]; done(XLSX.utils.sheet_to_json(ws, { defval: '' }).map(o => { const n = {}; Object.keys(o).forEach(k => n[k.trim().toLowerCase()] = o[k]); return n; })); };
    rd.readAsArrayBuffer(file);
  }
}

/* ===================== Cobrança ===================== */
let selCob = null;
function vCobranca(el) {
  const comp = S.competencia, P = periodo(comp), already = S.sentComp.includes(comp);
  const rows = S.clients.map(c => ({ c, k: calc(c), st: billState(c, comp) }));
  const billable = rows.filter(r => !r.st.skip && !r.st.blocked);
  if (!selCob || selCob.comp !== comp) selCob = { comp, ids: new Set(billable.map(r => r.c.id)) };
  [...selCob.ids].forEach(id => { if (!billable.some(r => r.c.id === id)) selCob.ids.delete(id); });
  const sel = billable.filter(r => selCob.ids.has(r.c.id));
  const tot = sel.reduce((s, r) => s + r.k.total, 0), totCom = sel.reduce((s, r) => s + sumTipo(r.k, 'com'), 0), nNow = sel.filter(r => r.c.mode === 'now').length;
  el.innerHTML = `
  <header class="pg"><div><div class="sub">Apuração ${dBR(P.ini)} a ${dBR(P.fim)} · envio ${P.envio} · vencimento no mês seguinte</div><h1>Cobrança de ${compLabel(comp)}</h1></div>
   <div class="sub">Já enviadas: ${S.sentComp.map(compLabel).join(', ') || 'nenhuma'}</div></header>
  ${already ? `<div class="alert o"><div><strong>Cobranças de ${compLabel(comp)} já enviadas.</strong>${billable.length ? ` Ainda dá para enviar ${billable.length} pendente(s) abaixo.` : ''}</div><button class="btn sm" data-next>Preparar ${compLabel(nextComp(comp))}</button></div>` : ''}
  <div class="split">
   <div class="card tbw grow"><table>
    <thead><tr><th><input type="checkbox" class="ck" id="all" aria-label="Selecionar todos" ${billable.length ? '' : 'disabled'} ${sel.length === billable.length && billable.length ? 'checked' : ''}></th><th>Cliente</th><th class="r">Ativos</th><th>Composição</th><th class="r">Licenças</th><th class="r">Comodato</th><th class="r">Ajustes</th><th class="r">Total</th><th>Envio</th><th>Status</th></tr></thead>
    <tbody>${rows.map(({ c, k, st }) => { const lv = sumTipo(k, 'lic'), cv = sumTipo(k, 'com'); const off = st.skip || st.blocked; const sent = st.sent && S.invoices.find(i => i.cid === c.id && i.comp === comp);
     return `<tr style="${st.blocked ? 'background:#FFF6F3' : st.skip && !st.sent ? 'background:#F8F7FC' : ''}">
     <td><input type="checkbox" class="ck" data-sel="${c.id}" aria-label="Selecionar ${esc(c.name)}" ${off ? 'disabled' : ''} ${!off && selCob.ids.has(c.id) ? 'checked' : ''}></td>
     <td><div style="font-weight:600">${esc(c.name)}</div><div class="sub">${esc(k.tabela.replace('Personalizada — ', 'Pers. '))} ${esc(k.versao)}</div></td>
     <td class="r num">${k.devices}</td>
     <td class="brk">${k.items.map(x => `${esc(x.nome)}: ${x.tipo === 'com' ? 'comodato ' : ''}${x.qtd} × ${nf2(x.unit)}`).join('<br>')}${k.pouco ? `<br>${k.pouco} abaixo de ${c.diasMin} dias, sem cobrança` : ''}${k.free ? `<br>${k.free} em cortesia` : ''}</td>
     <td class="r num">${off && st.skip && !sent ? '—' : nf2(lv)}</td><td class="r num">${off && st.skip && !sent ? '—' : (cv ? nf2(cv) : '—')}</td><td class="r num">${k.aj && !st.skip ? nf2(k.aj) : '—'}</td>
     <td class="r num" style="font-weight:600">${sent ? nf2(sent.valor) : off ? '—' : nf2(k.total)}</td>
     <td><span class="b ${c.mode === 'now' ? 'info' : 'warn'}">${c.mode === 'now' ? 'Boleto + NF' : 'Só boleto'}</span></td>
     <td>${st.skip ? `<span class="b ${st.cls}" title="${esc(st.txt)}">${st.sent ? 'Enviada' : esc(st.txt.length > 34 ? st.txt.slice(0, 32) + '…' : st.txt)}</span>` : st.blocked ? `<button class="b bad" style="border:0;cursor:pointer" data-open="${c.id}" title="${esc(st.txt)}">Bloqueada — ver</button>` : '<span class="b ok">Pronto</span>'}</td></tr>`; }).join('') || '<tr><td colspan="10" class="hint" style="padding:24px">Nenhum cliente cadastrado.</td></tr>'}</tbody>
   </table></div>
   <aside class="card pad" style="width:320px;flex-shrink:0">
    <div style="font-weight:600;margin-bottom:6px">Resumo do envio</div>
    <div class="ln"><span>Cobranças selecionadas</span><strong class="num">${sel.length}</strong></div>
    <div class="ln"><span>Valor total</span><strong class="num">${brl(tot)}</strong></div>
    <div class="ln"><span>· dos quais comodato</span><strong class="num">${brl(totCom)}</strong></div>
    <div class="ln"><span>NF emitida agora</span><strong class="num">${nNow}</strong></div>
    <div class="ln"><span>NF após pagamento</span><strong class="num">${sel.length - nNow}</strong></div>
    <div class="ln"><span>Já enviadas nesta competência</span><strong class="num">${rows.filter(r => r.st.sent).length}</strong></div>
    <div class="ln"><span>Fora (teste/encerrado)</span><strong class="num">${rows.filter(r => r.st.skip && !r.st.sent).length}</strong></div>
    <div class="ln" style="border:0"><span>Bloqueadas p/ revisão</span><strong class="num" style="color:var(--bf)">${rows.filter(r => r.st.blocked).length}</strong></div>
    <p class="hint">Cada cliente recebe por e-mail a cobrança com o relatório de dispositivos ativos, receita apurada e vencimento, como prevê o termo.</p>
    <button class="btn pri" style="width:100%;min-height:50px;font-size:15px" data-send ${!sel.length ? 'disabled' : ''}>Gerar e enviar cobranças</button>
    <button class="btn" style="width:100%;margin-top:8px" data-xls>Baixar pré-fatura</button>
   </aside>
  </div>`;
  el.querySelectorAll('[data-sel]').forEach(b => b.addEventListener('change', () => { b.checked ? selCob.ids.add(b.dataset.sel) : selCob.ids.delete(b.dataset.sel); vCobranca(el); }));
  const all = $('#all', el); if (all) all.addEventListener('change', () => { selCob.ids = new Set(all.checked ? billable.map(r => r.c.id) : []); vCobranca(el); });
  el.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => go('cliente', b.dataset.open)));
  const nx = el.querySelector('[data-next]'); if (nx) nx.addEventListener('click', () => { if (billable.length && !confirm(`Ainda há ${billable.length} cobrança(s) prontas não enviadas em ${compLabel(comp)}. Abrir a próxima competência mesmo assim?`)) return; selCob = null; act(() => api('POST', '/billing/next'), r => `Competência ${compLabel(r.competencia)} aberta.`); });
  el.querySelector('[data-xls]').addEventListener('click', () => fetchFile('/api/billing/prefatura.csv'));
  el.querySelector('[data-send]').addEventListener('click', () => {
    modal(`<h2>Confirmar envio?</h2><p style="margin:0;line-height:1.55;color:var(--ink2)">Você vai enviar <strong>${sel.length} cobrança${sel.length !== 1 ? 's' : ''}</strong> no total de <strong class="num">${brl(tot)}</strong> (${brl(totCom)} de comodato). <strong>${nNow}</strong> NF${nNow !== 1 ? 's' : ''} sai${nNow !== 1 ? 'em' : ''} agora; ${sel.length - nNow} só depois do pagamento.</p>${todayISO() <= P.fim ? `<div class="alert w"><div><strong>A apuração só termina em ${dBR(P.fim)}.</strong> As quantidades ainda podem mudar até lá.</div></div>` : ''}<p class="hint" style="margin:0">Não dá para desfazer. Cancelar depois exige estornar boleto e NF.</p>
    <div id="serr" class="err"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn" data-x>Cancelar</button><button class="btn pri" data-ok>Confirmar envio</button></div>`, m => {
      m.querySelector('[data-x]').addEventListener('click', closeModal);
      m.querySelector('[data-ok]').addEventListener('click', async e => {
        e.target.disabled = true;
        const r = await act(() => api('POST', '/billing/send', { comp, ids: sel.map(x => x.c.id) }), null, $('#serr'));
        if (!r) { e.target.disabled = false; return; }
        selCob = null;
        modal(`<h2>${r.created} cobrança${r.created !== 1 ? 's' : ''} emitida${r.created !== 1 ? 's' : ''}</h2><p style="margin:0">Total <strong class="num">${brl(r.total)}</strong> · ${r.nfNow} NF agora, ${r.created - r.nfNow} após pagamento.</p>
          ${r.errors.length ? `<div class="alert w" style="display:block"><strong>Atenção:</strong><ul style="margin:6px 0 0;padding-left:18px">${r.errors.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
          <div class="row" style="justify-content:flex-end"><button class="btn pri" data-x>Fechar</button></div>`, mm => mm.querySelector('[data-x]').addEventListener('click', closeModal));
      });
    });
  });
}

/* ===================== Conciliação ===================== */
let fConc = { tab: 'todos', q: '', comp: null };
function vConciliacao(el) {
  const comps = [...new Set(S.invoices.map(i => i.comp))].sort().reverse();
  const um = S.unmatched;
  if (comps.length && (!fConc.comp || !comps.includes(fConc.comp))) fConc.comp = comps.find(c => S.invoices.some(i => i.comp === c && daysLate(i) > 0)) || comps[0];
  const head = `<header class="pg"><div><div class="sub">Importe o extrato do banco (OFX ou CSV) · baixa automática quando o valor bate</div><h1>Conciliação${comps.length ? ' de ' + compLabel(fConc.comp) : ''}</h1></div>
   <div class="row">${comps.length ? `<label class="fld" style="width:200px">Competência<select id="cc">${comps.map(c => `<option value="${c}" ${c === fConc.comp ? 'selected' : ''}>${compLabel(c)}</option>`).join('')}</select></label>
   <label class="fld" style="width:220px">Cliente<input id="cq" value="${esc(fConc.q)}" placeholder="Filtrar por nome"></label>` : ''}<label class="btn" style="cursor:pointer">Importar extrato<input type="file" id="ofx" accept=".ofx,.csv,.txt" hidden></label>${comps.length ? '<button class="btn" data-exp>Exportar</button>' : ''}</div></header>`;
  const unHtml = um.map(u => `<div class="alert d"><div><strong>Entrada não identificada:</strong> <span class="num">${brl(u.valor)}</span> em ${dBR(u.data)} — pagador “${esc(u.pagador || u.memo || '—')}”.</div><div class="row" style="align-items:center"><select class="inp sm" style="width:220px" data-ucli="${u.id}"><option value="">Escolha o cliente…</option>${S.clients.map(c => `<option value="${c.id}" ${c.id === u.sug ? 'selected' : ''}>${esc(c.name)}${c.id === u.sug ? ' (sugestão)' : ''}</option>`).join('')}</select><button class="btn sm" data-ign="${u.id}">Descartar</button><button class="btn pri sm" data-lnk="${u.id}">Confirmar vínculo</button></div></div>`).join('');
  if (!comps.length) {
    el.innerHTML = head + unHtml + '<div class="card pad hint">Nenhuma cobrança emitida ainda. Elas aparecem aqui depois do envio em “Cobrança do mês”.</div>';
    bindBank(el); return;
  }
  const all = S.invoices.filter(i => i.comp === fConc.comp);
  const fat = all.reduce((s, i) => s + i.valor, 0), rec = all.reduce((s, i) => s + Math.min(i.pago, i.valor), 0);
  const venc = all.filter(i => !isPaid(i) && (daysLate(i) > 0 || i.pago > 0)), vv = venc.reduce((s, i) => s + (i.valor - i.pago), 0);
  const nfp = all.filter(i => i.nf === 'aguardando' || i.nf === 'retida').length, nfErr = all.filter(i => i.nf === 'erro' || !i.boletoRef).length;
  const tabs = { todos: all, pagos: all.filter(isPaid), parciais: all.filter(i => i.pago > 0 && !isPaid(i)), vencidos: all.filter(i => i.pago === 0 && daysLate(i) > 0), aberto: all.filter(i => i.pago === 0 && daysLate(i) === 0) };
  const list = tabs[fConc.tab].filter(i => !fConc.q || client(i.cid)?.name.toLowerCase().includes(fConc.q.toLowerCase())).sort((a, b) => (b.valor - b.pago > 0.005) - (a.valor - a.pago > 0.005) || a.venc.localeCompare(b.venc));
  el.innerHTML = head + `
  <div class="grid g4">
   <div class="card kpi"><div class="k">Faturado</div><div class="v num">${brl(fat)}</div></div>
   <div class="card kpi"><div class="k">Recebido</div><div class="v num" style="color:var(--okf)">${brl(rec)}</div><div class="s">${fat ? pct(rec / fat) : '0%'} do faturado</div></div>
   <div class="card kpi"><div class="k">Vencido</div><div class="v num" style="color:var(--bf)">${brl(vv)}</div><div class="s">${venc.length} cobrança${venc.length !== 1 ? 's' : ''}</div></div>
   <div class="card kpi"><div class="k">NF aguardando pagamento</div><div class="v num">${nfp}</div><div class="s">${nfErr ? `<span style="color:var(--bf);font-weight:600">${nfErr} com falha no boleto/NF</span>` : 'emitem sozinhas ao pagar'}</div></div>
  </div>
  ${unHtml}
  <div class="tabs" role="tablist">${[['todos', 'Todos'], ['pagos', 'Pagos'], ['parciais', 'Parciais'], ['vencidos', 'Vencidos'], ['aberto', 'Em aberto']].map(([k, t]) => `<button class="tab ${fConc.tab === k ? 'on' : ''}" role="tab" aria-selected="${fConc.tab === k}" data-tab="${k}">${t} (${tabs[k].length})</button>`).join('')}</div>
  <div class="card tbw"><table>
   <thead><tr><th>Cliente</th><th>Venc.</th><th class="r">Cobrado</th><th>Pago em</th><th class="r">Recebido</th><th class="r">Diferença</th><th>Status</th><th>Nota fiscal</th><th></th></tr></thead>
   <tbody>${list.map(i => { const c = client(i.cid), st = invStatus(i), nfx = NFTXT[i.nf], dif = i.pago - i.valor; return `<tr style="${st[1] === 'bad' ? 'background:#FFF6F3' : st[1] === 'warn' ? 'background:#FFFBF3' : ''}">
    <td style="font-weight:600">${esc(c?.name || '—')}${i.boletoRef ? `<div class="sub num" style="font-weight:400">${i.boletoUrl ? `<a class="link" href="${esc(i.boletoUrl)}" target="_blank" rel="noopener">boleto</a>` : esc(i.boletoRef)}${i.nfUrl ? ` · <a class="link" href="${esc(i.nfUrl)}" target="_blank" rel="noopener">NF</a>` : ''}</div>` : ''}</td><td class="num">${dShort(i.venc)}</td><td class="r num">${nf2(i.valor)}</td><td class="num">${i.pagoEm ? dShort(i.pagoEm) : '—'}</td>
    <td class="r num">${i.pago ? nf2(i.pago) : '—'}</td><td class="r num" style="${dif < -0.005 ? 'color:var(--bf);font-weight:600' : 'color:var(--mut)'}">${dif < -0.005 ? '−' + nf2(-dif) : '—'}</td>
    <td><span class="b ${st[1]}">${st[0]}</span></td><td><span class="b ${nfx[1]}" ${i.nfRef ? `title="${esc(i.nfRef)}"` : ''}>${nfx[0]}</span></td>
    <td class="r" style="white-space:nowrap">${!i.boletoRef || i.nf === 'erro' ? `<button class="btn sm pri" data-prov="${i.id}">Gerar ${!i.boletoRef ? 'boleto' : 'NF'}</button> ` : ''}${!isPaid(i) ? `<button class="btn sm" data-pay="${i.id}">Registrar pagamento</button> ${daysLate(i) > 0 ? `<button class="btn sm" data-rem="${i.id}">Lembrete</button>` : ''}` : ''}</td></tr>`; }).join('') || '<tr><td colspan="9" class="hint" style="padding:24px">Nada nesta aba.</td></tr>'}</tbody>
  </table></div>`;
  $('#cc', el).addEventListener('change', e => { fConc.comp = e.target.value; vConciliacao(el); });
  $('#cq', el).addEventListener('input', e => { fConc.q = e.target.value; const p = e.target.selectionStart; vConciliacao(el); const i = $('#cq', el); i.focus(); i.setSelectionRange(p, p); });
  el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { fConc.tab = b.dataset.tab; vConciliacao(el); }));
  el.querySelectorAll('[data-rem]').forEach(b => b.addEventListener('click', () => { const i = S.invoices.find(x => x.id === b.dataset.rem); act(() => api('POST', `/invoices/${i.id}/reminder`), r => `Lembrete enviado para ${client(i.cid).name}${simNote(r)}.`); }));
  el.querySelectorAll('[data-prov]').forEach(b => b.addEventListener('click', () => act(() => api('POST', `/invoices/${b.dataset.prov}/provider`), 'Boleto/NF gerados.')));
  el.querySelectorAll('[data-pay]').forEach(b => b.addEventListener('click', () => registrarPg(S.invoices.find(x => x.id === b.dataset.pay))));
  el.querySelector('[data-exp]').addEventListener('click', () => download(`conciliacao_${fConc.comp}.csv`, [['cliente', 'vencimento', 'cobrado', 'pago_em', 'recebido', 'status', 'nf', 'boleto'], ...all.map(i => [client(i.cid)?.name, dBR(i.venc), nf2(i.valor), dBR(i.pagoEm), nf2(i.pago), invStatus(i)[0], NFTXT[i.nf][0], i.boletoRef || ''])]));
  bindBank(el);
}
function bindBank(el) {
  const f = $('#ofx', el); if (f) f.addEventListener('change', () => {
    const file = f.files[0]; if (!file) return; const fd = new FormData(); fd.append('file', file);
    act(() => api('POST', '/bank/import', fd), r => `Extrato: ${r.novos} entrada(s) nova(s) — ${r.baixados} baixada(s) automaticamente, ${r.pendentes} para revisar${r.repetidos ? `, ${r.repetidos} já importada(s)` : ''}.`);
  });
  el.querySelectorAll('[data-ign]').forEach(b => b.addEventListener('click', () => { if (confirm('Descartar esta entrada? Ela não será vinculada a nenhuma cobrança.')) act(() => api('POST', `/bank/${b.dataset.ign}/ignore`), 'Entrada descartada.'); }));
  el.querySelectorAll('[data-lnk]').forEach(b => b.addEventListener('click', () => {
    const cid = el.querySelector(`[data-ucli="${b.dataset.lnk}"]`).value; if (!cid) { toast('Escolha o cliente.'); return; }
    act(() => api('POST', `/bank/${b.dataset.lnk}/link`, { cid }), i => isPaid(i) && i.nf === 'emitida_pos' ? 'Entrada vinculada. Cobrança quitada e NF emitida.' : 'Entrada vinculada.');
  }));
}
function registrarPg(i) {
  const falta = i.valor - i.pago;
  modal(`<h2>Registrar pagamento</h2><p class="hint" style="margin:0">${esc(client(i.cid).name)} · falta ${brl(falta)}</p>
   <div class="grid g2"><label class="fld">Valor recebido<input id="pv" class="num" value="${nf2(falta)}"></label><label class="fld">Data<input id="pd" type="date" value="${todayISO()}"></label></div>
   ${i.mode === 'later' ? '<p class="hint" style="margin:0">Cliente em “Só boleto”: a NF sai automaticamente se o valor quitar a cobrança.</p>' : ''}
   <div id="perr" class="err"></div>
   <div class="row" style="justify-content:flex-end"><button class="btn" data-x>Cancelar</button><button class="btn pri" data-ok>Registrar pagamento</button></div>`, m => {
    m.querySelector('[data-x]').addEventListener('click', closeModal);
    m.querySelector('[data-ok]').addEventListener('click', async () => {
      const v = parseNum($('#pv').value); if (!(v > 0)) { $('#perr').textContent = 'Informe um valor maior que zero.'; return; }
      const r = await act(() => api('POST', `/invoices/${i.id}/payments`, { valor: v, data: $('#pd').value || todayISO() }), x => isPaid(x) ? (x.nf === 'emitida_pos' ? 'Pagamento registrado. NF emitida automaticamente.' : 'Pagamento registrado.') : `Pagamento parcial. Falta ${brl(x.valor - x.pago)}.`, $('#perr'));
      if (r) closeModal();
    });
  });
}

/* ===================== Relatórios ===================== */
let novoRel = { tipo: REPORT_TYPES[0], dias: new Set([5, 15, 25]), hora: '08:00', fmt: 'CSV anexo', dest: '' };
function vRelatorios(el) {
  const nr = r => { const d = Domain.nextRun(r); return d ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + r.hora : '—'; };
  el.innerHTML = `
  <header class="pg"><div><div class="sub">Enviados por e-mail nos dias que você definir</div><h1>Relatórios agendados</h1></div></header>
  <div class="split">
   <div class="card tbw grow"><table>
    <thead><tr><th>Relatório</th><th>Quando</th><th>Destinatários</th><th>Formato</th><th>Próximo envio</th><th>Último</th><th>Ativo</th><th></th></tr></thead>
    <tbody>${S.reports.map(r => `<tr><td style="font-weight:600">${esc(r.tipo)}</td><td>Dias ${r.dias.join(', ')} · ${esc(r.hora)}</td><td>${esc(r.dest)}</td><td><span class="b mt">${esc(r.fmt)}</span></td>
     <td class="num">${r.on ? nr(r) : '—'}</td><td class="num">${r.lastRun ? new Date(r.lastRun).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—'}</td><td><button class="sw ${r.on ? 'on' : ''}" role="switch" aria-checked="${r.on}" aria-label="Ativar ${esc(r.tipo)}" data-tg="${r.id}"></button></td>
     <td class="r" style="white-space:nowrap"><button class="btn sm" data-now="${esc(r.tipo)}">Gerar agora</button> <button class="link del" data-del="${r.id}">excluir</button></td></tr>`).join('') || '<tr><td colspan="8" class="hint" style="padding:24px">Nenhum relatório agendado.</td></tr>'}</tbody>
   </table></div>
   <section class="card pad stack" style="width:380px;flex-shrink:0">
    <h2>Novo agendamento</h2>
    <label class="fld">Tipo de relatório<select id="rt">${REPORT_TYPES.map(t => `<option ${t === novoRel.tipo ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <div class="fld">Dias do mês<div class="days">${Array.from({ length: 28 }, (_, k) => k + 1).map(d => `<button class="day ${novoRel.dias.has(d) ? 'on' : ''}" aria-pressed="${novoRel.dias.has(d)}" data-day="${d}">${d}</button>`).join('')}</div><span class="hint" style="font-weight:400">Se cair em fim de semana, vai no próximo dia útil.</span></div>
    <div class="grid g2" style="gap:12px"><label class="fld">Horário<input id="rh" type="time" value="${novoRel.hora}"></label><label class="fld">Formato<select id="rf">${['CSV anexo', 'E-mail'].map(f => `<option ${f === novoRel.fmt ? 'selected' : ''}>${f}</option>`).join('')}</select></label></div>
    <label class="fld">Destinatários<input id="rd" value="${esc(novoRel.dest)}" placeholder="e-mails separados por vírgula"></label>
    <div id="rerr" class="err"></div>
    <div class="row"><button class="btn" style="flex:1" data-gen>Gerar agora</button><button class="btn pri" style="flex:1" data-save>Salvar agendamento</button></div>
   </section>
  </div>`;
  const sync = () => { novoRel.tipo = $('#rt').value; novoRel.hora = $('#rh').value; novoRel.fmt = $('#rf').value; novoRel.dest = $('#rd').value; };
  const gen = tipo => fetchFile('/api/reports/generate?tipo=' + encodeURIComponent(tipo));
  el.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => { sync(); const d = +b.dataset.day; novoRel.dias.has(d) ? novoRel.dias.delete(d) : novoRel.dias.add(d); vRelatorios(el); }));
  el.querySelectorAll('[data-tg]').forEach(b => b.addEventListener('click', () => { const r = S.reports.find(x => x.id === b.dataset.tg); act(() => api('PATCH', `/reports/${r.id}`, { on: !r.on })); }));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { if (confirm('Excluir este agendamento?')) act(() => api('DELETE', `/reports/${b.dataset.del}`), 'Agendamento excluído.'); }));
  el.querySelectorAll('[data-now]').forEach(b => b.addEventListener('click', () => gen(b.dataset.now)));
  el.querySelector('[data-gen]').addEventListener('click', () => { sync(); gen(novoRel.tipo); });
  el.querySelector('[data-save]').addEventListener('click', async () => {
    sync(); if (!novoRel.dias.size || !novoRel.dest.trim()) { $('#rerr').textContent = 'Escolha pelo menos um dia e informe os destinatários.'; return; }
    const r = await act(() => api('POST', '/reports', { tipo: novoRel.tipo, dias: [...novoRel.dias], hora: novoRel.hora, dest: novoRel.dest, fmt: novoRel.fmt }), 'Agendamento salvo.', $('#rerr'));
    if (r) { novoRel.dest = ''; render(); }
  });
}

/* ===================== Contas a pagar ===================== */
function vPagamentos(el) {
  const tot = S.payables.reduce((s, p) => s + p.valor, 0), pago = S.payables.filter(p => p.pago).reduce((s, p) => s + p.valor, 0);
  const t = todayISO(), sete = S.payables.filter(p => !p.pago && diffDays(p.venc, t) <= 7).reduce((s, p) => s + p.valor, 0);
  const rec = S.invoices.filter(i => i.pagoEm && i.pagoEm.slice(0, 7) === t.slice(0, 7)).reduce((s, i) => s + Math.min(i.pago, i.valor), 0);
  const list = S.payables.slice().sort((a, b) => a.pago - b.pago || a.venc.localeCompare(b.venc));
  el.innerHTML = `
  <header class="pg"><div><div class="sub">Despesas e fornecedores</div><h1>Contas a pagar</h1></div><button class="btn" data-exp>Exportar</button></header>
  <div class="grid g4">
   <div class="card kpi"><div class="k">Total cadastrado</div><div class="v num">${brl(tot)}</div></div>
   <div class="card kpi"><div class="k">Pago</div><div class="v num" style="color:var(--okf)">${brl(pago)}</div></div>
   <div class="card kpi"><div class="k">Vence em até 7 dias</div><div class="v num" style="color:var(--wf)">${brl(sete)}</div><div class="s">inclui atrasadas</div></div>
   <div class="card kpi"><div class="k">Recebido no mês corrente</div><div class="v num">${brl(rec)}</div></div>
  </div>
  <div class="split">
   <div class="card tbw grow"><table>
    <thead><tr><th>Fornecedor</th><th>Categoria</th><th>Centro de custo</th><th>Venc.</th><th class="r">Valor</th><th>Recorrência</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(p => { const late = !p.pago && p.venc < t; return `<tr><td style="font-weight:600">${esc(p.forn)}${p.anexo ? ` <a class="link" href="/api/payables/${p.id}/anexo" title="${esc(p.anexo)}">anexo</a>` : ''}</td><td><span class="b info">${esc(p.cat)}</span></td><td>${esc(p.cc)}</td><td class="num">${dShort(p.venc)}</td><td class="r num">${nf2(p.valor)}</td><td>${esc(p.rec)}</td>
     <td><span class="b ${p.pago ? 'ok' : late ? 'bad' : 'warn'}">${p.pago ? 'Pago' : late ? 'Atrasado' : 'A pagar'}</span></td>
     <td class="r" style="white-space:nowrap">${p.pago ? '' : `<button class="btn sm" data-pg="${p.id}">Marcar como pago</button>`} <button class="link del" data-del="${p.id}">excluir</button></td></tr>`; }).join('') || '<tr><td colspan="8" class="hint" style="padding:24px">Nenhuma conta cadastrada.</td></tr>'}</tbody>
   </table></div>
   <section class="card pad stack" style="width:360px;flex-shrink:0">
    <h2>Novo pagamento</h2>
    <label class="fld">Fornecedor<input id="pf" placeholder="Nome ou CNPJ"></label>
    <div class="grid g2" style="gap:12px"><label class="fld">Valor<input id="pv" class="num" placeholder="0,00"></label><label class="fld">Vencimento<input id="pvn" type="date"></label></div>
    <label class="fld">Categoria<select id="pc">${CAT_PAG.map(c => `<option>${c}</option>`).join('')}</select></label>
    <label class="fld">Centro de custo<select id="pcc">${CENTROS.map(c => `<option>${c}</option>`).join('')}</select></label>
    <div class="grid g2" style="gap:12px"><label class="fld">Recorrência<select id="pr"><option>Única</option><option>Mensal</option><option>Parcelado</option></select></label><label class="fld">Parcelas<input id="pn" type="number" min="1" value="1"></label></div>
    <label class="fld">Forma<select id="pfo"><option>Boleto</option><option>PIX</option><option>TED</option></select></label>
    <label class="fld">Boleto ou NF do fornecedor<input type="file" id="pa"></label>
    <div class="hint">Mensal: ao marcar como pago, a do mês seguinte é criada. Parcelado: o valor informado é o total.</div>
    <div id="perr" class="err"></div>
    <button class="btn pri" data-add>Cadastrar pagamento</button>
   </section>
  </div>`;
  el.querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', () => act(() => api('POST', `/payables/${b.dataset.pg}/pay`), 'Marcado como pago.')));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => { if (confirm('Excluir esta conta?')) act(() => api('DELETE', `/payables/${b.dataset.del}`), 'Conta excluída.'); }));
  el.querySelector('[data-exp]').addEventListener('click', () => fetchFile('/api/reports/generate?tipo=' + encodeURIComponent('Contas a pagar')));
  el.querySelector('[data-add]').addEventListener('click', () => {
    const forn = $('#pf').value.trim(), valor = parseNum($('#pv').value), venc = $('#pvn').value;
    if (!forn || !(valor > 0) || !venc) { $('#perr').textContent = 'Preencha fornecedor, valor e vencimento.'; return; }
    const fd = new FormData();
    Object.entries({ forn, valor: String(valor), venc, cat: $('#pc').value, cc: $('#pcc').value, rec: $('#pr').value, parcelas: $('#pn').value, forma: $('#pfo').value }).forEach(([k, v]) => fd.append(k, v));
    if ($('#pa').files[0]) fd.append('anexo', $('#pa').files[0]);
    act(() => api('POST', '/payables', fd), 'Pagamento cadastrado.', $('#perr'));
  });
}

/* ===================== Insights ===================== */
let editIns = false;
const WLAB = { w1: 'Faturado × recebido', w2: 'Inadimplência por faixa', w3: 'Dispositivos ganhos × perdidos', w4: 'Concentração de receita', w5: 'Atraso médio de recebimento', w6: 'Caixa do mês', w7: 'Receita por modo de faturamento', w8: 'Licença × comodato × testes' };
function vInsights(el) {
  const comps = [...new Set(S.invoices.map(i => i.comp))].sort(); const comp = comps[comps.length - 1];
  if (!comp) { el.innerHTML = '<header class="pg"><div><div class="sub">Painel configurável</div><h1>Insights</h1></div></header><div class="card pad hint">Os indicadores aparecem depois da primeira cobrança emitida.</div>'; return; }
  const inv = S.invoices.filter(i => i.comp === comp); const fat = inv.reduce((s, i) => s + i.valor, 0), rec = inv.reduce((s, i) => s + Math.min(i.pago, i.valor), 0);
  const series = comps.map(cp => { const x = S.invoices.filter(i => i.comp === cp); return { c: MESES[+cp.split('-')[1] - 1].slice(0, 3), f: x.reduce((s, i) => s + i.valor, 0), r: x.reduce((s, i) => s + Math.min(i.pago, i.valor), 0) }; }).slice(-6);
  const mx = (Math.max(...series.map(s => s.f)) * 1.05) || 1;
  const open = S.invoices.filter(i => !isPaid(i) && daysLate(i) > 0);
  const fx = [[1, 15], [16, 30], [31, 99999]].map(([a, b]) => open.filter(i => daysLate(i) >= a && daysLate(i) <= b).reduce((s, i) => s + i.valor - i.pago, 0)); const fxT = fx.reduce((a, b) => a + b, 0);
  const actv = S.clients.filter(c => c.status === 'ativo'); const K = new Map(S.clients.map(c => [c.id, calc(c)]));
  const gan = S.clients.reduce((s, c) => s + Math.max(0, c.delta), 0), per = S.clients.reduce((s, c) => s + Math.max(0, -c.delta), 0), dev = actv.reduce((s, c) => s + K.get(c.id).devices, 0);
  const mrr = actv.reduce((s, c) => s + K.get(c.id).total, 0) || 1;
  const top = actv.map(c => ({ n: c.name, v: K.get(c.id).total })).sort((a, b) => b.v - a.v).slice(0, 5);
  const paid = S.invoices.filter(i => isPaid(i) && i.pagoEm);
  const lateAvg = a => a.length ? Math.round(a.reduce((s, i) => s + Math.max(0, diffDays(i.pagoEm, i.venc)), 0) / a.length) : 0;
  const openAvg = a => a.length ? Math.round(a.reduce((s, i) => s + daysLate(i), 0) / a.length) : 0;
  const dNow = Math.max(lateAvg(paid.filter(i => i.mode === 'now')), openAvg(open.filter(i => i.mode === 'now'))), dLat = Math.max(lateAvg(paid.filter(i => i.mode === 'later')), openAvg(open.filter(i => i.mode === 'later')));
  const payT = S.payables.filter(p => p.venc.slice(0, 7) === todayISO().slice(0, 7)).reduce((s, p) => s + p.valor, 0);
  const mNow = actv.filter(c => c.mode === 'now').reduce((s, c) => s + K.get(c.id).total, 0);
  const licV = actv.reduce((s, c) => s + sumTipo(K.get(c.id), 'lic'), 0), comV = actv.reduce((s, c) => s + sumTipo(K.get(c.id), 'com'), 0);
  const tr = S.clients.filter(c => c.status === 'teste'); const trDev = tr.reduce((s, c) => s + K.get(c.id).devices, 0), trPot = tr.reduce((s, c) => s + K.get(c.id).total, 0);
  const W = S.widgets;
  const B = {
    w1: `<section class="card wg"><div class="row" style="justify-content:space-between;align-items:center"><h3>Faturado × recebido</h3><div class="row" style="gap:12px"><span class="leg"><span class="sq" style="background:var(--pri)"></span>Faturado</span><span class="leg"><span class="sq" style="background:var(--amber)"></span>Recebido</span></div></div>
     <div class="chart" role="img" aria-label="Faturado e recebido por competência">${series.map(s => `<div class="m"><div class="p"><i style="height:${Math.round(s.f / mx * 140)}px;background:var(--pri)" title="Faturado ${brl(s.f)}"></i><i style="height:${Math.round(s.r / mx * 140)}px;background:var(--amber)" title="Recebido ${brl(s.r)}"></i></div></div>`).join('')}</div>
     <div style="display:flex;gap:12px;margin-top:-6px">${series.map(s => `<div style="flex:1;text-align:center;font-size:12px;color:var(--mut)">${s.c}</div>`).join('')}</div>
     <div class="hint">${compLabel(comp)}: <strong class="num">${fat ? pct(rec / fat) : '0%'}</strong> recebido até hoje.</div></section>`,
    w2: `<section class="card wg"><h3>Inadimplência por faixa de atraso</h3><div class="num" style="font-size:24px;font-weight:600;color:var(--bf)">${brl(fxT)}</div>
     ${['1–15 dias', '16–30 dias', '30+ dias'].map((l, k) => `<div class="hbar"><span style="width:84px">${l}</span><div class="bar"><i style="width:${fxT ? fx[k] / fxT * 100 : 0}%;background:${['var(--amber)', '#B4461F', 'var(--bf)'][k]}"></i></div><span class="num" style="width:90px;text-align:right">${nf2(fx[k])}</span></div>`).join('')}
     <div class="hint">${open.filter(i => i.mode === 'later').length} de ${open.length} vencidos são “Só boleto” — NF ainda não emitida.</div></section>`,
    w3: `<section class="card wg"><h3>Dispositivos ganhos × perdidos desde a última cobrança</h3><div class="row" style="gap:24px"><div><div class="sub">Ganhos</div><div class="num" style="font-size:24px;font-weight:600;color:var(--okf)">+${gan}</div></div><div><div class="sub">Perdidos</div><div class="num" style="font-size:24px;font-weight:600;color:var(--bf)">−${per}</div></div><div><div class="sub">Líquido</div><div class="num" style="font-size:24px;font-weight:600">${gan - per >= 0 ? '+' : '−'}${Math.abs(gan - per)}</div></div></div>
     <div class="hint">Churn de dispositivos (ativos): <strong class="num">${dev ? pct(per / dev) : '0%'}</strong>. Inclui ${tr.reduce((s, c) => s + Math.max(0, c.delta), 0)} ganhos de clientes em teste.</div></section>`,
    w4: `<section class="card wg"><h3>Concentração de receita</h3>${top.map(t => `<div class="hbar"><span style="width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.n)}</span><div class="bar"><i style="width:${top[0].v ? t.v / top[0].v * 100 : 0}%"></i></div><span class="num" style="width:54px;text-align:right">${pct(t.v / mrr)}</span></div>`).join('')}
     ${top.length ? `<div class="hint" style="color:var(--wf);font-weight:600">Os 2 maiores = ${pct((top[0].v + (top[1]?.v || 0)) / mrr)} da receita.</div>` : '<div class="hint">Sem clientes ativos.</div>'}</section>`,
    w5: `<section class="card wg"><h3>Atraso médio de recebimento</h3><div class="num" style="font-size:36px;font-weight:600">${Math.round((dNow + dLat) / 2)} <span style="font-size:15px;font-weight:400;color:var(--mut)">dias após o vencimento</span></div><div class="hint">“Boleto + NF”: <strong class="num">${dNow} dias</strong><br>“Só boleto”: <strong class="num">${dLat} dias</strong></div></section>`,
    w6: `<section class="card wg"><h3>Caixa</h3><div class="ln"><span>Recebido (${compLabel(comp)})</span><strong class="num" style="color:var(--okf)">${brl(rec)}</strong></div><div class="ln"><span>Contas a pagar do mês</span><strong class="num" style="color:var(--bf)">${brl(payT)}</strong></div><div class="ln" style="border:0"><strong>Saldo</strong><strong class="num">${brl(rec - payT)}</strong></div><div class="hint">Se o restante da competência entrar: <strong class="num">${brl(fat - payT)}</strong>.</div></section>`,
    w7: `<section class="card wg"><h3>Receita por modo de faturamento</h3><div style="display:flex;height:18px;border-radius:9px;overflow:hidden"><div style="width:${mNow / mrr * 100}%;background:var(--pri)"></div><div style="flex:1;background:var(--amber)"></div></div><div class="ln"><span class="leg"><span class="sq" style="background:var(--pri)"></span>Boleto + NF</span><span class="num">${brl(mNow)} · ${pct(mNow / mrr)}</span></div><div class="ln" style="border:0"><span class="leg"><span class="sq" style="background:var(--amber)"></span>Só boleto</span><span class="num">${brl(mrr - mNow)} · ${pct(1 - mNow / mrr)}</span></div></section>`,
    w8: `<section class="card wg"><h3>Licença × comodato × testes</h3><div style="display:flex;height:18px;border-radius:9px;overflow:hidden"><div style="width:${licV / (licV + comV || 1) * 100}%;background:var(--pri)"></div><div style="flex:1;background:#7B68C4"></div></div><div class="ln"><span class="leg"><span class="sq" style="background:var(--pri)"></span>Licenças</span><span class="num">${brl(licV)}</span></div><div class="ln"><span class="leg"><span class="sq" style="background:#7B68C4"></span>Comodato</span><span class="num">${brl(comV)}</span></div><div class="ln" style="border:0"><span>Em teste: ${tr.length} cliente(s), ${trDev} disp.</span><span class="num">potencial ${brl(trPot)}/mês</span></div></section>`
  };
  const on = Object.keys(WLAB).filter(k => W[k]);
  el.innerHTML = `
  <header class="pg"><div><div class="sub">Painel configurável · base: ${compLabel(comp)}</div><h1>Insights</h1></div><button class="btn pri" data-edit aria-expanded="${editIns}">${editIns ? 'Concluir' : 'Personalizar painel'}</button></header>
  <div class="split"><div class="grid grow ins" style="grid-template-columns:repeat(${editIns ? 2 : 3},minmax(0,1fr));align-content:start">${on.map(k => B[k]).join('') || '<div class="card pad hint">Nenhum bloco selecionado.</div>'}</div>
   ${editIns ? `<aside class="card pad" style="width:300px;flex-shrink:0"><h2>Personalizar painel</h2><p class="hint">Escolha os blocos que aparecem. Fica salvo.</p>${Object.entries(WLAB).map(([k, l]) => `<label class="rule"><input type="checkbox" data-w="${k}" ${W[k] ? 'checked' : ''}><span>${l}</span></label>`).join('')}</aside>` : ''}</div>`;
  el.querySelector('[data-edit]').addEventListener('click', () => { editIns = !editIns; vInsights(el); });
  el.querySelectorAll('[data-w]').forEach(b => b.addEventListener('change', () => { S.widgets[b.dataset.w] = b.checked; vInsights(el); api('PUT', '/widgets', { widgets: S.widgets }).catch(e => toast(e.message)); }));
}

/* ===================== Início ===================== */
(async () => {
  try { ME = await api('GET', '/me'); await reload(); paintFoot(); render(); }
  catch (e) { if (!$('#login')) toast(e.message); }
})();
