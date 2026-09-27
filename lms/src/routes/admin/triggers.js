const express = require('express');
const db = require('../../db');
const triggers = require('../../services/triggers');
const { requirePerm } = require('../../middleware');
const { toInt, checkbox } = require('../../util');

const router = express.Router();
const perm = requirePerm('triggers');

async function formData() {
  const [courses, modules, quizzes] = await Promise.all([
    db.many('SELECT id, title FROM courses ORDER BY title'),
    db.many(`SELECT m.id, m.title, m.course_id, c.title AS course_title FROM modules m
             JOIN courses c ON c.id = m.course_id ORDER BY c.title, m.position`),
    db.many(`SELECT q.id, q.title, q.course_id, c.title AS course_title FROM quizzes q
             JOIN courses c ON c.id = q.course_id ORDER BY c.title, q.id`),
  ]);
  return { courses, modules, quizzes, EVENTS: triggers.EVENTS, ACTIONS: triggers.ACTIONS, VARIABLES: triggers.VARIABLES };
}

function parseTrigger(b) {
  const event = triggers.EVENTS[b.event] ? b.event : 'course_completed';
  const action = triggers.ACTIONS[b.action] ? b.action : 'notify_admin';
  const conditions = {};
  if (['course_completed', 'course_not_completed', 'not_started', 'inactive'].includes(event) && toInt(b.days)) {
    conditions.days = toInt(b.days);
  }
  if (event === 'course_completed') conditions.comparison = b.comparison === 'after' ? 'after' : 'within';
  if (triggers.EVENTS[event].scheduled) conditions.include_existing = checkbox(b.include_existing);
  if (event === 'quiz_passed' || event === 'quiz_failed') {
    if (b.min_score !== '' && b.min_score != null) conditions.min_score = toInt(b.min_score);
    if (b.max_score !== '' && b.max_score != null) conditions.max_score = toInt(b.max_score);
    if (event === 'quiz_failed') conditions.attempts_exhausted = checkbox(b.attempts_exhausted);
  }
  const cfg = {};
  if (action === 'whatsapp' || action === 'email') {
    cfg.to = ['custom', 'managers'].includes(b.to) ? b.to : 'student';
    if (cfg.to === 'custom') cfg.to_value = String(b.to_value || '').trim();
    cfg.message = b.message || '';
    if (action === 'email') cfg.subject = b.subject || '';
  }
  if (action === 'webhook') cfg.url = String(b.url || '').trim();
  if (action === 'enroll') cfg.course_id = toInt(b.target_course_id);
  if (action === 'notify_admin') {
    cfg.title = b.notify_title || '';
    cfg.message = b.message || '';
  }
  const delayUnit = { minutes: 1, hours: 60, days: 1440 }[b.delay_unit] || 1;
  return {
    name: String(b.name || '').trim() || triggers.EVENTS[event].label,
    active: checkbox(b.active),
    event,
    course_id: toInt(b.course_id),
    module_id: event === 'module_completed' || event === 'lesson_completed' ? toInt(b.module_id) : null,
    quiz_id: event === 'quiz_passed' || event === 'quiz_failed' ? toInt(b.quiz_id) : null,
    conditions,
    delay_minutes: Math.max(0, (toInt(b.delay, 0) || 0) * delayUnit),
    action,
    action_config: cfg,
  };
}

