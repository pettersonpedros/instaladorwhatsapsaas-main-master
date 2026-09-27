const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('../../db');
const { requirePerm } = require('../../middleware');
const { parseYouTubeId, toInt, checkbox } = require('../../util');

const router = express.Router();
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', '..', 'uploads'));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

const content = requirePerm('content');

function notFound(msg) {
  const err = new Error(msg);
  err.status = 404;
  return err;
}

async function move(table, id, dir, parentCol) {
  const row = await db.one(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  if (!row) return null;
  const siblings = await db.many(`SELECT id FROM ${table} WHERE ${parentCol} = $1 ORDER BY position, id`, [row[parentCol]]);
  const ids = siblings.map((s) => s.id);
  const i = ids.indexOf(id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < ids.length) [ids[i], ids[j]] = [ids[j], ids[i]];
  await db.tx(async (c) => {
    for (let k = 0; k < ids.length; k++) await c.query(`UPDATE ${table} SET position = $2 WHERE id = $1`, [ids[k], k]);
  });
  return row;
}

async function youtubeTitle(id) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`,
      { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return (await res.json()).title || null;
  } catch {
    return null;
  }
}

function courseFields(b) {
  return [
    String(b.title || '').trim(), b.description || '', b.cover_url || null, checkbox(b.published),
    checkbox(b.sequential_lessons), checkbox(b.prevent_skip),
    Math.min(100, Math.max(1, toInt(b.min_watch_percent, 90))), checkbox(b.certificate_enabled), toInt(b.workload_hours),
  ];
}

// ---------- cursos ----------

router.get('/cursos', async (req, res, next) => {
  try {
    const courses = await db.many(`SELECT c.*,
        (SELECT count(*) FROM modules m WHERE m.course_id = c.id)::int AS modules,
        (SELECT count(*) FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = c.id)::int AS lessons,
        (SELECT count(*) FROM enrollments e WHERE e.course_id = c.id)::int AS enrolled,
        (SELECT count(*) FROM enrollments e WHERE e.course_id = c.id AND e.completed_at IS NOT NULL)::int AS completed
      FROM courses c ORDER BY c.title`);
    res.render('admin/courses', { title: 'Cursos', courses });
  } catch (err) {
    next(err);
  }
});

router.post('/cursos', content, async (req, res, next) => {
  try {
    const f = courseFields({ sequential_lessons: 'on', certificate_enabled: 'on', min_watch_percent: 90, ...req.body });
    if (!f[0]) {
      req.flash('error', 'Informe o título do curso.');
      return res.redirect('/admin/cursos');
    }
    const c = await db.one(
      `INSERT INTO courses (title, description, cover_url, published, sequential_lessons, prevent_skip,
         min_watch_percent, certificate_enabled, workload_hours) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, f);
    req.flash('success', 'Curso criado. Agora adicione os módulos e aulas.');
    res.redirect(`/admin/cursos/${c.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/cursos/:id', async (req, res, next) => {
  try {
    const course = await db.one('SELECT * FROM courses WHERE id = $1', [toInt(req.params.id)]);
    if (!course) throw notFound('Curso não encontrado.');
    const [modules, lessons, quizzes, materials] = await Promise.all([
      db.many('SELECT * FROM modules WHERE course_id = $1 ORDER BY position, id', [course.id]),
      db.many(`SELECT l.* FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = $1
               ORDER BY l.position, l.id`, [course.id]),
      db.many(`SELECT q.*, (SELECT count(*) FROM questions x WHERE x.quiz_id = q.id)::int AS questions
               FROM quizzes q WHERE q.course_id = $1 ORDER BY q.id`, [course.id]),
      db.many('SELECT * FROM materials WHERE course_id = $1 AND lesson_id IS NULL ORDER BY id', [course.id]),
    ]);
    for (const m of modules) {
      m.lessons = lessons.filter((l) => l.module_id === m.id);
      m.quizzes = quizzes.filter((q) => q.module_id === m.id);
      m.materials = materials.filter((x) => x.module_id === m.id);
    }
    res.render('admin/course-edit', {
      title: course.title, course, modules,
      finalQuizzes: quizzes.filter((q) => !q.module_id),
      allQuizzes: quizzes,
      courseMaterials: materials.filter((x) => !x.module_id),
      maxMb: MAX_MB,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/cursos/:id', content, async (req, res, next) => {
  try {
    const f = courseFields(req.body);
    if (!f[0]) throw Object.assign(new Error('Informe o título.'), { status: 400 });
    await db.query(
      `UPDATE courses SET title=$1, description=$2, cover_url=$3, published=$4, sequential_lessons=$5,
         prevent_skip=$6, min_watch_percent=$7, certificate_enabled=$8, workload_hours=$9 WHERE id=$10`,
      [...f, toInt(req.params.id)]);
    req.flash('success', 'Curso atualizado.');
    res.redirect(`/admin/cursos/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/cursos/:id/excluir', content, async (req, res, next) => {
  try {
    await db.query('DELETE FROM courses WHERE id = $1', [toInt(req.params.id)]);
    req.flash('success', 'Curso excluído.');
    res.redirect('/admin/cursos');
  } catch (err) {
    next(err);
  }
});

