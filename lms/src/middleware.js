const crypto = require('crypto');
const db = require('./db');

function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.get('x-csrf-token') || (req.body && req.body._csrf) || req.query._csrf;
  if (token && token.length === req.session.csrf.length
      && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf))) return next();
  res.status(403).send('Sessão expirada ou requisição inválida. Volte e recarregue a página.');
}

async function loadUser(req, res, next) {
  res.locals.user = null;
  if (!req.session.userId) return next();
  try {
    const user = await db.one('SELECT * FROM users WHERE id = $1 AND active', [req.session.userId]);
    if (!user) {
      req.session.userId = null;
      return next();
    }
    req.user = user;
    res.locals.user = user;
    const last = user.last_activity_at ? new Date(user.last_activity_at).getTime() : 0;
    if (Date.now() - last > 60000) {
      db.query('UPDATE users SET last_activity_at = now() WHERE id = $1', [user.id]).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not_authenticated' });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function isStaff(user) {
  return user && (user.role === 'admin' || user.role === 'staff');
}

function can(user, perm) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'staff') return false;
  if (perm === 'reports') return true;
  return !!user.perms?.[perm];
}

function requireStaff(req, res, next) {
  if (isStaff(req.user)) return next();
  res.status(403).render('error', { title: 'Acesso negado', message: 'Esta área é restrita à equipe.' });
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (can(req.user, perm)) return next();
    res.status(403).render('error', { title: 'Acesso negado', message: 'Seu usuário não tem permissão para esta ação.' });
  };
}

module.exports = { csrf, loadUser, requireLogin, requireStaff, requirePerm, isStaff, can };