function validate(t) {
  if (triggers.EVENTS[t.event].scheduled && !t.conditions.days) return 'Informe a quantidade de dias.';
  if (t.action === 'webhook' && !/^https?:\/\//.test(t.action_config.url || '')) return 'Informe a URL do webhook.';
  if (t.action === 'enroll' && !t.action_config.course_id) return 'Escolha o curso de destino.';
  if (['whatsapp', 'email'].includes(t.action) && !t.action_config.message) return 'Escreva a mensagem.';
  if (t.action === 'enroll' && t.event === 'enrolled' && t.action_config.course_id === t.course_id) {
    return 'Um gatilho não pode matricular no mesmo curso que o dispara.';
  }
  return null;
}

router.get('/gatilhos', async (req, res, next) => {
  try {
    const list = await db.many(`SELECT t.*, c.title AS course_title,
        (SELECT count(*) FROM trigger_jobs j WHERE j.trigger_id = t.id AND j.status = 'done')::int AS done,
        (SELECT count(*) FROM trigger_jobs j WHERE j.trigger_id = t.id AND j.status = 'error')::int AS errors,
        (SELECT count(*) FROM trigger_jobs j WHERE j.trigger_id = t.id AND j.status = 'pending')::int AS pending
      FROM triggers t LEFT JOIN courses c ON c.id = t.course_id ORDER BY t.active DESC, t.name`);
    res.render('admin/triggers', { title: 'Gatilhos', list, EVENTS: triggers.EVENTS, ACTIONS: triggers.ACTIONS });
  } catch (err) {
    next(err);
  }
});

router.get('/gatilhos/novo', perm, async (req, res, next) => {
  try {
    const t = {
      id: null, name: '', active: true, event: 'course_completed', conditions: { comparison: 'within' },
      delay_minutes: 0, action: 'whatsapp',
      action_config: { to: 'student', message: 'Parabéns, {{primeiro_nome}}! Você concluiu o curso {{curso}} em {{dias}} dias. Seu certificado: {{link_certificado}}' },
    };
    res.render('admin/trigger-form', { title: 'Novo gatilho', t, ...(await formData()) });
  } catch (err) {
    next(err);
  }
});

router.get('/gatilhos/execucoes', async (req, res, next) => {
  try {
    const status = ['pending', 'done', 'error'].includes(req.query.status) ? req.query.status : null;
    const jobs = await db.many(
      `SELECT j.*, t.name AS trigger_name, u.name AS user_name FROM trigger_jobs j
       JOIN triggers t ON t.id = j.trigger_id JOIN users u ON u.id = j.user_id
       WHERE ($1::text IS NULL OR j.status = $1) AND ($2::int IS NULL OR j.trigger_id = $2)
       ORDER BY j.id DESC LIMIT 300`, [status, toInt(req.query.gatilho)]);
    res.render('admin/trigger-jobs', { title: 'Execuções de gatilhos', jobs, status });
  } catch (err) {
    next(err);
  }
});

router.post('/gatilhos/execucoes/:id/reprocessar', perm, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE trigger_jobs SET status = 'pending', attempts = 0, run_at = now(), last_error = NULL WHERE id = $1`,
      [toInt(req.params.id)]);
    await triggers.processJobs();
    req.flash('success', 'Execução reprocessada.');
    res.redirect('/admin/gatilhos/execucoes');
  } catch (err) {
    next(err);
  }
});

router.get('/gatilhos/:id', perm, async (req, res, next) => {
  try {
    const t = await db.one('SELECT * FROM triggers WHERE id = $1', [toInt(req.params.id)]);
    if (!t) throw Object.assign(new Error('Gatilho não encontrado.'), { status: 404 });
    const students = await db.many(`SELECT id, name FROM users WHERE role IN ('student', 'manager') ORDER BY name LIMIT 500`);
    res.render('admin/trigger-form', { title: t.name, t, students, ...(await formData()) });
  } catch (err) {
    next(err);
  }
});

async function save(req, res, id) {
  const t = parseTrigger(req.body);
  const problem = validate(t);
  if (problem) {
    return res.render('admin/trigger-form', { title: 'Gatilho', t: { ...t, id }, ...(await formData()), flash: { type: 'error', message: problem } });
  }
  const params = [t.name, t.active, t.event, t.course_id, t.module_id, t.quiz_id, JSON.stringify(t.conditions),
    t.delay_minutes, t.action, JSON.stringify(t.action_config)];
  if (id) {
    await db.query(
      `UPDATE triggers SET name=$1, active=$2, event=$3, course_id=$4, module_id=$5, quiz_id=$6, conditions=$7,
         delay_minutes=$8, action=$9, action_config=$10 WHERE id=$11`, [...params, id]);
  } else {
    const row = await db.one(
      `INSERT INTO triggers (name, active, event, course_id, module_id, quiz_id, conditions, delay_minutes, action, action_config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, params);
    id = row.id;
  }
  req.session.flash = { type: 'success', message: 'Gatilho salvo.' };
  res.redirect(`/admin/gatilhos/${id}`);
}

router.post('/gatilhos', perm, (req, res, next) => save(req, res, null).catch(next));
router.post('/gatilhos/:id', perm, (req, res, next) => save(req, res, toInt(req.params.id)).catch(next));

router.post('/gatilhos/:id/alternar', perm, async (req, res, next) => {
  try {
    await db.query('UPDATE triggers SET active = NOT active WHERE id = $1', [toInt(req.params.id)]);
    res.redirect('/admin/gatilhos');
  } catch (err) {
    next(err);
  }
});

router.post('/gatilhos/:id/excluir', perm, async (req, res, next) => {
  try {
    await db.query('DELETE FROM triggers WHERE id = $1', [toInt(req.params.id)]);
    req.flash('success', 'Gatilho excluído.');
    res.redirect('/admin/gatilhos');
  } catch (err) {
    next(err);
  }
});

router.post('/gatilhos/:id/testar', perm, async (req, res, next) => {
  try {
    const t = await db.one('SELECT * FROM triggers WHERE id = $1', [toInt(req.params.id)]);
    const userId = toInt(req.body.user_id);
    let courseId = t.course_id;
    if (!courseId) {
      const e = await db.one('SELECT course_id FROM enrollments WHERE user_id = $1 ORDER BY enrolled_at DESC LIMIT 1', [userId]);
      courseId = e?.course_id || null;
    }
    const result = await triggers.runAction(t, {
      event: t.event, userId, courseId, moduleId: t.module_id, quizId: t.quiz_id, score: 85, daysToComplete: 7, days: t.conditions?.days,
    });
    req.flash('success', `Teste executado: ${result}`);
  } catch (err) {
    req.flash('error', `Teste falhou: ${err.message}`);
  }
  res.redirect(`/admin/gatilhos/${req.params.id}`);
});

module.exports = router;
