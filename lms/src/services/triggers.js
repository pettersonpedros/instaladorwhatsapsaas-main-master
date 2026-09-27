const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../db');
const settings = require('./settings');
const { normalizePhone, formatDate } = require('../util');

const EVENTS = {
  enrolled: { label: 'Aluno foi matriculado no curso', scheduled: false },
  lesson_completed: { label: 'Aluno concluiu uma aula', scheduled: false },
  module_completed: { label: 'Aluno concluiu um módulo', scheduled: false },
  course_completed: { label: 'Aluno concluiu o curso', scheduled: false },
  quiz_passed: { label: 'Aluno foi aprovado em uma prova', scheduled: false },
  quiz_failed: { label: 'Aluno foi reprovado em uma prova', scheduled: false },
  course_not_completed: { label: 'Aluno NÃO concluiu o curso em X dias', scheduled: true },
  not_started: { label: 'Aluno NÃO iniciou o curso em X dias', scheduled: true },
  inactive: { label: 'Aluno está há X dias sem acessar o curso', scheduled: true },
};

const ACTIONS = {
  whatsapp: 'Enviar WhatsApp',
  email: 'Enviar e-mail',
  webhook: 'Chamar webhook (n8n, Zapier, CRM...)',
  enroll: 'Matricular em outro curso',
  notify_admin: 'Notificar no painel admin',
};

const VARIABLES = [
  'nome', 'primeiro_nome', 'email', 'telefone', 'empresa', 'curso', 'modulo', 'prova', 'nota',
  'dias', 'progresso', 'link_curso', 'link_certificado', 'data',
];

function render(template, vars) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in vars && vars[key] != null ? String(vars[key]) : ''));
}

// ---------- avaliação de eventos ----------

function conditionsMatch(trigger, type, ctx) {
  const c = trigger.conditions || {};
  if (type === 'course_completed' && c.days) {
    const days = Number(c.days);
    if (c.comparison === 'after' && !(ctx.daysToComplete > days)) return false;
    if (c.comparison !== 'after' && !(ctx.daysToComplete <= days)) return false;
  }
  if (type === 'quiz_passed' || type === 'quiz_failed') {
    if (c.min_score !== undefined && c.min_score !== null && c.min_score !== '' && ctx.score < Number(c.min_score)) return false;
    if (c.max_score !== undefined && c.max_score !== null && c.max_score !== '' && ctx.score > Number(c.max_score)) return false;
    if (type === 'quiz_failed' && c.attempts_exhausted && !ctx.attemptsExhausted) return false;
  }
  return true;
}

function dedupeSuffix(type, ctx) {
  switch (type) {
    case 'lesson_completed': return `l${ctx.lessonId}`;
    case 'module_completed': return `m${ctx.moduleId}`;
    case 'quiz_passed':
    case 'quiz_failed': return `a${ctx.attemptId}`;
    default: return `c${ctx.courseId}`;
  }
}

