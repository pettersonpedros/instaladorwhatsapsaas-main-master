const db = require('../db');

const DEFAULTS = {
  site_name: 'Central de Treinamentos',
  primary_color: '#2563eb',
  logo_url: '',
  public_url: process.env.PUBLIC_URL || 'http://localhost:3000',
  whatsapp_api_url: '',
  whatsapp_api_token: '',
  smtp_host: '',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',
  webhook_secret: '',
};

let cache = null;

async function getAll() {
  if (cache) return cache;
  const rows = await db.many('SELECT key, value FROM settings');
  const values = { ...DEFAULTS };
  for (const r of rows) values[r.key] = r.value;
  cache = values;
  return values;
}

async function get(key) {
  return (await getAll())[key];
}

async function setMany(obj) {
  for (const [key, value] of Object.entries(obj)) {
    if (!(key in DEFAULTS)) continue;
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, JSON.stringify(value)]
    );
  }
  cache = null;
}

module.exports = { DEFAULTS, getAll, get, setMany };
