const db = require('../db');
const progress = require('./progress');
const { toCsv, formatDate } = require('../util');

const STATUS_LABEL = { concluido: 'Concluído', andamento: 'Em andamento', nao_iniciado: 'Não iniciado' };

// Relatório de um curso: uma linha por aluno matriculado + funil por aula.
// companyId restringe aos alunos de uma empresa (usado também no painel do gestor).
async function courseReport(courseId, { companyId = null, status = '' } = {}) {
  const course = await db.one('SELECT * FROM courses WHERE id = $1', [courseId]);
  if (!course) return null;
  const enrollments = await db.many(
    `SELECT e.*, u.name, u.email, u.phone, u.last_activity_at, co.name AS company_name,
       (SELECT max(a.created_at) FROM activity a WHERE a.user_id = e.user_id AND a.course_id = e.course_id) AS last_course_activity
     FROM enrollments e JOIN users u ON u.id = e.user_id LEFT JOIN companies co ON co.id = u.company_id
     WHERE e.course_id = $1 AND ($2::int IS NULL OR u.company_id = $2)
     ORDER BY u.name`, [course.id, companyId]);
  const quizzes = await db.many('SELECT id, title, pass_score FROM quizzes WHERE course_id = $1 ORDER BY id', [course.id]);
  const best = await db.many(
    `SELECT qa.user_id, qa.quiz_id, max(qa.score) AS best, bool_or(qa.passed) AS passed, count(*)::int AS attempts
     FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id
     WHERE q.course_id = $1 AND qa.status <> 'in_progress' GROUP BY qa.user_id, qa.quiz_id`, [course.id]);
  const bestBy = new Map(best.map((b) => [`${b.user_id}:${b.quiz_id}`, b]));

  const all = [];
  for (const e of enrollments) {
    const state = await progress.getCourseState(e.user_id, course.id);
    const lessonsDone = state.lessons.filter((l) => l.completed).length;
    const started = state.lessons.some((l) => l.percent > 0 || l.completed);
    all.push({
      e, state, lessonsDone,
      status: e.completed_at ? 'concluido' : started ? 'andamento' : 'nao_iniciado',
      currentModule: state.modules.find((m) => !m.completed),
      daysToComplete: e.completed_at
        ? Math.round(((new Date(e.completed_at) - new Date(e.enrolled_at)) / 86400000) * 10) / 10 : null,
      quizzes: quizzes.map((q) => bestBy.get(`${e.user_id}:${q.id}`) || null),
    });
  }
  const rows = status ? all.filter((r) => r.status === status) : all;

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

  const summary = {
    total: rows.length,
    completed: rows.filter((r) => r.status === 'concluido').length,
    inProgress: rows.filter((r) => r.status === 'andamento').length,
    notStarted: rows.filter((r) => r.status === 'nao_iniciado').length,
  };
  return { course, rows, quizzes, lessonStats, summary };
}

function courseReportCsv({ rows, quizzes }) {
  const header = ['Aluno', 'E-mail', 'Telefone', 'Empresa', 'Matrícula', 'Status', 'Progresso %', 'Aulas concluídas',
    'Módulo atual', 'Concluído em', 'Dias para concluir', 'Última atividade no curso',
    ...quizzes.map((q) => `Prova: ${q.title}`)];
  return toCsv(header, rows.map((r) => [
    r.e.name, r.e.email, r.e.phone, r.e.company_name, formatDate(r.e.enrolled_at), STATUS_LABEL[r.status], r.state.percent,
    `${r.lessonsDone}/${r.state.lessons.length}`, r.status === 'concluido' ? '' : r.currentModule?.title || '',
    formatDate(r.e.completed_at), r.daysToComplete ?? '', formatDate(r.e.last_course_activity),
    ...r.quizzes.map((b) => (b ? `${b.best}% ${b.passed ? '(aprovado)' : '(reprovado)'} - ${b.attempts} tent.` : '')),
  ]));
}

// Detalhe de progresso de um aluno em todos os cursos (ficha do aluno).
async function studentDetails(userId) {
  const enrollments = await db.many(
    `SELECT e.*, c.title FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE e.user_id = $1 ORDER BY e.enrolled_at DESC`,
    [userId]);
  const details = [];
  for (const e of enrollments) {
    const state = await progress.getCourseState(userId, e.course_id);
    const lp = await db.many(
      `SELECT lp.* FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id JOIN modules m ON m.id = l.module_id
       WHERE lp.user_id = $1 AND m.course_id = $2`, [userId, e.course_id]);
    const attempts = await db.many(
      `SELECT qa.*, q.title FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id
       WHERE qa.user_id = $1 AND q.course_id = $2 ORDER BY qa.id DESC`, [userId, e.course_id]);
    details.push({ enrollment: e, state, lpBy: new Map(lp.map((x) => [x.lesson_id, x])), attempts });
  }
  return details;
}

module.exports = { STATUS_LABEL, courseReport, courseReportCsv, studentDetails };