async function enqueue(trigger, userId, dedupeKey, context) {
  await db.query(
    `INSERT INTO trigger_jobs (trigger_id, user_id, dedupe_key, context, run_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [trigger.id, userId, dedupeKey, JSON.stringify(context), trigger.delay_minutes || 0]
  );
}

async function handleEvent(type, ctx) {
  if (EVENTS[type]?.scheduled !== false) return;
  const triggers = await db.many(
    `SELECT * FROM triggers WHERE active AND event = $1
       AND (course_id IS NULL OR course_id = $2)
       AND (module_id IS NULL OR module_id = $3)
       AND (quiz_id IS NULL OR quiz_id = $4)`,
    [type, ctx.courseId || null, ctx.moduleId || null, ctx.quizId || null]
  );
  for (const t of triggers) {
    if (!conditionsMatch(t, type, ctx)) continue;
    await enqueue(t, ctx.userId, `${t.id}:${ctx.userId}:${dedupeSuffix(type, ctx)}`, { event: type, ...ctx });
  }
}

// ---------- gatilhos por tempo (varredura periódica) ----------

async function scanScheduled() {
  const triggers = await db.many(
    `SELECT * FROM triggers WHERE active AND event IN ('course_not_completed', 'not_started', 'inactive')`);
  for (const t of triggers) {
    const days = Number(t.conditions?.days || 0);
    if (!days) continue;
    const includeExisting = !!t.conditions?.include_existing;
    const base = `FROM enrollments e
      JOIN users u ON u.id = e.user_id AND u.active AND u.role = 'student'
      JOIN courses c ON c.id = e.course_id AND c.published
      WHERE e.completed_at IS NULL AND ($1::int IS NULL OR e.course_id = $1)`;
    let rows;
    if (t.event === 'inactive') {
      rows = await db.many(
        `SELECT * FROM (
           SELECT e.user_id, e.course_id,
             GREATEST(e.enrolled_at, (SELECT max(a.created_at) FROM activity a
               WHERE a.user_id = e.user_id AND a.course_id = e.course_id)) AS last_seen
           ${base}) x
         WHERE x.last_seen <= now() - make_interval(days => $2)
           AND ($3 OR x.last_seen + make_interval(days => $2) >= $4)`,
        [t.course_id, days, includeExisting, t.created_at]);
      for (const r of rows) {
        const stamp = new Date(r.last_seen).toISOString().slice(0, 10);
        await enqueue(t, r.user_id, `${t.id}:${r.user_id}:c${r.course_id}:${stamp}`,
          { event: t.event, userId: r.user_id, courseId: r.course_id, days });
      }
      continue;
    }
    const notStarted = t.event === 'not_started'
      ? `AND NOT EXISTS (SELECT 1 FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
           JOIN modules m ON m.id = l.module_id WHERE lp.user_id = e.user_id AND m.course_id = e.course_id)
         AND NOT EXISTS (SELECT 1 FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id
           WHERE qa.user_id = e.user_id AND q.course_id = e.course_id)`
      : '';
    rows = await db.many(
      `SELECT e.user_id, e.course_id ${base} ${notStarted}
         AND e.enrolled_at <= now() - make_interval(days => $2)
         AND ($3 OR e.enrolled_at + make_interval(days => $2) >= $4)`,
      [t.course_id, days, includeExisting, t.created_at]);
    for (const r of rows) {
      await enqueue(t, r.user_id, `${t.id}:${r.user_id}:c${r.course_id}`,
        { event: t.event, userId: r.user_id, courseId: r.course_id, days });
    }
  }
}

// ---------- execução das ações ----------

async function buildVars(ctx) {
  const publicUrl = String(await settings.get('public_url')).replace(/\/$/, '');
  const user = await db.one(
    `SELECT u.*, c.name AS company_name FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = $1`,
    [ctx.userId]);
  const course = ctx.courseId ? await db.one('SELECT * FROM courses WHERE id = $1', [ctx.courseId]) : null;
  const mod = ctx.moduleId ? await db.one('SELECT * FROM modules WHERE id = $1', [ctx.moduleId]) : null;
  const quiz = ctx.quizId ? await db.one('SELECT * FROM quizzes WHERE id = $1', [ctx.quizId]) : null;
  const cert = ctx.courseId
    ? await db.one('SELECT * FROM certificates WHERE user_id = $1 AND course_id = $2', [ctx.userId, ctx.courseId])
    : null;
  let progresso = '';
  if (course) {
    const state = await require('./progress').getCourseState(ctx.userId, course.id);
    progresso = `${state.percent}%`;
  }
  return {
    user, course,
    vars: {
      nome: user?.name,
      primeiro_nome: user?.name?.split(' ')[0],
      email: user?.email,
      telefone: user?.phone,
      empresa: user?.company_name,
      curso: course?.title,
      modulo: mod?.title,
      prova: quiz?.title,
      nota: ctx.score != null ? `${ctx.score}%` : '',
      dias: ctx.daysToComplete ?? ctx.days ?? '',
      progresso,
      link_curso: course ? `${publicUrl}/curso/${course.id}` : publicUrl,
      link_certificado: cert ? `${publicUrl}/certificado/${cert.code}` : '',
      data: formatDate(new Date(), false),
    },
  };
}

async function sendWhatsApp(to, text) {
  const s = await settings.getAll();
  if (!s.whatsapp_api_url) throw new Error('API do WhatsApp não configurada (Configurações)');
  const number = normalizePhone(to);
  if (!number) throw new Error('Destinatário sem telefone cadastrado');
  const res = await fetch(s.whatsapp_api_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.whatsapp_api_token}` },
    body: JSON.stringify({ number, body: text }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`WhatsApp HTTP ${res.status}: ${body.slice(0, 300)}`);
  return `WhatsApp enviado para ${number}`;
}

async function sendEmail(to, subject, text) {
  const s = await settings.getAll();
  if (!s.smtp_host) throw new Error('SMTP não configurado (Configurações)');
  if (!to) throw new Error('Destinatário sem e-mail');
  const transport = nodemailer.createTransport({
    host: s.smtp_host,
    port: Number(s.smtp_port) || 587,
    secure: !!s.smtp_secure,
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
  });
  await transport.sendMail({ from: s.smtp_from || s.smtp_user, to, subject, text });
  return `E-mail enviado para ${to}`;
}

