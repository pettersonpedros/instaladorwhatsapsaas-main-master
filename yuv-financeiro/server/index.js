process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
const { build } = require('./app');
const auth = require('./auth');
const scheduler = require('./scheduler');

auth.ensureAdmin();
const port = +process.env.PORT || 3080;
const host = process.env.HOST || '127.0.0.1';
build().listen(port, host, () => {
  console.log(`YUV Financeiro em http://${host}:${port}`);
  if (process.env.SCHEDULER !== '0') scheduler.start();
});
