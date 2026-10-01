/* Envio de e-mail. Com SMTP_URL configurado envia de verdade (nodemailer);
   sem ele, registra na caixa de saída como "simulado" para conferência. */
const nodemailer = require('nodemailer');
const { db } = require('./db');

const FROM = process.env.MAIL_FROM || 'YUV Financeiro <financeiro@yuv.com.br>';
const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;

const splitAddr = s => String(s || '').split(/[;,]/).map(x => x.trim()).filter(Boolean);

async function send({ to, subject, text, attachments = [] }) {
  const list = splitAddr(to);
  const meta = JSON.stringify(attachments.map(a => a.filename));
  const log = (status, error) => db.prepare('INSERT INTO outbox(to_addr,subject,body,attachments,status,error) VALUES(?,?,?,?,?,?)')
    .run(list.join(', '), subject, text, meta, status, error || null).lastInsertRowid;
  if (!list.length) { log('erro', 'sem destinatário'); return { ok: false, error: 'Sem destinatário' }; }
  if (!transport) { log('simulado'); console.log(`[mail:simulado] ${list.join(', ')} — ${subject}`); return { ok: true, simulated: true }; }
  try {
    await transport.sendMail({ from: FROM, to: list, subject, text, attachments });
    log('enviado');
    return { ok: true };
  } catch (e) {
    log('erro', e.message);
    console.error('[mail] falha', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { send, enabled: !!transport };
