const express = require('express');
const db = require('../../db');
const progress = require('../../services/progress');
const { toInt, toCsv, formatDate } = require('../../util');

const router = express.Router();

router.get('/relatorios', async (req, res, next) => {
  try {
    const courses = await db.many(`SELECT c.id, c.title, c.published,
        count(e.id)::int AS enrolled,
        count(e.completed_at)::int AS completed,
        round(avg(EXTRACT(EPOCH FROM (e.completed_at - e.enrolled_at)) / 86400)::numeric, 1) AS avg_days,
        (SELECT count(DISTINCT lp.user_id) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
           JOIN modules m ON m.id = l.module_id WHERE m.course_id = c.id)::int AS started,
        (SELECT round(avg(qa.score)) FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id
           WHERE q.course_id = c.id AND qa.status <> 'in_progress') AS avg_score
      FROM courses c LEFT JOIN enrollments e ON e.course_id = c.id
      GROUP BY c.id ORDER BY c.title`);
    res.render('admin/reports', { title: 'Relatórios', courses });
  } catch (err) {
    next(err);
  }
});

router.get('/relatorios/curso/:id', async (req, res, next) => {
  try {
    const course = await db.one('SELECT * FROM courses WHERE id = $1', [toInt(req.params.id)]);
    if (!course) throw Object.assign(new Error('Curso não encontrado.'), { status: 404 });
    const companyId = toInt(req.query.empresa);
    const status = req.query.status || '';
    const enrollments = await db.many(
      `SELECT e.*, u.name, u.email, u.phone, u.last_activity_at, co.name AS company_name,
         (SELECT max(a.created_at) FROM activity a WHERE a.user_id = e.user_id AND a.course_id = e.course_id) AS last_course_activity
       FROM enrollments e JOIN users u ON u.id = e.user_id LEFT JOIN companies co ON co.id = u.company_id
       WHERE e.course_id = $1 AND ($2::int IS NULL OR u.company_id = $2)
       ORDER BY u.name`, [course.id, companyId]);
    const quizzes = await db.many('SELECT id, title, pass_score FROM quizzes WHERE course_id = $1 ORDER BY id', [course.id]);
    const best = await db.many(
      `SELECT qa.user_id, qa.quiz_id, max(qa.score) AS best, bool_or(qa.passed) AS passed,
              count(*) FILTER (WHERE qa.status <> 'in_progress')::int AS attempts
       FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id
       WHERE q.course_id = $1 AND qa.status <> 'in_progress' GROUP BY qa.user_id, qa.quiz_id`, [course.id]);
    const bestBy = new Map(best.map((b) => [`${b.user_id}:${b.quiz_id}`, b]));

    const rows = [];
    for (const e of enrollments) {
      const state = await progress.getCourseState(e.user_id, course.id);
      const lessonsDone = state.lessons.filter((l) => l.completed).length;
      const started = state.lessons.some((l) => l.percent > 0 || l.completed);
      const s = e.completed_at ? 'concluido' : started ? 'andamento' : 'nao_iniciado';
      if (status && status !== s) continue;
      const currentModule = state.modules.find((m) => !m.completed);
      rows.push({
        e, state, lessonsDone, status: s, currentModule,
        daysToComplete: e.completed_at ? Math.round(((new Date(e.completed_at) - new Date(e.enrolled_at)) / 86400000) * 10) / 10 : null,
        quizzes: quizzes.map((q) => bestBy.get(`${e.user_id}:${q.id}`) || null),
      });
    }

    const lessonStats = await db.many(
      `SELECT l.id, l.title, m.title AS module_title, l.duration_seconds,
         count(lp.user_id)::int AS viewers,
         count(lp.completed_at)::int AS completed,
         round(avg(lp.percent))::int AS avg_percent
       FROM lessons l JOIN modules m ON m.id = l.module_id
       LEFT JOIN lesson_progress lp ON lp.lesson_id = l.id
         AND lp.user_id IN (SELECT e.user_id FROM enrollments e JOIN users u ON u.id = e.user_id
                            WHERE e.course_id = $1 AND ($2::int IS NULL OR u.company_id = $2))
       WHERE m.course_id = $1
       GROUP BY l.id, m.position, m.id ORDER BY m.position, m.id, l.position, l.id`, [course.id, companyId]);

    if (req.query.formato === 'csv') {
      const statusLabel = { concluido: 'Concluído', andamento: 'Em andamento', nao_iniciado: 'Não iniciado' };
      const header = ['Aluno', 'E-mail', 'Telefone', 'Empresa', 'Matrícula', 'Status', 'Progresso %', 'Aulas concluídas',
        'Módulo atual', 'Concluído em', 'Dias para concluir', 'Última atividade no curso',
        ...quizzes.map((q) => `Prova: ${q.title}`)];
      const csvRows = rows.map((r) => [
        r.e.name, r.e.email, r.e.phone, r.e.company_name, formatDate(r.e.enrolled_at), statusLabel[r.status], r.state.percent,
        `${r.lessonsDone}/${r.state.lessons.length}`, r.currentModule?.title || '', formatDate(r.e.completed_at),
        r.daysToComplete ?? '', formatDate(r.e.last_course_activity),
        ...r.quizzes.map((b) => (b ? `${b.best}% ${b.passed ? '(aprovado)' : '(reprovado)'} - ${b.attempts} tent.` : '')),
      ]);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="relatorio-curso-${course.id}.csv"`);
      return res.send(toCsv(header, csvRows));
    }

    const companies = await db.many('SELECT id, name FROM companies ORDER BY name');
    const summary = {
      total: rows.length,
      completed: rows.filter((r) => r.status === 'concluido').length,
      inProgress: rows.filter((r) => r.status === 'andamento').length,
      notStarted: rows.filter((r) => r.status === 'nao_iniciado').length,
    };
    res.render('admin/report-course', {
      title: `Relatório: ${course.title}`, course, rows, quizzes, lessonStats, companies, companyId, status, summary,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/relatorios/aula/:id', async (req, res, next) => {
  try {
    const lesson = await db.one(
      `SELECT l.*, m.course_id, m.title AS module_title, c.title AS course_title
       FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id WHERE l.id = $1`,
      [toInt(req.params.id)]);
    if (!lesson) throw Object.assign(new Error('Aula não encontrada.'), { status: 404 });
    const rows = await db.many(
      `SELECT u.id, u.name, u.email, co.name AS company_name, lp.percent, lp.watched_seconds, lp.started_at,
              lp.completed_at, lp.last_heartbeat_at
       FROM enrollments e JOIN users u ON u.id = e.user_id LEFT JOIN companies co ON co.id = u.company_id
       LEFT JOIN lesson_progress lp ON lp.lesson_id = $1 AND lp.user_id = u.id
       WHERE e.course_id = $2 ORDER BY lp.percent DESC NULLS LAST, u.name`, [lesson.id, lesson.course_id]);
    res.render('admin/report-lesson', { title: `Aula: ${lesson.title}`, lesson, rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
