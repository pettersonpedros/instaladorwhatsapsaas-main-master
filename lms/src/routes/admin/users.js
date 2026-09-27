const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const progress = require('../../services/progress');
const triggers = require('../../services/triggers');
const settings = require('../../services/settings');
const { requirePerm } = require('../../middleware');
const { toInt, randomPassword, checkbox } = require('../../util');

const router = express.Router();
const students = requirePerm('students');
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const PERMS = {
  content: 'Editar cursos, aulas, materiais e provas',
  students: 'Cadastrar alunos, empresas e matrículas',
  triggers: 'Gerenciar gatilhos',
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// Somente admin mexe em usuários da equipe.
function assertCanManage(actor, target) {
  if (actor.role !== 'admin' && target.role !== 'student') throw httpError(403, 'Somente administradores gerenciam a equipe.');
}

async function sendAccess(user, password) {
  const site = await settings.getAll();
  const text = `Olá ${user.name.split(' ')[0]}! Seu acesso à ${site.site_name} está pronto.\n\n`
    + `Acesse: ${String(site.public_url).replace(/\/$/, '')}/login\nE-mail: ${user.email}\nSenha: ${password}\n\n`
    + 'Recomendamos trocar a senha no primeiro acesso (menu "Meu perfil").';
  const results = [];
  if (user.phone && site.whatsapp_api_url) {
    await triggers.sendWhatsApp(user.phone, text).then(() => results.push('WhatsApp'), (e) => results.push(`WhatsApp falhou: ${e.message}`));
  }
  if (site.smtp_host) {
    await triggers.sendEmail(user.email, `Seu acesso à ${site.site_name}`, text)
      .then(() => results.push('e-mail'), (e) => results.push(`e-mail falhou: ${e.message}`));
  }
  return results.length ? results.join(', ') : 'nenhum canal configurado (configure WhatsApp ou SMTP)';
}

// ---------- empresas ----------

router.get('/empresas', async (req, res, next) => {
  try {
    const companies = await db.many(`SELECT c.*,
        (SELECT count(*) FROM users u WHERE u.company_id = c.id AND u.role = 'student')::int AS students,
        (SELECT count(*) FROM enrollments e JOIN users u ON u.id = e.user_id WHERE u.company_id = c.id)::int AS enrollments,
        (SELECT count(*) FROM enrollments e JOIN users u ON u.id = e.user_id
          WHERE u.company_id = c.id AND e.completed_at IS NOT NULL)::int AS completed
      FROM companies c ORDER BY c.name`);
    const courses = await db.many('SELECT id, title FROM courses ORDER BY title');
    res.render('admin/companies', { title: 'Empresas / Clientes', companies, courses });
  } catch (err) {
    next(err);
  }
});

router.post('/empresas', students, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (name) await db.query('INSERT INTO companies (name, notes) VALUES ($1, $2)', [name, req.body.notes || '']);
    res.redirect('/admin/empresas');
  } catch (err) {
    next(err);
  }
});

router.post('/empresas/:id', students, async (req, res, next) => {
  try {
    await db.query('UPDATE companies SET name = $2, notes = $3 WHERE id = $1',
      [toInt(req.params.id), String(req.body.name || '').trim(), req.body.notes || '']);
    req.flash('success', 'Empresa atualizada.');
    res.redirect('/admin/empresas');
  } catch (err) {
    next(err);
  }
});

router.post('/empresas/:id/excluir', students, async (req, res, next) => {
  try {
    await db.query('DELETE FROM companies WHERE id = $1', [toInt(req.params.id)]);
    req.flash('success', 'Empresa excluída (os usuários foram mantidos, sem empresa).');
    res.redirect('/admin/empresas');
  } catch (err) {
    next(err);
  }
});

router.post('/empresas/:id/matricular', students, async (req, res, next) => {
  try {
    const courseId = toInt(req.body.course_id);
    const users = await db.many(`SELECT id FROM users WHERE company_id = $1 AND role = 'student' AND active`, [toInt(req.params.id)]);
    let count = 0;
    for (const u of users) if (await progress.enroll(u.id, courseId)) count++;
    req.flash('success', `${count} aluno(s) matriculado(s). Os que já estavam matriculados foram mantidos.`);
    res.redirect('/admin/empresas');
  } catch (err) {
    next(err);
  }
});

