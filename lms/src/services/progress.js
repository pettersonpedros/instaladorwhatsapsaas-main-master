const db = require('../db');
const { randomCode } = require('../util');
const events = require('./events');

// ---------- segmentos assistidos ----------

function mergeSegments(segments) {
  const sorted = segments
    .filter((s) => Array.isArray(s) && s.length === 2 && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] > s[0])
    .map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10])
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const seg of sorted) {
    const last = out[out.length - 1];
    if (last && seg[0] <= last[1] + 1) last[1] = Math.max(last[1], seg[1]);
    else out.push([...seg]);
  }
  return out;
}

function coverage(segments, duration) {
  let total = 0;
  for (const [a, b] of segments) {
    const s = Math.max(0, a);
    const e = duration ? Math.min(duration, b) : b;
    if (e > s) total += e - s;
  }
  return total;
}

// ---------- estado do curso para um usuário ----------

async function getCourseState(userId, courseId, { bypass = false } = {}) {
  const course = await db.one('SELECT * FROM courses WHERE id = $1', [courseId]);
  if (!course) return null;
  const [enrollment, modules, lessons, quizzes, progress, attempts] = await Promise.all([
    db.one('SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2', [userId, courseId]),
    db.many('SELECT * FROM modules WHERE course_id = $1 ORDER BY position, id', [courseId]),
    db.many(
      `SELECT l.* FROM lessons l JOIN modules m ON m.id = l.module_id
       WHERE m.course_id = $1 ORDER BY m.position, m.id, l.position, l.id`, [courseId]),
    db.many('SELECT * FROM quizzes WHERE course_id = $1 ORDER BY id', [courseId]),
    db.many(
      `SELECT lp.* FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
       JOIN modules m ON m.id = l.module_id WHERE lp.user_id = $1 AND m.course_id = $2`, [userId, courseId]),
    db.many(
      `SELECT qa.quiz_id,
              count(*) FILTER (WHERE qa.status <> 'in_progress')::int AS used,
              max(qa.score) FILTER (WHERE qa.status <> 'in_progress') AS best,
              coalesce(bool_or(qa.passed), false) AS passed,
              max(qa.id) FILTER (WHERE qa.status = 'in_progress') AS open_attempt_id
       FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id
       WHERE qa.user_id = $1 AND q.course_id = $2 GROUP BY qa.quiz_id`, [userId, courseId]),
  ]);

  const progressBy = new Map(progress.map((p) => [p.lesson_id, p]));
  const attemptsBy = new Map(attempts.map((a) => [a.quiz_id, a]));
  const quizById = new Map(quizzes.map((q) => [q.id, q]));
  const now = new Date();

  const quizState = (q, available) => {
    const a = attemptsBy.get(q.id) || { used: 0, best: null, passed: false, open_attempt_id: null };
    const attemptsLeft = q.max_attempts > 0 ? Math.max(0, q.max_attempts - a.used) : Infinity;
    return {
      ...q,
      available: bypass || available,
      passed: a.passed,
      best: a.best,
      used: a.used,
      attemptsLeft,
      openAttemptId: a.open_attempt_id,
      canAttempt: (bypass || available) && !a.passed && (attemptsLeft > 0 || !!a.open_attempt_id),
    };
  };

  const moduleStates = [];
  let prev = null;
  for (const m of modules) {
    const reasons = [];
    if (prev && m.require_previous && !prev.completed) reasons.push(`Conclua o módulo "${prev.title}"`);
    if (m.unlock_quiz_id) {
      const uq = quizById.get(m.unlock_quiz_id);
      const passed = attemptsBy.get(m.unlock_quiz_id)?.passed;
      if (uq && !passed) reasons.push(`Seja aprovado na prova "${uq.title}" (nota mínima ${uq.pass_score}%)`);
    }
    let releaseAt = null;
    if (m.release_after_days && enrollment) {
      releaseAt = new Date(new Date(enrollment.enrolled_at).getTime() + m.release_after_days * 86400000);
      if (releaseAt > now) reasons.push(`Liberado em ${releaseAt.toLocaleDateString('pt-BR')}`);
    }
    const unlocked = bypass || reasons.length === 0;

    const mLessons = [];
    let prevLessonDone = true;
    for (const l of lessons.filter((x) => x.module_id === m.id)) {
      const p = progressBy.get(l.id);
      const completed = !!p?.completed_at;
      const available = unlocked && (bypass || !course.sequential_lessons || prevLessonDone);
      mLessons.push({ ...l, completed, percent: p?.percent || 0, lastPosition: p?.last_position || 0, available });
      prevLessonDone = completed;
    }
    const lessonsDone = mLessons.every((l) => l.completed);
    const mQuizzes = quizzes.filter((q) => q.module_id === m.id).map((q) => quizState(q, unlocked && lessonsDone));
    const completed = lessonsDone && mQuizzes.filter((q) => q.required).every((q) => q.passed);

    const state = { ...m, unlocked, lockReasons: reasons, releaseAt, lessons: mLessons, quizzes: mQuizzes, completed };
    moduleStates.push(state);
    prev = state;
  }

  const allLessons = moduleStates.flatMap((m) => m.lessons);
  const allLessonsDone = allLessons.every((l) => l.completed);
  const finalQuizzes = quizzes.filter((q) => !q.module_id).map((q) => quizState(q, allLessonsDone));

  const requiredQuizzes = [...moduleStates.flatMap((m) => m.quizzes), ...finalQuizzes].filter((q) => q.required);
  const totalItems = allLessons.length + requiredQuizzes.length;
  const doneItems = allLessons.filter((l) => l.completed).length + requiredQuizzes.filter((q) => q.passed).length;
  const completed = totalItems > 0
    && moduleStates.every((m) => m.completed)
    && finalQuizzes.filter((q) => q.required).every((q) => q.passed);

  return {
    course,
    enrollment,
    modules: moduleStates,
    finalQuizzes,
    lessons: allLessons,
    percent: totalItems ? Math.round((doneItems / totalItems) * 100) : 0,
    totalItems,
    doneItems,
    completed,
  };
}

