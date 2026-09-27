const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireLogin } = require('../middleware');

const router = express.Router();

// limite simples de tentativas de login por IP
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, since: now };
  if (now - entry.since > 15 * 60000) { entry.count = 0; entry.since = now; }
  attempts.set(ip, entry);
  return entry;
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
      const fallback = user.role === 'student' ? '/' : '/admin';
      res.redirect(safeNext(req.body.next) || fallback);
    });
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
