const path = require('path');
const express = require('express');
const db = require('../db');
const progress = require('../services/progress');
const quizService = require('../services/quiz');
const events = require('../services/events');
const { requireLogin, isStaff } = require('../middleware');
const { toInt } = require('../util');

const router = express.Router();
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function courseAccess(req, courseId) {
  const staff = isStaff(req.user);
  const state = await progress.getCourseState(req.user.id, courseId, { bypass: staff });
  if (!state) throw httpError(404, 'Curso não encontrado.');
  if (staff) return { state, preview: !state.enrollment };
  if (!state.enrollment || !state.course.published) throw httpError(403, 'Você não está matriculado neste curso.');
  return { state, preview: false };
}

function lockedReason(state, moduleState) {
  if (!moduleState.unlocked) return moduleState.lockReasons.join(' • ');
  return 'Conclua a aula anterior para liberar esta.';
}

// ---------- certificados (verificação pública) ----------

router.get('/certificado/:code', async (req, res, next) => {
  try {
    const cert = await db.one(
      `SELECT ce.*, u.name AS user_name, c.title AS course_title, c.workload_hours
       FROM certificates ce JOIN users u ON u.id = ce.user_id JOIN courses c ON c.id = ce.course_id
       WHERE ce.code = $1`, [String(req.params.code).toUpperCase()]);
    if (!cert) throw httpError(404, 'Certificado não encontrado.');
    res.render('student/certificate', { title: 'Certificado', cert });
  } catch (err) {
    next(err);
  }
});

router.use(requireLogin);

// ---------- home ----------

router.get('/', async (req, res, next) => {
  try {
    const staff = isStaff(req.user);
    const courses = staff
      ? await db.many('SELECT * FROM courses ORDER BY published DESC, title')
      : await db.many(
        `SELECT c.* FROM courses c JOIN enrollments e ON e.course_id = c.id
         WHERE e.user_id = $1 AND c.published ORDER BY e.enrolled_at DESC`, [req.user.id]);
    const cards = [];
    for (const c of courses) {
      const state = await progress.getCourseState(req.user.id, c.id, { bypass: staff });
      const next = state.lessons.find((l) => !l.completed && l.available);
      cards.push({ course: c, percent: state.percent, completed: !!state.enrollment?.completed_at, next,
        lessonsCount: state.lessons.length, enrolled: !!state.enrollment });
    }
    res.render('student/home', { title: 'Meus cursos', cards, staff });
  } catch (err) {
    next(err);
  }
});

// ---------- curso ----------

router.get('/curso/:id', async (req, res, next) => {
  try {
    const { state, preview } = await courseAccess(req, toInt(req.params.id));
    const materials = await db.many(
      'SELECT * FROM materials WHERE course_id = $1 AND lesson_id IS NULL ORDER BY id', [state.course.id]);
    const cert = await db.one('SELECT * FROM certificates WHERE user_id = $1 AND course_id = $2',
      [req.user.id, state.course.id]);
    const next = state.lessons.find((l) => !l.completed && l.available);
    res.render('student/course', { title: state.course.title, state, preview, materials, cert, next, lockedReason });
  } catch (err) {
    next(err);
  }
});

// ---------- aula ----------

