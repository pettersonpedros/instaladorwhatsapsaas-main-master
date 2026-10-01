const test = require('node:test');
const assert = require('node:assert');
const D = require('../shared/domain');

const F = (a, b) => [{ ate: 100, preco: a }, { ate: 500, preco: b }];
const S = {
  cfg: { inicio: 18, envioDe: 20, envioAte: 25, venc: 15, diasMin: 5, trialDias: 30 },
  tables: [{ id: 'padrao', nome: 'Padrão', padrao: true, versoes: [
    { v: 'A', faixaBase: 'linha', modo: 'volume', cortesia: 5, linhas: [{ id: 'x', nome: 'X', unid: 'dispositivo', faixas: F(10, 8), comodatoPreco: null }, { id: 'y', nome: 'Y', unid: 'dispositivo', faixas: F(4, 3), comodatoPreco: 50 }] }] }],
  invoices: []
};
const cli = o => ({ id: 'c', name: 'C', status: 'ativo', tabela: 'padrao', versao: 'A', indicado: false, diasMin: 0, ajustes: [], bloqueio: '', linhas: [], ...o });

test('volume: preço da faixa em todas as unidades', () => {
  const k = D.calc(S, cli({ linhas: [{ linha: 'x', ativos: 150, comodato: 0 }] }));
  assert.strictEqual(k.total, 1200);
});

test('escalonado: cada faixa no seu preço', () => {
  const S2 = D.clone(S); S2.tables[0].versoes[0].modo = 'escalonado';
  const k = D.calc(S2, cli({ linhas: [{ linha: 'x', ativos: 150, comodato: 0 }] }));
  assert.strictEqual(k.total, 100 * 10 + 50 * 8);
});

test('comodato, poucos dias, cortesia e preço negociado', () => {
  const k = D.calc(S, cli({ indicado: true, diasMin: 5, linhas: [
    { linha: 'x', ativos: 30, comodato: 0, poucoUso: 2, precoManual: 9 },
    { linha: 'y', ativos: 20, comodato: 10, comodatoPreco: null }] }));
  // X: 30-2=28, cortesia 5 → 23 × 9 = 207; Y: 20 → 10 comodato × 50 + 10 licença × 4
  assert.strictEqual(k.total, 207 + 500 + 40);
  assert.strictEqual(k.free, 5);
  assert.strictEqual(k.pouco, 2);
});

test('comodato sem preço bloqueia a cobrança', () => {
  const c = cli({ linhas: [{ linha: 'x', ativos: 10, comodato: 2 }] });
  assert.ok(D.calc(S, c).flags.some(f => f.blk));
  assert.ok(D.billState(S, c, '2026-10').blocked);
});

test('período de apuração e teste gratuito', () => {
  const P = D.periodo(S.cfg, '2026-10');
  assert.deepStrictEqual([P.ini, P.fim, P.vencMes], ['2026-09-18', '2026-10-17', '2026-11']);
  const linhas = [{ linha: 'x', ativos: 10, comodato: 0 }];
  const t = fim => cli({ status: 'teste', diasMin: 5, linhas, trial: { fim, aoFim: 'cobrar', avisos: [], enviados: [] } });
  assert.ok(D.billState(S, t('2026-10-20'), '2026-10').skip); // ainda em teste
  assert.ok(D.billState(S, t('2026-10-15'), '2026-10').skip); // só 2 dias ativo
  assert.ok(!D.billState(S, t('2026-10-05'), '2026-10').skip); // 12 dias → cobra
});

test('não cobra duas vezes a mesma competência', () => {
  const S2 = { ...S, invoices: [{ cid: 'c', comp: '2026-10' }] };
  assert.ok(D.billState(S2, cli({ linhas: [{ linha: 'x', ativos: 10, comodato: 0 }] }), '2026-10').sent);
});

test('relatório agendado em fim de semana vai no próximo dia útil', () => {
  const r = { dias: [3], hora: '08:00' }; // 03/10/2026 é sábado
  assert.strictEqual(D.dueToday(r, new Date(2026, 9, 3, 9)), null);
  assert.strictEqual(D.dueToday(r, new Date(2026, 9, 5, 7)), null); // segunda antes do horário
  assert.strictEqual(D.dueToday(r, new Date(2026, 9, 5, 9)), '2026-10-03');
});

test('importação: conflito com preço negociado', () => {
  const S2 = { ...S, clients: [cli({ cnpj: '11.111.111/0001-11', linhas: [{ linha: 'x', ativos: 10, comodato: 0, precoManual: 9 }] })] };
  const [r] = D.diffRows(S2, [{ cliente: 'C', cnpj: '11111111000111', linha: 'x', ativos: '12', preco_licenca: '8,50' }]);
  assert.strictEqual(r.kind, 'conflito');
  const [e] = D.diffRows(S2, [{ cliente: 'C', cnpj: '123', linha: 'x', ativos: '1' }]);
  assert.strictEqual(e.kind, 'erro');
});
