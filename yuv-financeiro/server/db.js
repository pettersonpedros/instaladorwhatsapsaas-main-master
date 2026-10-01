const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const D = require('../shared/domain');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(process.env.DB_FILE || path.join(DATA_DIR, 'yuv.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'financeiro', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS price_tables (id TEXT PRIMARY KEY, nome TEXT NOT NULL, padrao INTEGER NOT NULL DEFAULT 0, versoes TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, cnpj TEXT, doc TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS clients_cnpj ON clients(cnpj);
CREATE TABLE IF NOT EXISTS client_history (
  id INTEGER PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime')), what TEXT NOT NULL, who TEXT NOT NULL, why TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS client_history_c ON client_history(client_id, id);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, cid TEXT NOT NULL REFERENCES clients(id), comp TEXT NOT NULL,
  valor REAL NOT NULL, venc TEXT NOT NULL, mode TEXT NOT NULL, pago REAL NOT NULL DEFAULT 0, pago_em TEXT,
  nf TEXT NOT NULL, items TEXT NOT NULL DEFAULT '[]', boleto_ref TEXT, boleto_url TEXT, nf_ref TEXT,
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (cid, comp));
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id), valor REAL NOT NULL, data TEXT NOT NULL,
  origem TEXT NOT NULL, ref TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS bank_entries (
  id TEXT PRIMARY KEY, fitid TEXT UNIQUE, data TEXT NOT NULL, valor REAL NOT NULL, pagador TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, invoice_id TEXT, sug_cid TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS payables (
  id TEXT PRIMARY KEY, forn TEXT NOT NULL, cat TEXT NOT NULL, cc TEXT NOT NULL, venc TEXT NOT NULL, valor REAL NOT NULL,
  rec TEXT NOT NULL, forma TEXT NOT NULL, pago INTEGER NOT NULL DEFAULT 0, pago_em TEXT, anexo TEXT, anexo_nome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, tipo TEXT NOT NULL, dias TEXT NOT NULL, hora TEXT NOT NULL, dest TEXT NOT NULL, fmt TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1, last_run TEXT);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, attachments TEXT,
  status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS job_runs (key TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
`);

const newId = p => p + crypto.randomBytes(6).toString('hex');
const J = s => JSON.parse(s);

/* ---------- configurações ---------- */
const DEFAULT_CFG = { inicio: 18, envioDe: 20, envioAte: 25, venc: 15, diasMin: 5, avisos: [7, 3, 1], trialDias: 30, emailFinanceiro: 'financeiro@yuv.com.br', emailComercial: '' };
const DEFAULT_WIDGETS = { w1: true, w2: true, w3: true, w4: true, w5: true, w6: true, w7: false, w8: true };
function getSetting(key, def) { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r ? J(r.value) : def; }
function setSetting(key, value) { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }

/* ---------- tabelas de preço ---------- */
function listTables() { return db.prepare('SELECT * FROM price_tables ORDER BY ord, rowid').all().map(r => ({ id: r.id, nome: r.nome, padrao: !!r.padrao, versoes: J(r.versoes) })); }
function getTable(id) { return listTables().find(t => t.id === id); }
function saveTable(t) {
  const ord = t.padrao ? 0 : 1;
  db.prepare('INSERT INTO price_tables(id,nome,padrao,versoes,ord) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET nome=excluded.nome, versoes=excluded.versoes')
    .run(t.id, t.nome, t.padrao ? 1 : 0, JSON.stringify(t.versoes), ord);
}

/* ---------- clientes ---------- */
const CLIENT_FIELDS = ['id', 'name', 'cnpj', 'canal', 'status', 'tabela', 'versao', 'indicado', 'diasMin', 'due', 'mode', 'email', 'rules', 'ajustes', 'bloqueio', 'delta', 'trial', 'linhas'];
function pickClient(c) { const o = {}; CLIENT_FIELDS.forEach(k => { o[k] = c[k]; }); return o; }
function getClient(id) { const r = db.prepare('SELECT doc FROM clients WHERE id=?').get(id); return r ? J(r.doc) : null; }
function listClients() { return db.prepare('SELECT doc FROM clients ORDER BY rowid').all().map(r => J(r.doc)); }
function saveClient(c) {
  const doc = pickClient(c);
  db.prepare('INSERT INTO clients(id,cnpj,doc) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET cnpj=excluded.cnpj, doc=excluded.doc')
    .run(doc.id, D.onlyDigits(doc.cnpj), JSON.stringify(doc));
}
function addHistory(cid, what, who, why = '') { db.prepare('INSERT INTO client_history(client_id,what,who,why) VALUES(?,?,?,?)').run(cid, what, who, why || ''); }
function historyOf(cid, limit = 200) {
  return db.prepare('SELECT at,what,who,why FROM client_history WHERE client_id=? ORDER BY id DESC LIMIT ?').all(cid, limit)
    .map(h => ({ when: h.at.slice(0, 10).split('-').reverse().join('/') + ' ' + h.at.slice(11, 16), what: h.what, who: h.who, why: h.why }));
}

/* ---------- cobranças ---------- */
const invRow = r => ({ id: r.id, cid: r.cid, comp: r.comp, valor: r.valor, venc: r.venc, mode: r.mode, pago: r.pago, pagoEm: r.pago_em, nf: r.nf, items: J(r.items), boletoRef: r.boleto_ref, boletoUrl: r.boleto_url, nfRef: r.nf_ref });
function listInvoices() { return db.prepare('SELECT * FROM invoices ORDER BY comp, created_at').all().map(invRow); }
function getInvoice(id) { const r = db.prepare('SELECT * FROM invoices WHERE id=?').get(id); return r ? invRow(r) : null; }
function insertInvoice(i) {
  db.prepare('INSERT INTO invoices(id,cid,comp,valor,venc,mode,pago,pago_em,nf,items,boleto_ref,boleto_url,nf_ref,created_by) VALUES(@id,@cid,@comp,@valor,@venc,@mode,@pago,@pagoEm,@nf,@items,@boletoRef,@boletoUrl,@nfRef,@createdBy)')
    .run({ boletoRef: null, boletoUrl: null, nfRef: null, createdBy: null, pagoEm: null, ...i, items: JSON.stringify(i.items || []) });
}
function updateInvoice(i) {
  db.prepare('UPDATE invoices SET pago=@pago, pago_em=@pagoEm, nf=@nf, boleto_ref=@boletoRef, boleto_url=@boletoUrl, nf_ref=@nfRef WHERE id=@id')
    .run({ id: i.id, pago: i.pago, pagoEm: i.pagoEm || null, nf: i.nf, boletoRef: i.boletoRef || null, boletoUrl: i.boletoUrl || null, nfRef: i.nfRef || null });
}

/* ---------- banco ---------- */
function listPendingBank() { return db.prepare("SELECT * FROM bank_entries WHERE status='pendente' ORDER BY data").all(); }

/* ---------- contas a pagar ---------- */
const payRow = r => ({ id: r.id, forn: r.forn, cat: r.cat, cc: r.cc, venc: r.venc, valor: r.valor, rec: r.rec, forma: r.forma, pago: !!r.pago, pagoEm: r.pago_em, anexo: r.anexo ? r.anexo_nome || 'anexo' : null });
function listPayables() { return db.prepare('SELECT * FROM payables ORDER BY venc').all().map(payRow); }

/* ---------- relatórios ---------- */
const repRow = r => ({ id: r.id, tipo: r.tipo, dias: J(r.dias), hora: r.hora, dest: r.dest, fmt: r.fmt, on: !!r.ativo, lastRun: r.last_run });
function listReports() { return db.prepare('SELECT * FROM reports ORDER BY rowid').all().map(repRow); }

/* ---------- estado completo (mesmo formato usado pela tela) ---------- */
function state(opts = {}) {
  const clients = listClients();
  if (opts.history !== false) clients.forEach(c => { c.history = historyOf(c.id, 100); });
  const invoices = listInvoices();
  return {
    competencia: getSetting('competencia', D.todayISO().slice(0, 7)),
    cfg: { ...DEFAULT_CFG, ...getSetting('cfg', {}) },
    tables: listTables(),
    clients,
    invoices,
    unmatched: listPendingBank().map(b => ({ id: b.id, valor: b.valor, data: b.data, pagador: b.pagador, memo: b.memo, sug: b.sug_cid })),
    sentComp: getSetting('sentComp', []),
    payables: listPayables(),
    reports: listReports(),
    widgets: { ...DEFAULT_WIDGETS, ...getSetting('widgets', {}) }
  };
}

/* ---------- jobs idempotentes ---------- */
function claimJob(key) { try { db.prepare('INSERT INTO job_runs(key) VALUES(?)').run(key); return true; } catch (e) { return false; } }

/* ---------- carga inicial: tabela padrão do Termo V2026.2 ---------- */
const F = (a, b, c, d) => [{ ate: 100, preco: a }, { ate: 500, preco: b }, { ate: 1000, preco: c }, { ate: 2000, preco: d }];
const LINHAS_2026_2 = [
  { id: 'rastreador', nome: 'Rastreador', unid: 'dispositivo', faixas: F(5, 4, 3, 2), comodatoPreco: null },
  { id: 'streamax', nome: 'Streamax', unid: 'dispositivo', faixas: F(30, 29, 28, 27), comodatoPreco: null },
  { id: 'jc450', nome: 'JC450, G40 Pro e JC371', unid: 'dispositivo', faixas: F(25, 24, 23, 22), comodatoPreco: null },
  { id: 'jc400', nome: 'JC400, G40, NT407, VIT600', unid: 'dispositivo', faixas: F(20, 19, 18, 17), comodatoPreco: null },
  { id: 'jc181', nome: 'JC181', unid: 'dispositivo', faixas: F(15, 14, 13, 12), comodatoPreco: null },
  { id: 'jc182', nome: 'JC182', unid: 'dispositivo', faixas: F(12, 11, 10, 9), comodatoPreco: null },
  { id: 'tags', nome: 'Tags', unid: 'tag', faixas: [{ ate: 100, preco: 2 }, { ate: 1000, preco: 1.5 }, { ate: 5000, preco: 1 }, { ate: 10000, preco: 0.8 }], comodatoPreco: null }
];
function ensureBase() {
  if (!getTable('padrao')) saveTable({ id: 'padrao', nome: 'Tabela padrão', padrao: true, versoes: [{ v: 'V2026.2', data: '01/07/2026', faixaBase: 'linha', modo: 'volume', cortesia: 5, linhas: D.clone(LINHAS_2026_2) }] });
  if (!getSetting('cfg', null)) setSetting('cfg', DEFAULT_CFG);
  if (!getSetting('competencia', null)) setSetting('competencia', D.todayISO().slice(0, 7));
}
ensureBase();

module.exports = {
  db, newId, DATA_DIR, LINHAS_2026_2, DEFAULT_CFG,
  getSetting, setSetting,
  listTables, getTable, saveTable,
  getClient, listClients, saveClient, addHistory, historyOf,
  listInvoices, getInvoice, insertInvoice, updateInvoice,
  listPayables, listReports, state, claimJob,
  tx: fn => db.transaction(fn)
};
