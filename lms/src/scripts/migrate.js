require('dotenv').config();
const db = require('../db');

db.migrate()
  .then(() => { console.log('Migrações aplicadas.'); return db.pool.end(); })
  .catch((err) => { console.error(err); process.exit(1); });
