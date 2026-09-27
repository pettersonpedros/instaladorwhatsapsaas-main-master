// Uso: npm run create-admin -- "Nome" email@dominio.com senha
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../db');

async function main() {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) {
    console.error('Uso: npm run create-admin -- "Nome" email@dominio.com senha');
    process.exit(1);
  }
  await db.migrate();
  const hash = await bcrypt.hash(password, 10);
  const existing = await db.one('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  if (existing) {
    await db.query(`UPDATE users SET password_hash = $2, role = 'admin', active = true WHERE id = $1`, [existing.id, hash]);
    console.log(`Usuário ${email} promovido a admin e senha redefinida.`);
  } else {
    await db.query(`INSERT INTO users (name, email, password_hash, role) VALUES ($1, lower($2), $3, 'admin')`, [name, email, hash]);
    console.log(`Admin ${email} criado.`);
  }
  await db.pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