router.post('/cursos/:id/duplicar', content, async (req, res, next) => {
  try {
    const src = toInt(req.params.id);
    const newId = await db.tx(async (c) => {
      const { rows: [course] } = await c.query(
        `INSERT INTO courses (title, description, cover_url, published, sequential_lessons, prevent_skip, min_watch_percent,
           certificate_enabled, workload_hours)
         SELECT title || ' (cópia)', description, cover_url, false, sequential_lessons, prevent_skip, min_watch_percent,
           certificate_enabled, workload_hours FROM courses WHERE id = $1 RETURNING id`, [src]);
      if (!course) throw notFound('Curso não encontrado.');
      const moduleMap = new Map();
      const quizMap = new Map();
      const { rows: modules } = await c.query('SELECT * FROM modules WHERE course_id = $1 ORDER BY position, id', [src]);
      for (const m of modules) {
        const { rows: [nm] } = await c.query(
          `INSERT INTO modules (course_id, title, description, position, require_previous, release_after_days)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [course.id, m.title, m.description, m.position, m.require_previous, m.release_after_days]);
        moduleMap.set(m.id, nm.id);
        const { rows: lessons } = await c.query('SELECT * FROM lessons WHERE module_id = $1', [m.id]);
        for (const l of lessons) {
          await c.query(
            `INSERT INTO lessons (module_id, title, description, youtube_id, duration_seconds, min_watch_percent, position)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [nm.id, l.title, l.description, l.youtube_id, l.duration_seconds, l.min_watch_percent, l.position]);
        }
      }
      const { rows: quizzes } = await c.query('SELECT * FROM quizzes WHERE course_id = $1', [src]);
      for (const q of quizzes) {
        const { rows: [nq] } = await c.query(
          `INSERT INTO quizzes (course_id, module_id, title, description, pass_score, max_attempts, time_limit_minutes,
             shuffle, show_answers, required) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [course.id, q.module_id ? moduleMap.get(q.module_id) : null, q.title, q.description, q.pass_score,
            q.max_attempts, q.time_limit_minutes, q.shuffle, q.show_answers, q.required]);
        quizMap.set(q.id, nq.id);
        const { rows: questions } = await c.query('SELECT * FROM questions WHERE quiz_id = $1', [q.id]);
        for (const x of questions) {
          const { rows: [nx] } = await c.query(
            `INSERT INTO questions (quiz_id, kind, text, explanation, points, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [nq.id, x.kind, x.text, x.explanation, x.points, x.position]);
          await c.query(
            `INSERT INTO question_options (question_id, text, is_correct, position)
             SELECT $2, text, is_correct, position FROM question_options WHERE question_id = $1`, [x.id, nx.id]);
        }
      }
      for (const m of modules) {
        if (m.unlock_quiz_id && quizMap.has(m.unlock_quiz_id)) {
          await c.query('UPDATE modules SET unlock_quiz_id = $2 WHERE id = $1', [moduleMap.get(m.id), quizMap.get(m.unlock_quiz_id)]);
        }
      }
      return course.id;
    });
    req.flash('success', 'Curso duplicado (materiais anexados não são copiados). Ele foi criado como rascunho.');
    res.redirect(`/admin/cursos/${newId}`);
  } catch (err) {
    next(err);
  }
});

// ---------- módulos ----------

