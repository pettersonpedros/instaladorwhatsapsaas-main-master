/* pm2 — usa um Node 22 próprio, sem mexer no Node do resto da VPS */
const path = require('path');
module.exports = {
  apps: [{
    name: 'yuv-financeiro',
    cwd: path.join(__dirname, '..'),
    script: 'server/index.js',
    interpreter: process.env.YUV_NODE || '/opt/node-v22.22.0/bin/node',
    node_args: '--env-file=.env',
    exec_mode: 'fork',
    instances: 1, // uma instância só: o agendador vive no processo
    autorestart: true,
    max_memory_restart: '400M',
    time: true
  }]
};
