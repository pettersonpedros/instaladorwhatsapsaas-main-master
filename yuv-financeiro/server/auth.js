const crypto = require('crypto');
const { db } = require('./db');

const SESSION_DAYS = 7;
const COOKIE = 'yuv_sess';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [alg, salt, hex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  const ref = Buffer.from(hex, 'hex');
  return ref.length === h.length && crypto.timingSafeEqual(ref, h);
}

function createUser({ email, name, password, role = 'financeiro' }) {
  return db.prepare('INSERT INTO users(email,name,pass_hash,role) VALUES(?,?,?,?)').run(email.toLowerCase().trim(), name, hashPassword(password), role).lastInsertRowid;
}
function ensureAdmin() {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n) return;
  const email = process.env.ADMIN_EMAIL, pw = process.env.ADMIN_PASSWORD;
  if (!email || !pw) { console.warn('[auth] Nenhum usuário. Defina ADMIN_EMAIL e ADMIN_PASSWORD para criar o primeiro administrador.'); return; }
  createUser({ email, name: process.env.ADMIN_NAME || 'Administrador', password: pw, role: 'admin' });
  console.log(`[auth] Administrador ${email} criado.`);
}

function parseCookies(h) { const o = {}; String(h || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return o; }
const secure = () => process.env.COOKIE_SECURE === '1';
function setCookie(res, token, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure() ? '; Secure' : ''}`);
}

/* Limite simples de tentativas de login por IP */
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60e3);
  attempts.set(ip, a); return a.length >= 10;
}

function login(req, res) {
  const ip = req.ip;
  if (tooMany(ip)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
  const { email, password } = req.body || {};
  const u = email && db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(String(email).toLowerCase().trim());
  if (!u || !checkPassword(String(password || ''), u.pass_hash)) { attempts.get(ip).push(Date.now()); return res.status(401).json({ error: 'E-mail ou senha incorretos.' }); }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)').run(token, u.id, Date.now() + SESSION_DAYS * 864e5);
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
  setCookie(res, token, SESSION_DAYS * 86400);
  res.json({ id: u.id, email: u.email, name: u.name, role: u.role });
}
function logout(req, res) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(t);
  setCookie(res, '', 0); res.json({ ok: true });
}
function requireAuth(req, res, next) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  const s = t && db.prepare('SELECT u.id,u.email,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1').get(t, Date.now());
  if (!s) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
  req.user = s; next();
}
/* Mutação só com JSON (ou multipart nos uploads): bloqueia form POST de outro site */
function requireJson(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const ct = String(req.headers['content-type'] || '');
  if (ct.startsWith('application/json') || ct.startsWith('multipart/form-data')) return next();
  res.status(415).json({ error: 'Content-Type inválido.' });
}

module.exports = { login, logout, requireAuth, requireJson, ensureAdmin, createUser, hashPassword };