// ---------- usuários ----------

router.get('/usuarios', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const role = ['admin', 'staff', 'student'].includes(req.query.role) ? req.query.role : null;
    const company = toInt(req.query.empresa);
    const users = await db.many(
      `SELECT u.*, c.name AS company_name,
         (SELECT count(*) FROM enrollments e WHERE e.user_id = u.id)::int AS enrollments,
         (SELECT count(*) FROM enrollments e WHERE e.user_id = u.id AND e.completed_at IS NOT NULL)::int AS completed
       FROM users u LEFT JOIN companies c ON c.id = u.company_id
       WHERE ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR u.role = $2) AND ($3::int IS NULL OR u.company_id = $3)
       ORDER BY u.name LIMIT 500`, [q, role, company]);
    const companies = await db.many('SELECT id, name FROM companies ORDER BY name');
    const courses = await db.many('SELECT id, title FROM courses ORDER BY title');
    res.render('admin/users', { title: 'Usuários', users, companies, courses, q, role, company, perms: PERMS });
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios', students, async (req, res, next) => {
  try {
    const role = req.user.role === 'admin' && ['admin', 'staff', 'student'].includes(req.body.role) ? req.body.role : 'student';
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = String(req.body.name || '').trim();
    if (!name || !/^\S+@\S+\.\S+$/.test(email)) {
      req.flash('error', 'Informe nome e e-mail válidos.');
      return res.redirect('/admin/usuarios');
    }
    if (await db.one('SELECT id FROM users WHERE lower(email) = $1', [email])) {
      req.flash('error', 'Já existe um usuário com este e-mail.');
      return res.redirect('/admin/usuarios');
    }
    const password = String(req.body.password || '') || randomPassword();
    const perms = Object.fromEntries(Object.keys(PERMS).map((k) => [k, checkbox(req.body[`perm_${k}`])]));
    const user = await db.one(
      `INSERT INTO users (name, email, phone, password_hash, role, perms, company_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, email, String(req.body.phone || '').trim() || null, await bcrypt.hash(password, 10), role,
        JSON.stringify(role === 'staff' ? perms : {}), toInt(req.body.company_id)]);
    for (const cid of [].concat(req.body.courses || []).map(Number).filter(Boolean)) await progress.enroll(user.id, cid);
    let msg = `Usuário criado. Senha: ${password}`;
    if (checkbox(req.body.send_access)) msg += ` — acesso enviado por: ${await sendAccess(user, password)}`;
    req.flash('success', msg);
    res.redirect(`/admin/usuarios/${user.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios/importar', students, csvUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Selecione um arquivo CSV.');
      return res.redirect('/admin/usuarios');
    }
    const text = req.file.buffer.toString('utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const sep = (lines[0] || '').includes(';') ? ';' : ',';
    const courseId = toInt(req.body.course_id);
    const sendAccessFlag = checkbox(req.body.send_access);
    const companyCache = new Map();
    let created = 0;
    let enrolled = 0;
    const problems = [];
    for (const [i, line] of lines.entries()) {
      const [name, email, phone, company] = line.split(sep).map((x) => (x || '').trim().replace(/^"|"$/g, ''));
      if (i === 0 && /nome|name/i.test(name) && /mail/i.test(email)) continue; // cabeçalho
      if (!name || !/^\S+@\S+\.\S+$/.test(email || '')) {
        problems.push(`linha ${i + 1}`);
        continue;
      }
      let companyId = null;
      if (company) {
        const key = company.toLowerCase();
        if (!companyCache.has(key)) {
          const found = await db.one('SELECT id FROM companies WHERE lower(name) = $1', [key])
            || await db.one('INSERT INTO companies (name) VALUES ($1) RETURNING id', [company]);
          companyCache.set(key, found.id);
        }
        companyId = companyCache.get(key);
      }
      let user = await db.one('SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
      if (!user) {
        const password = randomPassword();
        user = await db.one(
          `INSERT INTO users (name, email, phone, password_hash, role, company_id)
           VALUES ($1, lower($2), $3, $4, 'student', $5) RETURNING *`,
          [name, email, phone || null, await bcrypt.hash(password, 10), companyId]);
        created++;
        if (sendAccessFlag) await sendAccess(user, password);
      }
      if (courseId && (await progress.enroll(user.id, courseId))) enrolled++;
    }
    let msg = `Importação concluída: ${created} usuário(s) criado(s), ${enrolled} matrícula(s).`;
    if (!sendAccessFlag && created) msg += ' As senhas foram geradas aleatoriamente — use "Enviar acesso" em cada aluno ou redefina a senha.';
    if (problems.length) msg += ` Ignoradas (nome/e-mail inválido): ${problems.slice(0, 20).join(', ')}.`;
    req.flash(problems.length ? 'error' : 'success', msg);
    res.redirect('/admin/usuarios');
  } catch (err) {
    next(err);
  }
});

router.get('/usuarios/:id', async (req, res, next) => {
  try {
    const target = await db.one(
      'SELECT u.*, c.name AS company_name FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = $1',
      [toInt(req.params.id)]);
    if (!target) throw httpError(404, 'Usuário não encontrado.');
    const enrollments = await db.many(
      `SELECT e.*, c.title FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = $1 ORDER BY e.enrolled_at DESC`,
      [target.id]);
    const details = [];
    for (const e of enrollments) {
      const state = await progress.getCourseState(target.id, e.course_id);
      const lp = await db.many(
        `SELECT lp.* FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id JOIN modules m ON m.id = l.module_id
         WHERE lp.user_id = $1 AND m.course_id = $2`, [target.id, e.course_id]);
      const lpBy = new Map(lp.map((x) => [x.lesson_id, x]));
      const attempts = await db.many(
        `SELECT qa.*, q.title FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id
         WHERE qa.user_id = $1 AND q.course_id = $2 ORDER BY qa.id DESC`, [target.id, e.course_id]);
      details.push({ enrollment: e, state, lpBy, attempts });
    }
    const [activity, jobs, companies, courses, certificates] = await Promise.all([
      db.many(`SELECT a.*, c.title AS course_title, l.title AS lesson_title, q.title AS quiz_title, m.title AS module_title
        FROM activity a LEFT JOIN courses c ON c.id = a.course_id LEFT JOIN lessons l ON l.id = a.lesson_id
        LEFT JOIN quizzes q ON q.id = a.quiz_id LEFT JOIN modules m ON m.id = a.module_id
        WHERE a.user_id = $1 ORDER BY a.id DESC LIMIT 100`, [target.id]),
      db.many(`SELECT j.*, t.name AS trigger_name FROM trigger_jobs j JOIN triggers t ON t.id = j.trigger_id
        WHERE j.user_id = $1 ORDER BY j.id DESC LIMIT 30`, [target.id]),
      db.many('SELECT id, name FROM companies ORDER BY name'),
      db.many('SELECT id, title FROM courses ORDER BY title'),
      db.many('SELECT * FROM certificates WHERE user_id = $1', [target.id]),
    ]);
    res.render('admin/user-detail', {
      title: target.name, target, details, activity, jobs, companies, courses, perms: PERMS,
      certByCourse: new Map(certificates.map((c) => [c.course_id, c])),
    });
  } catch (err) {
    next(err);
  }
});

async function loadTarget(req) {
  const target = await db.one('SELECT * FROM users WHERE id = $1', [toInt(req.params.id)]);
  if (!target) throw httpError(404, 'Usuário não encontrado.');
  assertCanManage(req.user, target);
  return target;
}

router.post('/usuarios/:id', students, async (req, res, next) => {
  try {
    const target = await loadTarget(req);
    const email = String(req.body.email || '').trim().toLowerCase();
    const dup = await db.one('SELECT id FROM users WHERE lower(email) = $1 AND id <> $2', [email, target.id]);
    if (dup) {
      req.flash('error', 'Outro usuário já usa este e-mail.');
      return res.redirect(`/admin/usuarios/${target.id}`);
    }
    let role = target.role;
    let perms = target.perms;
    if (req.user.role === 'admin' && target.id !== req.user.id) {
      role = ['admin', 'staff', 'student'].includes(req.body.role) ? req.body.role : role;
      perms = Object.fromEntries(Object.keys(PERMS).map((k) => [k, checkbox(req.body[`perm_${k}`])]));
    }
    const active = target.id === req.user.id ? true : checkbox(req.body.active);
    await db.query(
      `UPDATE users SET name=$2, email=$3, phone=$4, company_id=$5, role=$6, perms=$7, active=$8 WHERE id=$1`,
      [target.id, String(req.body.name || target.name).trim(), email || target.email,
        String(req.body.phone || '').trim() || null, toInt(req.body.company_id), role, JSON.stringify(perms), active]);
    req.flash('success', 'Usuário atualizado.');
    res.redirect(`/admin/usuarios/${target.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios/:id/senha', students, async (req, res, next) => {
  try {
    const target = await loadTarget(req);
    const password = String(req.body.password || '') || randomPassword();
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [target.id, await bcrypt.hash(password, 10)]);
    let msg = `Nova senha: ${password}`;
    if (checkbox(req.body.send_access)) msg += ` — enviada por: ${await sendAccess(target, password)}`;
    req.flash('success', msg);
    res.redirect(`/admin/usuarios/${target.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios/:id/matricular', students, async (req, res, next) => {
  try {
    const target = await loadTarget(req);
    const row = await progress.enroll(target.id, toInt(req.body.course_id));
    req.flash(row ? 'success' : 'error', row ? 'Matrícula realizada.' : 'O usuário já está matriculado neste curso.');
    res.redirect(`/admin/usuarios/${target.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios/:id/cursos/:courseId/remover', students, async (req, res, next) => {
  try {
    const target = await loadTarget(req);
    await db.query('DELETE FROM enrollments WHERE user_id = $1 AND course_id = $2', [target.id, toInt(req.params.courseId)]);
    req.flash('success', 'Matrícula removida (o histórico de progresso foi mantido).');
    res.redirect(`/admin/usuarios/${target.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios/:id/cursos/:courseId/resetar', students, async (req, res, next) => {
  try {
    const target = await loadTarget(req);
    const courseId = toInt(req.params.courseId);
    await db.tx(async (c) => {
      await c.query(`DELETE FROM lesson_progress lp USING lessons l, modules m
        WHERE lp.lesson_id = l.id AND l.module_id = m.id AND m.course_id = $2 AND lp.user_id = $1`, [target.id, courseId]);
      await c.query(`DELETE FROM module_completions mc USING modules m
        WHERE mc.module_id = m.id AND m.course_id = $2 AND mc.user_id = $1`, [target.id, courseId]);
      await c.query(`DELETE FROM quiz_attempts qa USING quizzes q
        WHERE qa.quiz_id = q.id AND q.course_id = $2 AND qa.user_id = $1`, [target.id, courseId]);
      await c.query('DELETE FROM certificates WHERE user_id = $1 AND course_id = $2', [target.id, courseId]);
      await c.query('UPDATE enrollments SET completed_at = NULL, enrolled_at = now() WHERE user_id = $1 AND course_id = $2',
        [target.id, courseId]);
    });
    req.flash('success', 'Progresso zerado. O aluno recomeça o curso do início.');
    res.redirect(`/admin/usuarios/${target.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios/:id/excluir', students, async (req, res, next) => {
  try {
    const target = await loadTarget(req);
    if (target.id === req.user.id) throw httpError(400, 'Você não pode excluir o próprio usuário.');
    await db.query('DELETE FROM users WHERE id = $1', [target.id]);
    req.flash('success', 'Usuário excluído.');
    res.redirect('/admin/usuarios');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
