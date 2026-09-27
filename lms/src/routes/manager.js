// Painel do gestor da empresa-cliente: visão somente leitura dos alunos da própria empresa.
const express = require('express');
const db = require('../db');
const reports = require('../services/reports');
const { requireLogin } = require('../middleware');
const { toInt } = require('../util');

const router = express.Router();

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

router.use(requireLogin, async (req, res, next) => {
  try {
    if (req.user.role !== 'manager') throw httpError(403, 'Área exclusiva para gestores de empresas.');
    if (!req.user.company_id) throw httpError(403, 'Seu usuário de gestor não está vinculado a nenhuma empresa. Fale com o suporte.');
    req.company = await db.one('SELECT * FROM companies WHERE id = $1', [req.user.company_id]);
    res.locals.company = req.company;
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const cid = req.company.id;
    const [kpi, courses, people, stalled] = await Promise.all([
      db.one(`SELECT
          (SELECT count(*) FROM users WHERE company_id = $1 AND role IN ('student', 'manager') AND active)::int AS people,
          (SELECT count(*) FROM users WHERE company_id = $1 AND active AND last_activity_at > now() - interval '7 days')::int AS active7,
          (SELECT count(*) FROM enrollments e JOIN users u ON u.id = e.user_id WHERE u.company_id = $1)::int AS enrollments,
          (SELECT count(*) FROM enrollments e JOIN users u ON u.id = e.user_id
             WHERE u.company_id = $1 AND e.completed_at IS NOT NULL)::int AS completed`, [cid]),
      db.many(`SELECT c.id, c.title, count(e.id)::int AS enrolled, count(e.completed_at)::int AS completed
        FROM courses c JOIN enrollments e ON e.course_id = c.id JOIN users u ON u.id = e.user_id
        WHERE u.company_id = $1 GROUP BY c.id ORDER BY c.title`, [cid]),
      db.many(`SELECT u.id, u.name, u.email, u.last_activity_at,
          count(e.id)::int AS enrollments, count(e.completed_at)::int AS completed
        FROM users u LEFT JOIN enrollments e ON e.user_id = u.id
        WHERE u.company_id = $1 AND u.role IN ('student', 'manager') AND u.active
        GROUP BY u.id ORDER BY u.name`, [cid]),
      db.many(`SELECT u.id, u.name, c.title AS course_title,
          GREATEST(e.enrolled_at, (SELECT max(a.created_at) FROM activity a
            WHERE a.user_id = e.user_id AND a.course_id = e.course_id)) AS last_seen
        FROM enrollments e JOIN users u ON u.id = e.user_id JOIN courses c ON c.id = e.course_id
        WHERE u.company_id = $1 AND u.active AND e.completed_at IS NULL AND c.published
        ORDER BY last_seen`, [cid]),
    ]);
    const cutoff = Date.now() - 7 * 86400000;
    res.render('manager/index', {
      title: 'Minha equipe', kpi, courses, people,
      stalled: stalled.filter((s) => new Date(s.last_seen).getTime() < cutoff),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/curso/:id', async (req, res, next) => {
  try {
    const status = req.query.status || '';
    const report = await reports.courseReport(toInt(req.params.id), { companyId: req.company.id, status });
    if (!report) throw httpError(404, 'Curso não encontrado.');
    const any = await db.one(
      `SELECT 1 FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.course_id = $1 AND u.company_id = $2 LIMIT 1`,
      [report.course.id, req.company.id]);
    if (!any) throw httpError(404, 'Nenhum aluno da sua empresa neste curso.');
    if (req.query.formato === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="relatorio-curso-${report.course.id}.csv"`);
      return res.send(reports.courseReportCsv(report));
    }
    res.render('manager/course', {
      title: report.course.title, ...report, status,
      links: { back: '/gestor', user: (id) => `/gestor/aluno/${id}`, lesson: null },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/aluno/:id', async (req, res, next) => {
  try {
    const target = await db.one(
      `SELECT * FROM users WHERE id = $1 AND company_id = $2 AND role IN ('student', 'manager')`,
      [toInt(req.params.id), req.company.id]);
    if (!target) throw httpError(404, 'Aluno não encontrado na sua empresa.');
    const [details, activity, certificates] = await Promise.all([
      reports.studentDetails(target.id),
      db.many(`SELECT a.*, c.title AS course_title, l.title AS lesson_title, q.title AS quiz_title, m.title AS module_title
        FROM activity a LEFT JOIN courses c ON c.id = a.course_id LEFT JOIN lessons l ON l.id = a.lesson_id
        LEFT JOIN quizzes q ON q.id = a.quiz_id LEFT JOIN modules m ON m.id = a.module_id
        WHERE a.user_id = $1 AND a.type <> 'lesson_viewed' ORDER BY a.id DESC LIMIT 60`, [target.id]),
      db.many('SELECT * FROM certificates WHERE user_id = $1', [target.id]),
    ]);
    res.render('manager/student', {
      title: target.name, target, details, activity, manage: false,
      certByCourse: new Map(certificates.map((c) => [c.course_id, c])),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
