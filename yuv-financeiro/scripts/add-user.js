/* Uso: node scripts/add-user.js email@empresa.com "Nome" senha [admin|financeiro] */
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
const { createUser } = require('../server/auth');
const [email, name, password, role = 'financeiro'] = process.argv.slice(2);
if (!email || !name || !password || password.length < 8) { console.error('Uso: node scripts/add-user.js email "Nome" senha(8+ caracteres) [admin|financeiro]'); process.exit(1); }
try { createUser({ email, name, password, role }); console.log(`Usuário ${email} criado.`); }
catch (e) { console.error(/UNIQUE/.test(e.message) ? 'Já existe usuário com esse e-mail.' : e.message); process.exit(1); }
