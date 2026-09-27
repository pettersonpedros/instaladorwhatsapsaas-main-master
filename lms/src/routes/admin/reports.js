const express = require('express');
const db = require('../../db');
const reports = require('../../services/reports');
const { toInt } = require('../../util');

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
    const companyId = toInt(req.query.empresa);
    const status = req.query.status || '';
    const report = await reports.courseReport(toInt(req.params.id), { companyId, status });
    if (!report) throw Object.assign(new Error('Curso não encontrado.'), { status: 404 });
    if (req.query.formato === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="relatorio-curso-${report.course.id}.csv"`);
      return res.send(reports.courseReportCsv(report));
    }
    const companies = await db.many('SELECT id, name FROM companies ORDER BY name');
    res.render('admin/report-course', {
      title: `Relatório: ${report.course.title}`, ...report, companies, companyId, status,
      links: { back: '/admin/relatorios', user: (id) => `/admin/usuarios/${id}`, lesson: (id) => `/admin/relatorios/aula/${id}` },
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