router.get('/aula/:id', async (req, res, next) => {
  try {
    const lessonId = toInt(req.params.id);
    const row = await db.one(
      'SELECT m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1', [lessonId]);
    if (!row) throw httpError(404, 'Aula não encontrada.');
    const { state, preview } = await courseAccess(req, row.course_id);
    const found = progress.findLesson(state, lessonId);
    if (!found.lesson.available) {
      req.flash('error', `Aula bloqueada: ${lockedReason(state, found.module)}`);
      return res.redirect(`/curso/${state.course.id}`);
    }
    const idx = state.lessons.findIndex((l) => l.id === lessonId);
    const prevLesson = state.lessons[idx - 1] || null;
    const nextLesson = state.lessons[idx + 1] || null;
    const [materials, lp] = await Promise.all([
      db.many('SELECT * FROM materials WHERE lesson_id = $1 ORDER BY id', [lessonId]),
      db.one('SELECT * FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2', [req.user.id, lessonId]),
    ]);
    if (!preview) {
      await events.log('lesson_viewed', { userId: req.user.id, courseId: state.course.id, moduleId: found.module.id, lessonId });
    }
    const threshold = found.lesson.min_watch_percent || state.course.min_watch_percent;
    const maxWatched = (lp?.segments || []).reduce((max, s) => Math.max(max, s[1]), 0);
    res.render('student/lesson', {
      title: found.lesson.title, state, preview, module: found.module, lesson: found.lesson,
      prevLesson, nextLesson, materials, threshold, maxWatched,
      moduleQuizzes: found.module.quizzes,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/api/progress/:lessonId', async (req, res, next) => {
  try {
    const lessonId = toInt(req.params.lessonId);
    const lesson = await db.one(
      `SELECT l.*, m.course_id, c.min_watch_percent AS course_min
       FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id WHERE l.id = $1`,
      [lessonId]);
    if (!lesson || !lesson.youtube_id) throw httpError(404, 'Aula não encontrada.');
    const { state, preview } = await courseAccess(req, lesson.course_id);
    const found = progress.findLesson(state, lessonId);
    if (!found.lesson.available) throw httpError(403, 'Aula bloqueada.');

    let duration = lesson.duration_seconds;
    const reported = Number(req.body.duration);
    if (!duration && reported > 0 && reported < 86400) {
      duration = Math.round(reported);
      await db.query('UPDATE lessons SET duration_seconds = $2 WHERE id = $1 AND duration_seconds IS NULL', [lessonId, duration]);
    }
    if (preview || !duration) return res.json({ ok: true, preview, percent: 0 });

    const position = Math.max(0, Math.min(duration, Number(req.body.position) || 0));
    const incoming = (Array.isArray(req.body.segments) ? req.body.segments : []).slice(0, 100)
      .map((s) => [Math.max(0, Number(s?.[0])), Math.min(duration, Number(s?.[1]))]);

    const existing = await db.one('SELECT * FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2', [req.user.id, lessonId]);
    const oldSegments = existing?.segments || [];
    const oldCoverage = progress.coverage(oldSegments, duration);
    let segments = progress.mergeSegments([...oldSegments, ...incoming]);
    let watched = progress.coverage(segments, duration);

    // Anti-fraude: o ganho não pode ser maior que o tempo real decorrido (com folga p/ velocidade 2x).
    const elapsed = existing ? (Date.now() - new Date(existing.last_heartbeat_at).getTime()) / 1000 : 30;
    const allowed = elapsed * 2.1 + 10;
    let rejected = false;
    if (watched - oldCoverage > allowed) {
      segments = oldSegments;
      watched = oldCoverage;
      rejected = true;
    }
    const percent = Math.min(100, Math.floor((watched / duration) * 100));
    const threshold = lesson.min_watch_percent || lesson.course_min;

    await db.query(
      `INSERT INTO lesson_progress (user_id, lesson_id, segments, watched_seconds, last_position, percent, last_heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id, lesson_id) DO UPDATE SET segments = $3, watched_seconds = $4,
         last_position = $5, percent = GREATEST(lesson_progress.percent, $6), last_heartbeat_at = now()`,
      [req.user.id, lessonId, JSON.stringify(segments), Math.round(watched), Math.round(position), percent]);
    if (!existing) {
      await events.log('lesson_started', { userId: req.user.id, courseId: lesson.course_id, moduleId: lesson.module_id, lessonId });
    }

    let completed = !!existing?.completed_at;
    let courseCompleted = false;
    if (!completed && percent >= threshold) {
      const after = await progress.completeLesson(req.user.id, lesson, lesson.course_id);
      completed = true;
      courseCompleted = !!after?.justCompleted;
    }
    res.json({ ok: true, percent, completed, courseCompleted, rejected, threshold });
  } catch (err) {
    next(err);
  }
});

router.post('/aula/:id/concluir', async (req, res, next) => {
  try {
    const lessonId = toInt(req.params.id);
    const lesson = await db.one(
      'SELECT l.*, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1', [lessonId]);
    if (!lesson) throw httpError(404, 'Aula não encontrada.');
    const { state, preview } = await courseAccess(req, lesson.course_id);
    const found = progress.findLesson(state, lessonId);
    if (lesson.youtube_id) throw httpError(400, 'Aulas com vídeo são concluídas assistindo ao vídeo.');
    if (!found.lesson.available) throw httpError(403, 'Aula bloqueada.');
    if (!preview) await progress.completeLesson(req.user.id, lesson, lesson.course_id);
    const idx = state.lessons.findIndex((l) => l.id === lessonId);
    const nextLesson = state.lessons[idx + 1];
    res.redirect(nextLesson ? `/aula/${nextLesson.id}` : `/curso/${lesson.course_id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- materiais ----------

router.get('/material/:id', async (req, res, next) => {
  try {
    const mat = await db.one('SELECT * FROM materials WHERE id = $1', [toInt(req.params.id)]);
    if (!mat) throw httpError(404, 'Material não encontrado.');
    const { state } = await courseAccess(req, mat.course_id);
    if (mat.lesson_id) {
      const found = progress.findLesson(state, mat.lesson_id);
      if (!found?.lesson.available) throw httpError(403, 'Material bloqueado.');
    } else if (mat.module_id) {
      const m = state.modules.find((x) => x.id === mat.module_id);
      if (!m?.unlocked) throw httpError(403, 'Material bloqueado.');
    }
    await events.log('material_opened', { userId: req.user.id, courseId: mat.course_id, data: { materialId: mat.id } });
    if (mat.kind === 'link') return res.redirect(mat.url);
    const file = path.resolve(UPLOAD_DIR, mat.file_path);
    if (!file.startsWith(UPLOAD_DIR + path.sep)) throw httpError(400, 'Arquivo inválido.');
    res.download(file, mat.file_name);
  } catch (err) {
    next(err);
  }
});

// ---------- provas ----------

async function quizAccess(req, quizId) {
  const quiz = await db.one('SELECT * FROM quizzes WHERE id = $1', [quizId]);
  if (!quiz) throw httpError(404, 'Prova não encontrada.');
  const { state, preview } = await courseAccess(req, quiz.course_id);
  const found = progress.findQuiz(state, quizId);
  return { quiz, state, preview, qs: found.quiz, module: found.module };
}

router.get('/prova/:id', async (req, res, next) => {
  try {
    const { quiz, state, preview, qs, module } = await quizAccess(req, toInt(req.params.id));
    const attempts = await db.many(
      `SELECT * FROM quiz_attempts WHERE user_id = $1 AND quiz_id = $2 AND status <> 'in_progress' ORDER BY id DESC`,
      [req.user.id, quiz.id]);
    const count = await db.one('SELECT count(*)::int AS n FROM questions WHERE quiz_id = $1', [quiz.id]);
    const unlocks = await db.many('SELECT title FROM modules WHERE unlock_quiz_id = $1 ORDER BY position', [quiz.id]);
    res.render('student/quiz', { title: quiz.title, quiz, state, preview, qs, module, attempts, questionCount: count.n, unlocks });
  } catch (err) {
    next(err);
  }
});

router.post('/prova/:id/iniciar', async (req, res, next) => {
  try {
    const { quiz, qs, preview } = await quizAccess(req, toInt(req.params.id));
    if (preview) throw httpError(400, 'Pré-visualização: a equipe não realiza provas. Use um usuário aluno para testar.');
    if (!qs.available) throw httpError(403, 'Conclua as aulas do módulo para liberar esta prova.');
    if (qs.passed) throw httpError(400, 'Você já foi aprovado nesta prova.');
    const attempt = await quizService.startAttempt(req.user.id, quiz);
    res.redirect(`/prova/${quiz.id}/tentativa/${attempt.id}`);
  } catch (err) {
    next(err);
  }
});

async function loadAttempt(req) {
  const ctx = await quizAccess(req, toInt(req.params.id));
  const attempt = await db.one('SELECT * FROM quiz_attempts WHERE id = $1 AND quiz_id = $2 AND user_id = $3',
    [toInt(req.params.aid), ctx.quiz.id, req.user.id]);
  if (!attempt) throw httpError(404, 'Tentativa não encontrada.');
  return { ...ctx, attempt };
}

router.get('/prova/:id/tentativa/:aid', async (req, res, next) => {
  try {
    const { quiz, attempt, state } = await loadAttempt(req);
    if (attempt.status !== 'in_progress') return res.redirect(`/prova/${quiz.id}/resultado/${attempt.id}`);
    if (quizService.isExpired(attempt, quiz)) {
      await quizService.finishAttempt(attempt, quiz, {}, { expired: true });
      return res.redirect(`/prova/${quiz.id}/resultado/${attempt.id}`);
    }
    const questions = await quizService.loadQuestions(quiz.id);
    const byId = new Map(questions.map((q) => [q.id, q]));
    const ordered = attempt.question_order.map(({ q, o }) => {
      const question = byId.get(q);
      if (!question) return null;
      const opts = new Map(question.options.map((x) => [x.id, x]));
      const options = o.map((id) => opts.get(id)).filter(Boolean);
      question.options.forEach((x) => { if (!o.includes(x.id)) options.push(x); });
      return { ...question, options };
    }).filter(Boolean);
    questions.forEach((q) => { if (!attempt.question_order.some((x) => x.q === q.id)) ordered.push(q); });
    const deadline = quizService.deadline(attempt, quiz);
    res.render('student/quiz-attempt', { title: quiz.title, quiz, attempt, questions: ordered, deadline, state });
  } catch (err) {
    next(err);
  }
});

router.post('/prova/:id/tentativa/:aid', async (req, res, next) => {
  try {
    const { quiz, attempt } = await loadAttempt(req);
    if (attempt.status === 'in_progress') {
      await quizService.finishAttempt(attempt, quiz, req.body, { expired: quizService.isExpired(attempt, quiz) });
    }
    res.redirect(`/prova/${quiz.id}/resultado/${attempt.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/prova/:id/resultado/:aid', async (req, res, next) => {
  try {
    const { quiz, attempt } = await loadAttempt(req);
    if (attempt.status === 'in_progress') return res.redirect(`/prova/${quiz.id}/tentativa/${attempt.id}`);
    // recarrega o estado após a correção (módulos podem ter sido liberados)
    const state = await progress.getCourseState(req.user.id, quiz.course_id, { bypass: isStaff(req.user) });
    const qs = progress.findQuiz(state, quiz.id).quiz;
    const questions = quiz.show_answers ? await quizService.loadQuestions(quiz.id) : [];
    const unlocked = attempt.passed
      ? state.modules.filter((m) => m.unlock_quiz_id === quiz.id && m.unlocked) : [];
    res.render('student/quiz-result', { title: quiz.title, quiz, attempt, qs, state, questions, unlocked });
  } catch (err) {
    next(err);
  }
});

// ---------- certificados do aluno ----------

router.get('/certificados', async (req, res, next) => {
  try {
    const certs = await db.many(
      `SELECT ce.*, c.title AS course_title FROM certificates ce JOIN courses c ON c.id = ce.course_id
       WHERE ce.user_id = $1 ORDER BY ce.issued_at DESC`, [req.user.id]);
    res.render('student/certificates', { title: 'Meus certificados', certs });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
