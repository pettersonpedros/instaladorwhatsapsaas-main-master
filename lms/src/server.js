require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const db = require('./db');
const settings = require('./services/settings');
const triggers = require('./services/triggers');
const util = require('./util');
const { csrf, loadUser, isStaff, can } = require('./middleware');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://www.youtube.com', 'https://s.ytimg.com'],
        frameSrc: ['https://www.youtube.com', 'https://www.youtube-nocookie.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    // o player do YouTube precisa do referrer para funcionar (erro 153 sem ele)
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));

  app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '256kb' }));
  app.use(session({
    store: new PgSession({ pool: db.pool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'troque-este-segredo',
    resave: false,
    saveUninitialized: false,
    name: 'lms.sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 30 * 24 * 3600 * 1000,
    },
  }));

  app.use(async (req, res, next) => {
    try {
      res.locals.site = await settings.getAll();
      res.locals.util = util;
      res.locals.isStaff = isStaff;
      res.locals.can = can;
      res.locals.path = req.path;
      res.locals.flash = req.session.flash || null;
      delete req.session.flash;
      req.flash = (type, message) => { req.session.flash = { type, message }; };
      next();
    } catch (err) {
      next(err);
    }
  });
  app.use(csrf);
  app.use(loadUser);

  app.use(require('./routes/auth'));
  app.use(require('./routes/student'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => res.status(404).render('error', { title: 'Página não encontrada', message: 'O endereço acessado não existe.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: err.message });
    res.status(status).render('error', {
      title: status >= 500 ? 'Erro interno' : 'Não foi possível continuar',
      message: status >= 500 ? 'Algo deu errado. Tente novamente.' : err.message,
    });
  });
  return app;
}

async function main() {
  await db.migrate();
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`LMS rodando em http://localhost:${port}`));
  if (process.env.DISABLE_WORKER !== 'true') triggers.startWorker();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp };
