/* Carrega os dados fictícios do protótipo (para demonstração/treino).
   Uso: npm run seed:demo   — só roda com o banco sem clientes. */
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
const D = require('../shared/domain');
const store = require('../server/db');

if (store.listClients().length && !process.argv.includes('--force')) {
  console.error('O banco já tem clientes. Use --force para carregar mesmo assim.'); process.exit(1);
}
const today = D.todayISO(), plus = n => D.addDays(today, n);
const F = (a, b, c, d) => [{ ate: 100, preco: a }, { ate: 500, preco: b }, { ate: 1000, preco: c }, { ate: 2000, preco: d }];
const old = D.clone(store.LINHAS_2026_2); old.find(l => l.id === 'streamax').faixas = F(32, 31, 30, 29);
const cust = D.clone(store.LINHAS_2026_2).filter(l => l.id === 'streamax'); cust[0].faixas = [{ ate: 99999, preco: 26 }]; cust[0].comodatoPreco = 85;
const comp = today.slice(0, 7), prev = D.prevComp(comp), prev2 = D.prevComp(prev);

store.tx(() => {
  store.saveTable({ id: 'padrao', nome: 'Tabela padrão', padrao: true, versoes: [
    { v: 'V2026.1', data: '02/01/2026', faixaBase: 'linha', modo: 'volume', cortesia: 5, linhas: old },
    { v: 'V2026.2', data: '01/07/2026', faixaBase: 'linha', modo: 'volume', cortesia: 5, linhas: D.clone(store.LINHAS_2026_2) }] });
  store.saveTable({ id: 't_beta', nome: 'Personalizada — Logística Beta', padrao: false, versoes: [{ v: 'v1', data: '12/09/2026', faixaBase: 'linha', modo: 'volume', cortesia: 0, linhas: cust }] });
  store.setSetting('competencia', comp);
  store.setSetting('sentComp', [prev2, prev]);

  const L = (linha, ativos, o = {}) => ({ linha, ativos, comodato: 0, comodatoPreco: null, precoManual: null, poucoUso: 0, ...o });
  const c = o => Object.assign({ canal: 'Direto', status: 'ativo', tabela: 'padrao', versao: 'V2026.2', indicado: false, diasMin: 5, due: 15, mode: 'now', email: '', rules: ['multa'], ajustes: [], bloqueio: '', delta: 0, trial: null }, o);
  const clients = [
    c({ id: 'a', name: 'Transportadora Alfa', cnpj: '00.000.001/0001-00', email: 'financeiro@alfa.exemplo', linhas: [L('streamax', 142), L('rastreador', 60, { poucoUso: 2 })], delta: 4, rules: ['multa', 'instalacao'] }),
    c({ id: 'b', name: 'Logística Beta', cnpj: '00.000.002/0001-00', tabela: 't_beta', versao: 'v1', due: 10, mode: 'later', email: 'contas@beta.exemplo', linhas: [L('streamax', 58, { comodato: 10 })], delta: -2 }),
    c({ id: 'c', name: 'Rodoviário Gama', cnpj: '00.000.003/0001-00', canal: 'Integrador', email: 'fin@gama.exemplo', linhas: [L('jc450', 300, { comodato: 50, comodatoPreco: 70, poucoUso: 6 })], rules: ['multa', 'naodevolvido'] }),
    c({ id: 'd', name: 'Distribuidora Delta', cnpj: '00.000.004/0001-00', indicado: true, mode: 'later', email: 'financeiro@delta.exemplo', linhas: [L('jc181', 27), L('tags', 120)], delta: 3, rules: ['multa', 'pontualidade'] }),
    c({ id: 'e', name: 'Frota Épsilon', cnpj: '00.000.005/0001-00', canal: 'Integrador', versao: 'V2026.1', email: 'ap@epsilon.exemplo', linhas: [L('streamax', 96)], delta: -5, bloqueio: '5 equipamentos removidos sem devolução', rules: ['multa', 'naodevolvido'] }),
    c({ id: 'f', name: 'Cargas Zeta', cnpj: '00.000.006/0001-00', status: 'teste', mode: 'later', email: 'compras@zeta.exemplo', linhas: [L('jc400', 12)], delta: 12, trial: { inicio: plus(-25), fim: plus(5), email: 'gestor@zeta.exemplo', avisos: [7, 3, 1], aoFim: 'cobrar', enviados: [{ d: 7, em: plus(-2) }] } }),
    c({ id: 'g', name: 'Expresso Eta', cnpj: '00.000.007/0001-00', canal: 'Integrador', email: 'fin@eta.exemplo', linhas: [L('jc182', 75), L('rastreador', 20, { precoManual: 4.5 })], delta: 1 }),
    c({ id: 'h', name: 'Transportes Theta', cnpj: '00.000.008/0001-00', status: 'teste', mode: 'later', linhas: [L('streamax', 40)], delta: 40, trial: { inicio: plus(-11), fim: plus(19), email: 'operacoes@theta.exemplo', avisos: [7, 3, 1], aoFim: 'suspender', enviados: [] } })
  ];
  clients.forEach(x => { store.saveClient(x); store.addHistory(x.id, 'Dados de demonstração carregados', 'sistema'); });

  const venc = (cp, d) => `${D.nextComp(cp)}-${String(d).padStart(2, '0')}`;
  const inv = (cid, cp, valor, due, mode, pago, pagoEm) => store.insertInvoice({ id: store.newId('i'), cid, comp: cp, valor, venc: venc(cp, due), mode, pago, pagoEm, nf: D.nfState(mode, valor, pago), items: [] });
  inv('c', prev2, 9356, 15, 'now', 9356, venc(prev2, 15)); inv('a', prev2, 4418, 15, 'now', 4418, venc(prev2, 14));
  inv('g', prev2, 990, 15, 'now', 990, venc(prev2, 15)); inv('d', prev2, 510, 15, 'later', 380, venc(prev2, 18));
  inv('e', prev2, 3072, 15, 'now', 0, null); inv('b', prev2, 2098, 10, 'later', 0, null);
  inv('c', prev, 9356, 15, 'now', 0, null); inv('a', prev, 4418, 15, 'now', 4418, plus(-2));
  inv('g', prev, 990, 15, 'now', 0, null); inv('d', prev, 510, 15, 'later', 0, null);
  inv('e', prev, 3072, 15, 'now', 0, null); inv('b', prev, 2098, 10, 'later', 0, null);

  store.db.prepare("INSERT INTO bank_entries(id,fitid,data,valor,pagador,memo,status,sug_cid) VALUES('b_demo','demo-1',?,130,'DELTA DISTRIB LTDA','','pendente','d')").run(plus(-3));

  const P = (id, forn, cat, cc, v, valor, rec, forma, pago) => store.db.prepare('INSERT INTO payables(id,forn,cat,cc,venc,valor,rec,forma,pago) VALUES(?,?,?,?,?,?,?,?,?)').run(id, forn, cat, cc, v, valor, rec, forma, pago ? 1 : 0);
  P('p1', 'Operadora de chips M2M', 'Conectividade', 'Custo do serviço', plus(-25), 2480, 'Mensal', 'Boleto', 1);
  P('p2', 'Contabilidade', 'Serviços', 'Administrativo', plus(-20), 1400, 'Mensal', 'PIX', 1);
  P('p3', 'Fornecedor de câmeras', 'Hardware comodato', 'Capex', plus(-15), 3870, 'Parcela 3/6', 'Boleto', 1);
  P('p4', 'Provedor de nuvem', 'Infraestrutura', 'Custo do serviço', plus(1), 4200, 'Mensal · variável', 'Boleto', 0);
  P('p5', 'Aluguel escritório', 'Ocupação', 'Administrativo', plus(4), 2470, 'Mensal', 'TED', 0);

  const R = (id, tipo, dias, hora, dest, fmt) => store.db.prepare('INSERT INTO reports(id,tipo,dias,hora,dest,fmt,ativo) VALUES(?,?,?,?,?,?,0)').run(id, tipo, JSON.stringify(dias), hora, dest, fmt);
  R('r1', 'Posição de recebimentos', [5, 15, 25], '08:00', 'financeiro@yuv.exemplo', 'CSV anexo');
  R('r2', 'Inadimplência', [1, 8, 16, 22], '08:00', 'financeiro@yuv.exemplo, diretoria@yuv.exemplo', 'CSV anexo');
  R('r3', 'Testes terminando', [1, 8, 15, 22], '08:00', 'comercial@yuv.exemplo', 'E-mail');
})();
console.log('Dados de demonstração carregados. Os relatórios de exemplo ficam desativados para não disparar e-mails.');