async function validateUnlockQuiz(moduleId, courseId, quizId) {
  if (!quizId) return null;
  const quiz = await db.one(
    `SELECT q.*, m.position AS module_position FROM quizzes q LEFT JOIN modules m ON m.id = q.module_id
     WHERE q.id = $1 AND q.course_id = $2`, [quizId, courseId]);
  if (!quiz || !quiz.module_id) return 'A prova de liberação precisa pertencer a um módulo anterior.';
  const me = moduleId ? await db.one('SELECT position FROM modules WHERE id = $1', [moduleId]) : null;
  if (quiz.module_id === moduleId || (me && quiz.module_position > me.position)) {
    return 'A prova de liberação precisa ser de um módulo ANTERIOR (senão o módulo nunca seria liberado).';
  }
  return null;
}

router.post('/cursos/:id/modulos', content, async (req, res, next) => {
  try {
    const courseId = toInt(req.params.id);
    const pos = await db.one('SELECT coalesce(max(position), -1) + 1 AS p FROM modules WHERE course_id = $1', [courseId]);
    await db.query(
      `INSERT INTO modules (course_id, title, description, position, require_previous) VALUES ($1, $2, $3, $4, true)`,
      [courseId, String(req.body.title || 'Novo módulo').trim(), req.body.description || '', pos.p]);
    res.redirect(`/admin/cursos/${courseId}`);
  } catch (err) {
    next(err);
  }
});

