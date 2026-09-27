const db = require('../db');

// Registra a atividade e repassa o evento para o motor de gatilhos.
async function emit(type, ctx) {
  await db.query(
    `INSERT INTO activity (user_id, type, course_id, module_id, lesson_id, quiz_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.userId, type, ctx.courseId || null, ctx.moduleId || null, ctx.lessonId || null, ctx.quizId || null,
      JSON.stringify(ctx.data || {})]
  );
  try {
    await require('./triggers').handleEvent(type, ctx);
  } catch (err) {
    console.error(`[gatilhos] falha ao avaliar evento ${type}:`, err);
  }
}

async function log(type, ctx) {
  await db.query(
    `INSERT INTO activity (user_id, type, course_id, module_id, lesson_id, quiz_id, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.userId, type, ctx.courseId || null, ctx.moduleId || null, ctx.lessonId || null, ctx.quizId || null,
      JSON.stringify(ctx.data || {})]
  );
}

module.exports = { emit, log };
