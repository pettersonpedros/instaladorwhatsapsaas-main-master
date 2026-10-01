/* Backup consistente do banco (pode rodar com o sistema no ar).
   Uso: node scripts/backup.js [pasta] — guarda os últimos 30 arquivos. */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const src = process.env.DB_FILE || path.join(DATA_DIR, 'yuv.db');
const dir = process.argv[2] || path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, `yuv-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`);
new Database(src, { readonly: true }).backup(dest).then(() => {
  const old = fs.readdirSync(dir).filter(f => /^yuv-.*\.db$/.test(f)).sort().slice(0, -30);
  old.forEach(f => fs.rmSync(path.join(dir, f)));
  console.log('Backup salvo em', dest);
}).catch(e => { console.error('Falha no backup:', e.message); process.exit(1); });