router.post('/modulos/:id', content, async (req, res, next) => {
  try {
    const m = await db.one('SELECT * FROM modules WHERE id = $1', [toInt(req.params.id)]);
    if (!m) throw notFound('Módulo não encontrado.');
    const unlockQuiz = toInt(req.body.unlock_quiz_id);
    const problem = await validateUnlockQuiz(m.id, m.course_id, unlockQuiz);
    if (problem) {
      req.flash('error', problem);
      return res.redirect(`/admin/cursos/${m.course_id}#modulo-${m.id}`);
    }
    await db.query(
      `UPDATE modules SET title=$2, description=$3, require_previous=$4, unlock_quiz_id=$5, release_after_days=$6 WHERE id=$1`,
      [m.id, String(req.body.title || m.title).trim(), req.body.description || '', checkbox(req.body.require_previous),
        unlockQuiz, toInt(req.body.release_after_days) || null]);
    req.flash('success', 'Módulo atualizado.');
    res.redirect(`/admin/cursos/${m.course_id}#modulo-${m.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/modulos/:id/mover', content, async (req, res, next) => {
  try {
    const m = await move('modules', toInt(req.params.id), req.body.dir, 'course_id');
    res.redirect(`/admin/cursos/${m.course_id}#modulo-${m.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/modulos/:id/excluir', content, async (req, res, next) => {
  try {
    const m = await db.one('DELETE FROM modules WHERE id = $1 RETURNING course_id', [toInt(req.params.id)]);
    req.flash('success', 'Módulo excluído.');
    res.redirect(`/admin/cursos/${m.course_id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- aulas ----------

router.post('/modulos/:id/aulas', content, async (req, res, next) => {
  try {
    const m = await db.one('SELECT * FROM modules WHERE id = $1', [toInt(req.params.id)]);
    if (!m) throw notFound('Módulo não encontrado.');
    const raw = String(req.body.youtube || '').trim();
    const youtubeId = raw ? parseYouTubeId(raw) : null;
    if (raw && !youtubeId) {
      req.flash('error', 'Link do YouTube inválido. Use o link do vídeo (youtube.com/watch?v=... ou youtu.be/...).');
      return res.redirect(`/admin/cursos/${m.course_id}#modulo-${m.id}`);
    }
    let title = String(req.body.title || '').trim();
    if (!title && youtubeId) title = (await youtubeTitle(youtubeId)) || '';
    if (!title) title = 'Nova aula';
    const pos = await db.one('SELECT coalesce(max(position), -1) + 1 AS p FROM lessons WHERE module_id = $1', [m.id]);
    await db.query('INSERT INTO lessons (module_id, title, youtube_id, position) VALUES ($1, $2, $3, $4)',
      [m.id, title, youtubeId, pos.p]);
    req.flash('success', `Aula "${title}" adicionada.`);
    res.redirect(`/admin/cursos/${m.course_id}#modulo-${m.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/aulas/:id', async (req, res, next) => {
  try {
    const lesson = await db.one(
      `SELECT l.*, m.course_id, m.title AS module_title, c.title AS course_title, c.min_watch_percent AS course_min
       FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id WHERE l.id = $1`,
      [toInt(req.params.id)]);
    if (!lesson) throw notFound('Aula não encontrada.');
    const [materials, modules] = await Promise.all([
      db.many('SELECT * FROM materials WHERE lesson_id = $1 ORDER BY id', [lesson.id]),
      db.many('SELECT id, title FROM modules WHERE course_id = $1 ORDER BY position, id', [lesson.course_id]),
    ]);
    res.render('admin/lesson-edit', { title: lesson.title, lesson, materials, modules, maxMb: MAX_MB });
  } catch (err) {
    next(err);
  }
});

router.post('/aulas/:id', content, async (req, res, next) => {
  try {
    const lesson = await db.one('SELECT * FROM lessons WHERE id = $1', [toInt(req.params.id)]);
    if (!lesson) throw notFound('Aula não encontrada.');
    const raw = String(req.body.youtube || '').trim();
    const youtubeId = raw ? parseYouTubeId(raw) : null;
    if (raw && !youtubeId) {
      req.flash('error', 'Link do YouTube inválido.');
      return res.redirect(`/admin/aulas/${lesson.id}`);
    }
    const moduleId = toInt(req.body.module_id, lesson.module_id);
    const duration = youtubeId !== lesson.youtube_id ? null : lesson.duration_seconds;
    await db.query(
      `UPDATE lessons SET title=$2, description=$3, youtube_id=$4, min_watch_percent=$5, module_id=$6,
         duration_seconds=$7 WHERE id=$1`,
      [lesson.id, String(req.body.title || lesson.title).trim(), req.body.description || '', youtubeId,
        toInt(req.body.min_watch_percent) || null, moduleId, duration]);
    req.flash('success', 'Aula atualizada.');
    res.redirect(`/admin/aulas/${lesson.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/aulas/:id/mover', content, async (req, res, next) => {
  try {
    const l = await move('lessons', toInt(req.params.id), req.body.dir, 'module_id');
    const m = await db.one('SELECT course_id FROM modules WHERE id = $1', [l.module_id]);
    res.redirect(`/admin/cursos/${m.course_id}#modulo-${l.module_id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/aulas/:id/excluir', content, async (req, res, next) => {
  try {
    const l = await db.one(
      `DELETE FROM lessons l USING modules m WHERE l.id = $1 AND m.id = l.module_id RETURNING m.course_id, l.module_id`,
      [toInt(req.params.id)]);
    req.flash('success', 'Aula excluída.');
    res.redirect(`/admin/cursos/${l.course_id}#modulo-${l.module_id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- materiais complementares ----------

router.post('/materiais', content, (req, res, next) => {
  upload.single('file')(req, res, async (uploadErr) => {
    const back = req.body?.back || '/admin/cursos';
    const safeBack = back.startsWith('/admin/') ? back : '/admin/cursos';
    try {
      if (uploadErr) {
        req.flash('error', uploadErr.code === 'LIMIT_FILE_SIZE' ? `Arquivo maior que ${MAX_MB} MB.` : uploadErr.message);
        return res.redirect(safeBack);
      }
      const lessonId = toInt(req.body.lesson_id);
      let moduleId = toInt(req.body.module_id);
      let courseId = toInt(req.body.course_id);
      if (lessonId) {
        const l = await db.one('SELECT l.module_id, m.course_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.id = $1', [lessonId]);
        moduleId = l.module_id;
        courseId = l.course_id;
      } else if (moduleId) {
        courseId = (await db.one('SELECT course_id FROM modules WHERE id = $1', [moduleId])).course_id;
      }
      const title = String(req.body.title || req.file?.originalname || '').trim();
      if (req.file) {
        await db.query(
          `INSERT INTO materials (course_id, module_id, lesson_id, title, kind, file_path, file_name, file_size)
           VALUES ($1,$2,$3,$4,'file',$5,$6,$7)`,
          [courseId, moduleId, lessonId, title, req.file.filename, req.file.originalname, req.file.size]);
      } else {
        const url = String(req.body.url || '').trim();
        if (!/^https?:\/\//i.test(url)) {
          req.flash('error', 'Informe um link começando com http(s):// ou envie um arquivo.');
          return res.redirect(safeBack);
        }
        await db.query(
          `INSERT INTO materials (course_id, module_id, lesson_id, title, kind, url) VALUES ($1,$2,$3,$4,'link',$5)`,
          [courseId, moduleId, lessonId, title || url, url]);
      }
      req.flash('success', 'Material adicionado.');
      res.redirect(safeBack);
    } catch (err) {
      next(err);
    }
  });
});

router.post('/materiais/:id/excluir', content, async (req, res, next) => {
  try {
    const mat = await db.one('DELETE FROM materials WHERE id = $1 RETURNING *', [toInt(req.params.id)]);
    if (mat?.file_path) fs.unlink(path.join(UPLOAD_DIR, mat.file_path), () => {});
    req.flash('success', 'Material removido.');
    const back = String(req.body.back || '');
    res.redirect(back.startsWith('/admin/') ? back : `/admin/cursos/${mat.course_id}`);
  } catch (err) {
    next(err);
  }
});

// ---------- provas ----------

function quizFields(b) {
  return [
    String(b.title || '').trim() || 'Prova', b.description || '',
    Math.min(100, Math.max(0, toInt(b.pass_score, 70))), Math.max(0, toInt(b.max_attempts, 0)),
    Math.max(0, toInt(b.time_limit_minutes, 0)), checkbox(b.shuffle), checkbox(b.show_answers), checkbox(b.required),
  ];
}

router.post('/cursos/:id/provas', content, async (req, res, next) => {
  try {
    const courseId = toInt(req.params.id);
    const moduleId = toInt(req.body.module_id);
    const q = await db.one(
      `INSERT INTO quizzes (course_id, module_id, title, description, pass_score, max_attempts, time_limit_minutes,
         shuffle, show_answers, required) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [courseId, moduleId, ...quizFields({ shuffle: 'on', show_answers: 'on', required: 'on', ...req.body })]);
    req.flash('success', 'Prova criada. Adicione as questões abaixo.');
    res.redirect(`/admin/provas/${q.id}`);
  } catch (err) {
    next(err);
  }
});

router.get('/provas/:id', async (req, res, next) => {
  try {
    const quiz = await db.one(
      `SELECT q.*, c.title AS course_title, m.title AS module_title FROM quizzes q
       JOIN courses c ON c.id = q.course_id LEFT JOIN modules m ON m.id = q.module_id WHERE q.id = $1`,
      [toInt(req.params.id)]);
    if (!quiz) throw notFound('Prova não encontrada.');
    const questions = await require('../../services/quiz').loadQuestions(quiz.id);
    const modules = await db.many('SELECT id, title FROM modules WHERE course_id = $1 ORDER BY position, id', [quiz.course_id]);
    const unlocks = await db.many('SELECT id, title FROM modules WHERE unlock_quiz_id = $1', [quiz.id]);
    const editing = toInt(req.query.editar) ? questions.find((x) => x.id === toInt(req.query.editar)) : null;
    res.render('admin/quiz-edit', { title: quiz.title, quiz, questions, modules, unlocks, editing });
  } catch (err) {
    next(err);
  }
});

router.post('/provas/:id', content, async (req, res, next) => {
  try {
    const id = toInt(req.params.id);
    await db.query(
      `UPDATE quizzes SET title=$2, description=$3, pass_score=$4, max_attempts=$5, time_limit_minutes=$6,
         shuffle=$7, show_answers=$8, required=$9, module_id=$10 WHERE id=$1`,
      [id, ...quizFields(req.body), toInt(req.body.module_id)]);
    // se a prova mudou de módulo, desfaz liberações que ficariam impossíveis
    let warning = '';
    for (const m of await db.many('SELECT id, course_id, title FROM modules WHERE unlock_quiz_id = $1', [id])) {
      if (await validateUnlockQuiz(m.id, m.course_id, id)) {
        await db.query('UPDATE modules SET unlock_quiz_id = NULL WHERE id = $1', [m.id]);
        warning += ` O módulo "${m.title}" deixou de depender desta prova (ela não é mais de um módulo anterior).`;
      }
    }
    req.flash(warning ? 'error' : 'success', `Prova atualizada.${warning}`);
    res.redirect(`/admin/provas/${id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/provas/:id/excluir', content, async (req, res, next) => {
  try {
    const q = await db.one('DELETE FROM quizzes WHERE id = $1 RETURNING course_id', [toInt(req.params.id)]);
    req.flash('success', 'Prova excluída.');
    res.redirect(`/admin/cursos/${q.course_id}`);
  } catch (err) {
    next(err);
  }
});

function parseOptions(body, kind) {
  if (kind === 'truefalse') {
    const correct = body.tf_correct === 'false' ? 'false' : 'true';
    return [
      { text: 'Verdadeiro', is_correct: correct === 'true' },
      { text: 'Falso', is_correct: correct === 'false' },
    ];
  }
  const texts = [].concat(body.option_text || []);
  const correctIdx = new Set([].concat(body.option_correct || []).map(String));
  return texts
    .map((text, i) => ({ text: String(text).trim(), is_correct: correctIdx.has(String(i)) }))
    .filter((o) => o.text);
}

async function saveQuestion(req, quizId, questionId) {
  const kind = ['single', 'multiple', 'truefalse'].includes(req.body.kind) ? req.body.kind : 'single';
  const text = String(req.body.text || '').trim();
  const options = parseOptions(req.body, kind);
  const correct = options.filter((o) => o.is_correct).length;
  if (!text) return 'Digite o enunciado da questão.';
  if (options.length < 2) return 'Informe ao menos 2 alternativas.';
  if (correct === 0) return 'Marque ao menos uma alternativa correta.';
  if (kind === 'single' && correct > 1) return 'Questão de escolha única deve ter só uma alternativa correta (use "múltipla escolha").';
  await db.tx(async (c) => {
    let qid = questionId;
    const points = Math.max(1, toInt(req.body.points, 1));
    if (qid) {
      await c.query('UPDATE questions SET kind=$2, text=$3, explanation=$4, points=$5 WHERE id=$1',
        [qid, kind, text, req.body.explanation || '', points]);
      await c.query('DELETE FROM question_options WHERE question_id = $1', [qid]);
    } else {
      const { rows: [p] } = await c.query('SELECT coalesce(max(position), -1) + 1 AS p FROM questions WHERE quiz_id = $1', [quizId]);
      const { rows: [q] } = await c.query(
        'INSERT INTO questions (quiz_id, kind, text, explanation, points, position) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [quizId, kind, text, req.body.explanation || '', points, p.p]);
      qid = q.id;
    }
    for (let i = 0; i < options.length; i++) {
      await c.query('INSERT INTO question_options (question_id, text, is_correct, position) VALUES ($1,$2,$3,$4)',
        [qid, options[i].text, options[i].is_correct, i]);
    }
  });
  return null;
}

router.post('/provas/:id/questoes', content, async (req, res, next) => {
  try {
    const quizId = toInt(req.params.id);
    const problem = await saveQuestion(req, quizId, null);
    req.flash(problem ? 'error' : 'success', problem || 'Questão adicionada.');
    res.redirect(`/admin/provas/${quizId}#nova-questao`);
  } catch (err) {
    next(err);
  }
});

router.post('/questoes/:id', content, async (req, res, next) => {
  try {
    const q = await db.one('SELECT * FROM questions WHERE id = $1', [toInt(req.params.id)]);
    if (!q) throw notFound('Questão não encontrada.');
    const problem = await saveQuestion(req, q.quiz_id, q.id);
    req.flash(problem ? 'error' : 'success', problem || 'Questão atualizada.');
    res.redirect(problem ? `/admin/provas/${q.quiz_id}?editar=${q.id}#nova-questao` : `/admin/provas/${q.quiz_id}#questao-${q.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/questoes/:id/mover', content, async (req, res, next) => {
  try {
    const q = await move('questions', toInt(req.params.id), req.body.dir, 'quiz_id');
    res.redirect(`/admin/provas/${q.quiz_id}#questao-${q.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/questoes/:id/excluir', content, async (req, res, next) => {
  try {
    const q = await db.one('DELETE FROM questions WHERE id = $1 RETURNING quiz_id', [toInt(req.params.id)]);
    req.flash('success', 'Questão excluída.');
    res.redirect(`/admin/provas/${q.quiz_id}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