async function callWebhook(url, payload) {
  if (!url) throw new Error('URL do webhook não informada');
  const secret = await settings.get('webhook_secret');
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['X-LMS-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Webhook HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return `Webhook respondeu ${res.status}`;
}

async function stillApplies(trigger, ctx) {
  if (!EVENTS[trigger.event]?.scheduled) return true;
  const e = await db.one('SELECT completed_at FROM enrollments WHERE user_id = $1 AND course_id = $2',
    [ctx.userId, ctx.courseId]);
  return e && !e.completed_at;
}

async function runAction(trigger, ctx) {
  const cfg = trigger.action_config || {};
  const { user, course, vars } = await buildVars(ctx);
  if (!user) throw new Error('Usuário não existe mais');
  switch (trigger.action) {
    case 'whatsapp':
      return sendWhatsApp(cfg.to === 'custom' ? cfg.to_value : user.phone, render(cfg.message, vars));
    case 'email':
      return sendEmail(cfg.to === 'custom' ? cfg.to_value : user.email, render(cfg.subject, vars), render(cfg.message, vars));
    case 'webhook':
      return callWebhook(cfg.url, {
        event: ctx.event,
        trigger: { id: trigger.id, name: trigger.name },
        user: { id: user.id, name: user.name, email: user.email, phone: user.phone, company: vars.empresa },
        course: course ? { id: course.id, title: course.title } : null,
        context: ctx,
        variables: vars,
        sent_at: new Date().toISOString(),
      });
    case 'enroll': {
      const target = Number(cfg.course_id);
      if (!target) throw new Error('Curso de destino não informado');
      const row = await require('./progress').enroll(user.id, target);
      return row ? `Matriculado no curso #${target}` : `Já estava matriculado no curso #${target}`;
    }
    case 'notify_admin':
      await db.query('INSERT INTO notifications (title, body, link) VALUES ($1, $2, $3)',
        [render(cfg.title || trigger.name, vars), render(cfg.message, vars), `/admin/usuarios/${user.id}`]);
      return 'Notificação criada';
    default:
      throw new Error(`Ação desconhecida: ${trigger.action}`);
  }
}

const MAX_ATTEMPTS = 3;

async function processJobs() {
  const jobs = await db.many(
    `UPDATE trigger_jobs SET status = 'running', attempts = attempts + 1
     WHERE id IN (SELECT id FROM trigger_jobs WHERE status = 'pending' AND run_at <= now()
                  ORDER BY run_at LIMIT 20 FOR UPDATE SKIP LOCKED)
     RETURNING *`);
  for (const job of jobs) {
    try {
      const trigger = await db.one('SELECT * FROM triggers WHERE id = $1', [job.trigger_id]);
      let result;
      if (!trigger || !trigger.active) result = 'Ignorado: gatilho desativado';
      else if (!(await stillApplies(trigger, job.context))) result = 'Ignorado: aluno já concluiu o curso';
      else result = await runAction(trigger, job.context);
      await db.query(
        `UPDATE trigger_jobs SET status = 'done', result = $2, last_error = NULL, finished_at = now() WHERE id = $1`,
        [job.id, result]);
    } catch (err) {
      const final = job.attempts >= MAX_ATTEMPTS;
      await db.query(
        `UPDATE trigger_jobs SET status = $2, last_error = $3,
           run_at = now() + make_interval(mins => $4), finished_at = CASE WHEN $2 = 'error' THEN now() END
         WHERE id = $1`,
        [job.id, final ? 'error' : 'pending', String(err.message || err).slice(0, 1000), 5 * job.attempts]);
    }
  }
  return jobs.length;
}

let timers = [];
function startWorker() {
  db.query(`UPDATE trigger_jobs SET status = 'pending' WHERE status = 'running'`).catch(() => {});
  const safe = (fn, name) => () => fn().catch((err) => console.error(`[gatilhos] ${name}:`, err.message));
  timers.push(setInterval(safe(processJobs, 'processJobs'), 15000));
  timers.push(setInterval(safe(scanScheduled, 'scanScheduled'), 5 * 60000));
  setTimeout(safe(scanScheduled, 'scanScheduled'), 5000);
}
function stopWorker() {
  timers.forEach(clearInterval);
  timers = [];
}

module.exports = {
  EVENTS, ACTIONS, VARIABLES, render, conditionsMatch, handleEvent, scanScheduled, processJobs,
  runAction, sendWhatsApp, sendEmail, startWorker, stopWorker,
};
