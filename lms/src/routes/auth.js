const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const settings = require('../services/settings');
const triggers = require('../services/triggers');
const { requireLogin } = require('../middleware');

const router = express.Router();

// limite simples de tentativas de login por IP
const attempts = new Map();
const resetAttempts = new Map();
function tooMany(ip, map = attempts) {
  const now = Date.now();
  const entry = map.get(ip) || { count: 0, since: now };
  if (now - entry.since > 15 * 60000) { entry.count = 0; entry.since = now; }
  map.set(ip, entry);
  return entry;
}

const RESET_TTL_MINUTES = 60;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function homeFor(user) {
  if (user.role === 'student') return '/';
  if (user.role === 'manager') return '/gestor';
  return '/admin';
}

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : null;
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Entrar', next: req.query.next || '', email: '' });
});

router.post('/login', async (req, res, next) => {
  try {
    const entry = tooMany(req.ip);
    const email = String(req.body.email || '').trim();
    if (entry.count >= 10) {
      return res.status(429).render('login', {
        title: 'Entrar', next: req.body.next, email, error: 'Muitas tentativas. Aguarde 15 minutos.',
      });
    }
    const user = await db.one('SELECT * FROM users WHERE lower(email) = lower($1) AND active', [email]);
    if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
      entry.count++;
      return res.status(401).render('login', { title: 'Entrar', next: req.body.next, email, error: 'E-mail ou senha inválidos.' });
    }
    attempts.delete(req.ip);
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = user.id;
      db.query('UPDATE users SET last_login_at = now(), last_activity_at = now() WHERE id = $1', [user.id]).catch(() => {});
      db.query(`INSERT INTO activity (user_id, type) VALUES ($1, 'login')`, [user.id]).catch(() => {});
      res.redirect(safeNext(req.body.next) || homeFor(user));
    });
  } catch (err) {
    next(err);
  }
});

// ---------- recuperação de senha ----------

router.get('/recuperar-senha', (req, res) => {
  if (req.user) return res.redirect('/perfil');
  res.render('forgot', { title: 'Recuperar senha', sent: false, email: '' });
});

router.post('/recuperar-senha', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim();
    const entry = tooMany(req.ip, resetAttempts);
    entry.count++;
    // Resposta sempre igual: não revela se o e-mail existe.
    const done = () => res.render('forgot', { title: 'Recuperar senha', sent: true, email });
    if (entry.count > 5) return done();
    const user = await db.one('SELECT * FROM users WHERE lower(email) = lower($1) AND active', [email]);
    if (!user) return done();
    const recent = await db.one(
      `SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [user.id]);
    if (recent.n >= 3) return done();

    const token = crypto.randomBytes(32).toString('base64url');
    await db.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))`, [user.id, hashToken(token), RESET_TTL_MINUTES]);
    const site = await settings.getAll();
    const link = `${String(site.public_url).replace(/\/$/, '')}/redefinir-senha/${token}`;
    const text = `Olá ${user.name.split(' ')[0]}! Recebemos um pedido para redefinir sua senha na ${site.site_name}.\n\n`
      + `Crie uma nova senha por este link (válido por ${RESET_TTL_MINUTES} minutos):\n${link}\n\n`
      + 'Se não foi você, ignore esta mensagem.';
    const channels = [];
    if (user.phone && site.whatsapp_api_url) channels.push(triggers.sendWhatsApp(user.phone, text));
    if (site.smtp_host) channels.push(triggers.sendEmail(user.email, `Redefinição de senha - ${site.site_name}`, text));
    if (!channels.length) console.warn(`[senha] nenhum canal configurado para enviar o link a ${user.email}`);
    const results = await Promise.allSettled(channels);
    results.filter((r) => r.status === 'rejected').forEach((r) => console.error('[senha] falha no envio:', r.reason.message));
    done();
  } catch (err) {
    next(err);
  }
});

async function findReset(token) {
  return db.one(
    `SELECT pr.*, u.name, u.email FROM password_resets pr JOIN users u ON u.id = pr.user_id
     WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now() AND u.active`,
    [hashToken(String(token || ''))]);
}

router.get('/redefinir-senha/:token', async (req, res, next) => {
  try {
    const reset = await findReset(req.params.token);
    res.render('reset', { title: 'Nova senha', reset, token: req.params.token });
  } catch (err) {
    next(err);
  }
});

router.post('/redefinir-senha/:token', async (req, res, next) => {
  try {
    const reset = await findReset(req.params.token);
    if (!reset) return res.render('reset', { title: 'Nova senha', reset: null, token: '' });
    const { password, confirm } = req.body;
    let error = null;
    if (!password || password.length < 6) error = 'A senha precisa ter ao menos 6 caracteres.';
    else if (password !== confirm) error = 'A confirmação não confere.';
    if (error) return res.render('reset', { title: 'Nova senha', reset, token: req.params.token, error });
    const used = await db.one(
      'UPDATE password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id', [reset.id]);
    if (!used) return res.render('reset', { title: 'Nova senha', reset: null, token: '' });
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [reset.user_id, await bcrypt.hash(password, 10)]);
    // invalida outros links pendentes e derruba sessões abertas
    await db.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [reset.user_id]);
    await db.query(`DELETE FROM session WHERE (sess->>'userId')::int = $1`, [reset.user_id]).catch(() => {});
    req.session.flash = { type: 'success', message: 'Senha alterada. Entre com a nova senha.' };
    res.redirect('/login');
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/perfil', requireLogin, (req, res) => res.render('student/profile', { title: 'Meu perfil' }));

router.post('/perfil', requireLogin, async (req, res, next) => {
  try {
    const { current, password, confirm } = req.body;
    if (!(await bcrypt.compare(String(current || ''), req.user.password_hash))) {
      req.flash('error', 'Senha atual incorreta.');
    } else if (!password || password.length < 6) {
      req.flash('error', 'A nova senha precisa ter ao menos 6 caracteres.');
    } else if (password !== confirm) {
      req.flash('error', 'A confirmação não confere.');
    } else {
      await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await bcrypt.hash(password, 10)]);
      req.flash('success', 'Senha alterada com sucesso.');
    }
    res.redirect('/perfil');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
