const express = require('express');
const settings = require('../../services/settings');
const triggers = require('../../services/triggers');
const { checkbox, toInt } = require('../../util');

const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user.role === 'admin') return next();
  res.status(403).render('error', { title: 'Acesso negado', message: 'Somente administradores.' });
}

router.get('/configuracoes', adminOnly, async (req, res) => {
  res.render('admin/settings', { title: 'Configurações', s: await settings.getAll() });
});

router.post('/configuracoes', adminOnly, async (req, res, next) => {
  try {
    const b = req.body;
    const current = await settings.getAll();
    await settings.setMany({
      site_name: String(b.site_name || '').trim() || current.site_name,
      primary_color: /^#[0-9a-f]{6}$/i.test(b.primary_color) ? b.primary_color : current.primary_color,
      logo_url: String(b.logo_url || '').trim(),
      public_url: String(b.public_url || '').trim().replace(/\/$/, ''),
      whatsapp_api_url: String(b.whatsapp_api_url || '').trim(),
      // campos secretos: em branco = mantém o valor atual
      whatsapp_api_token: b.whatsapp_api_token ? b.whatsapp_api_token.trim() : current.whatsapp_api_token,
      smtp_host: String(b.smtp_host || '').trim(),
      smtp_port: toInt(b.smtp_port, 587),
      smtp_secure: checkbox(b.smtp_secure),
      smtp_user: String(b.smtp_user || '').trim(),
      smtp_pass: b.smtp_pass ? b.smtp_pass : current.smtp_pass,
      smtp_from: String(b.smtp_from || '').trim(),
      webhook_secret: b.webhook_secret ? b.webhook_secret.trim() : current.webhook_secret,
    });
    req.flash('success', 'Configurações salvas.');
    res.redirect('/admin/configuracoes');
  } catch (err) {
    next(err);
  }
});

router.post('/configuracoes/testar-whatsapp', adminOnly, async (req, res) => {
  try {
    req.flash('success', await triggers.sendWhatsApp(req.body.number, 'Teste de integração do LMS ✅'));
  } catch (err) {
    req.flash('error', `Falhou: ${err.message}`);
  }
  res.redirect('/admin/configuracoes');
});

router.post('/configuracoes/testar-email', adminOnly, async (req, res) => {
  try {
    req.flash('success', await triggers.sendEmail(req.body.email, 'Teste do LMS', 'Se você recebeu este e-mail, o SMTP está configurado.'));
  } catch (err) {
    req.flash('error', `Falhou: ${err.message}`);
  }
  res.redirect('/admin/configuracoes');
});

module.exports = router;
