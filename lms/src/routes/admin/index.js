const express = require('express');
const db = require('../../db');
const { requireLogin, requireStaff } = require('../../middleware');

const router = express.Router();
router.use(requireLogin, requireStaff);

router.use(async (req, res, next) => {
  try {
    const n = await db.one('SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL');
    res.locals.unreadNotifications = n.n;
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const [kpi, courses, recent, failedJobs, notifications] = await Promise.all([
      db.one(`SELECT
        (SELECT count(*) FROM users WHERE role = 'student' AND active)::int AS students,
        (SELECT count(*) FROM users WHERE role = 'student' AND last_activity_at > now() - interval '7 days')::int AS active7,
        (SELECT count(*) FROM courses WHERE published)::int AS courses,
        (SELECT count(*) FROM enrollments)::int AS enrollments,
        (SELECT count(*) FROM enrollments WHERE completed_at IS NOT NULL)::int AS completions,
        (SELECT count(*) FROM enrollments WHERE completed_at > now() - interval '30 days')::int AS completions30,
        (SELECT count(*) FROM trigger_jobs WHERE status = 'pending')::int AS pending_jobs`),
      db.many(`SELECT c.id, c.title, c.published,
          count(e.id)::int AS enrolled,
          count(e.completed_at)::int AS completed
        FROM courses c LEFT JOIN enrollments e ON e.course_id = c.id
        GROUP BY c.id ORDER BY enrolled DESC, c.title LIMIT 10`),
      db.many(`SELECT a.*, u.name AS user_name, c.title AS course_title, l.title AS lesson_title, q.title AS quiz_title,
          m.title AS module_title
        FROM activity a JOIN users u ON u.id = a.user_id
        LEFT JOIN courses c ON c.id = a.course_id LEFT JOIN lessons l ON l.id = a.lesson_id
        LEFT JOIN quizzes q ON q.id = a.quiz_id LEFT JOIN modules m ON m.id = a.module_id
        WHERE a.type NOT IN ('login', 'lesson_viewed')
        ORDER BY a.id DESC LIMIT 25`),
      db.many(`SELECT j.*, t.name AS trigger_name, u.name AS user_name FROM trigger_jobs j
        JOIN triggers t ON t.id = j.trigger_id JOIN users u ON u.id = j.user_id
        WHERE j.status = 'error' ORDER BY j.id DESC LIMIT 5`),
      db.many('SELECT * FROM notifications WHERE read_at IS NULL ORDER BY id DESC LIMIT 10'),
    ]);
    res.render('admin/dashboard', { title: 'Painel', kpi, courses, recent, failedJobs, notifications });
  } catch (err) {
    next(err);
  }
});

router.post('/notificacoes/lidas', async (req, res, next) => {
  try {
    await db.query('UPDATE notifications SET read_at = now() WHERE read_at IS NULL');
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

router.use(require('./courses'));
router.use(require('./users'));
router.use(require('./reports'));
router.use(require('./triggers'));
router.use(require('./settings'));

module.exports = router;