function findLesson(state, lessonId) {
  for (const m of state.modules) {
    const idx = m.lessons.findIndex((l) => l.id === lessonId);
    if (idx >= 0) return { module: m, lesson: m.lessons[idx] };
  }
  return null;
}

function findQuiz(state, quizId) {
  for (const m of state.modules) {
    const q = m.quizzes.find((x) => x.id === quizId);
    if (q) return { module: m, quiz: q };
  }
  const q = state.finalQuizzes.find((x) => x.id === quizId);
  return q ? { module: null, quiz: q } : null;
}

// ---------- conclusão / certificado ----------

async function issueCertificate(userId, courseId) {
  for (let i = 0; i < 5; i++) {
    try {
      await db.query(
        `INSERT INTO certificates (user_id, course_id, code) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, course_id) DO NOTHING`, [userId, courseId, randomCode(10)]);
      break;
    } catch (err) {
      if (err.code !== '23505') throw err; // colisão de código: tenta outro
    }
  }
  return db.one('SELECT * FROM certificates WHERE user_id = $1 AND course_id = $2', [userId, courseId]);
}

// Verifica módulos/curso recém-concluídos e dispara os eventos correspondentes (uma única vez).
async function syncCompletion(userId, courseId) {
  const state = await getCourseState(userId, courseId);
  if (!state || !state.enrollment) return state;
  for (const m of state.modules) {
    if (!m.completed || (m.lessons.length === 0 && m.quizzes.length === 0)) continue;
    const inserted = await db.one(
      `INSERT INTO module_completions (user_id, module_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING RETURNING *`, [userId, m.id]);
    if (inserted) await events.emit('module_completed', { userId, courseId, moduleId: m.id });
  }
  if (state.completed) {
    const updated = await db.one(
      `UPDATE enrollments SET completed_at = now()
       WHERE user_id = $1 AND course_id = $2 AND completed_at IS NULL RETURNING *`, [userId, courseId]);
    if (updated) {
      if (state.course.certificate_enabled) await issueCertificate(userId, courseId);
      const days = (new Date(updated.completed_at) - new Date(updated.enrolled_at)) / 86400000;
      await events.emit('course_completed', { userId, courseId, daysToComplete: Math.round(days * 10) / 10 });
      state.justCompleted = true;
    }
  }
  return state;
}

async function completeLesson(userId, lesson, courseId) {
  const row = await db.one(
    `INSERT INTO lesson_progress (user_id, lesson_id, percent, completed_at)
     VALUES ($1, $2, 100, now())
     ON CONFLICT (user_id, lesson_id) DO UPDATE SET completed_at = now()
       WHERE lesson_progress.completed_at IS NULL
     RETURNING *`, [userId, lesson.id]);
  if (!row) return null;
  await events.emit('lesson_completed', { userId, courseId, moduleId: lesson.module_id, lessonId: lesson.id });
  return syncCompletion(userId, courseId);
}

// ---------- matrícula ----------

async function enroll(userId, courseId, { silent = false } = {}) {
  const row = await db.one(
    `INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2)
     ON CONFLICT (user_id, course_id) DO NOTHING RETURNING *`, [userId, courseId]);
  if (row && !silent) await events.emit('enrolled', { userId, courseId });
  return row;
}

module.exports = {
  mergeSegments, coverage, getCourseState, findLesson, findQuiz,
  syncCompletion, completeLesson, issueCertificate, enroll,
};
