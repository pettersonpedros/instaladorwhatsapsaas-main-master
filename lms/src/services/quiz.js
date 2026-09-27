const db = require('../db');
const events = require('./events');
const progress = require('./progress');

const GRACE_SECONDS = 30;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function loadQuestions(quizId) {
  const questions = await db.many('SELECT * FROM questions WHERE quiz_id = $1 ORDER BY position, id', [quizId]);
  const options = await db.many(
    `SELECT o.* FROM question_options o JOIN questions q ON q.id = o.question_id
     WHERE q.quiz_id = $1 ORDER BY o.position, o.id`, [quizId]);
  for (const q of questions) q.options = options.filter((o) => o.question_id === q.id);
  return questions;
}

function deadline(attempt, quiz) {
  if (!quiz.time_limit_minutes) return null;
  return new Date(new Date(attempt.started_at).getTime() + quiz.time_limit_minutes * 60000);
}

function isExpired(attempt, quiz) {
  const d = deadline(attempt, quiz);
  return !!d && Date.now() > d.getTime() + GRACE_SECONDS * 1000;
}

async function startAttempt(userId, quiz) {
  const open = await db.one(
    `SELECT * FROM quiz_attempts WHERE user_id = $1 AND quiz_id = $2 AND status = 'in_progress'
     ORDER BY id DESC LIMIT 1`, [userId, quiz.id]);
  if (open) {
    if (!isExpired(open, quiz)) return open;
    await finishAttempt(open, quiz, {}, { expired: true });
  }
  const used = await db.one(
    `SELECT count(*)::int AS n FROM quiz_attempts WHERE user_id = $1 AND quiz_id = $2 AND status <> 'in_progress'`,
    [userId, quiz.id]);
  if (quiz.max_attempts > 0 && used.n >= quiz.max_attempts) {
    const err = new Error('Você não tem mais tentativas para esta prova.');
    err.status = 403;
    throw err;
  }
  const questions = await loadQuestions(quiz.id);
  const ordered = quiz.shuffle ? shuffle(questions) : questions;
  const order = ordered.map((q) => ({ q: q.id, o: (quiz.shuffle ? shuffle(q.options) : q.options).map((o) => o.id) }));
  return db.one(
    'INSERT INTO quiz_attempts (quiz_id, user_id, question_order) VALUES ($1, $2, $3) RETURNING *',
    [quiz.id, userId, JSON.stringify(order)]);
}

function grade(questions, answers) {
  let earned = 0;
  let total = 0;
  const detail = {};
  for (const q of questions) {
    total += q.points;
    const selected = new Set((answers[q.id] || []).map(Number));
    const correct = new Set(q.options.filter((o) => o.is_correct).map((o) => o.id));
    const ok = selected.size === correct.size && [...correct].every((id) => selected.has(id));
    if (ok) earned += q.points;
    detail[q.id] = { selected: [...selected], correct: ok };
  }
  return { score: total ? Math.round((earned / total) * 100) : 0, detail };
}

async function finishAttempt(attempt, quiz, rawAnswers, { expired = false } = {}) {
  const questions = await loadQuestions(quiz.id);
  const answers = {};
  if (!expired) {
    for (const q of questions) {
      const v = rawAnswers[`q${q.id}`];
      const list = (Array.isArray(v) ? v : v != null ? [v] : []).map(Number)
        .filter((id) => q.options.some((o) => o.id === id));
      answers[q.id] = q.kind === 'multiple' ? list : list.slice(0, 1);
    }
  }
  const { score, detail } = grade(questions, answers);
  const passed = !expired && score >= quiz.pass_score;
  const finished = await db.one(
    `UPDATE quiz_attempts SET status = $2, answers = $3, score = $4, passed = $5, finished_at = now()
     WHERE id = $1 AND status = 'in_progress' RETURNING *`,
    [attempt.id, expired ? 'expired' : 'finished', JSON.stringify(detail), expired ? 0 : score, passed]);
  if (!finished) return db.one('SELECT * FROM quiz_attempts WHERE id = $1', [attempt.id]);

  const used = await db.one(
    `SELECT count(*)::int AS n FROM quiz_attempts WHERE user_id = $1 AND quiz_id = $2 AND status <> 'in_progress'`,
    [attempt.user_id, quiz.id]);
  const ctx = {
    userId: attempt.user_id, courseId: quiz.course_id, moduleId: quiz.module_id, quizId: quiz.id,
    attemptId: attempt.id, score: finished.score,
    attemptsExhausted: !passed && quiz.max_attempts > 0 && used.n >= quiz.max_attempts,
    data: { score: finished.score, attempt: used.n, expired },
  };
  await events.emit(passed ? 'quiz_passed' : 'quiz_failed', ctx);
  if (passed) await progress.syncCompletion(attempt.user_id, quiz.course_id);
  return finished;
}

module.exports = { loadQuestions, startAttempt, finishAttempt, isExpired, deadline, grade, GRACE_SECONDS };
