// Teste de ponta a ponta: requer um Postgres de teste.
// TEST_DATABASE_URL=postgres://lms:lms@localhost:5432/lms_test npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://lms:lms@localhost:5432/lms_test';
process.env.SESSION_SECRET = 'test';

const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { createApp } = require('../src/server');
const triggers = require('../src/services/triggers');
const progress = require('../src/services/progress');
const { parseYouTubeId } = require('../src/util');

let server;
let base;
const ids = {};

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(method, path, body, { json = false } = {}) {
    const headers = { cookie: this.cookie };
    let payload;
    if (body && json) {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = this.csrf;
      payload = JSON.stringify(body);
    } else if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: this.csrf, ...body })) {
        [].concat(v).forEach((x) => params.append(k, x));
      }
      payload = params.toString();
    }
    const res = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    const m = text.match(/name="csrf-token" content="([^"]+)"/) || text.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text };
  }
  async login(email, password) {
    await this.req('GET', '/login');
    const r = await this.req('POST', '/login', { email, password });
    assert.strictEqual(r.status, 302, 'login deve redirecionar');
    await this.req('GET', '/perfil'); // pega o csrf da nova sessão
  }
}

async function heartbeat(client, lessonId, from, to, duration = 100) {
  // simula tempo real decorrido para passar na checagem anti-fraude
  await client.req('POST', `/api/progress/${lessonId}`, { segments: [[from, from + 1]], position: from + 1, duration }, { json: true });
  await db.query(`UPDATE lesson_progress SET last_heartbeat_at = now() - interval '1 hour' WHERE lesson_id = $1`, [lessonId]);
  const r = await client.req('POST', `/api/progress/${lessonId}`, { segments: [[from, to]], position: to, duration }, { json: true });
  assert.strictEqual(r.status, 200, r.text);
  return JSON.parse(r.text);
}

before(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
  const hash = await bcrypt.hash('senha123', 4);
  ids.admin = (await db.one(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'admin@x.com', $1, 'admin') RETURNING id`, [hash])).id;
  ids.student = (await db.one(`INSERT INTO users (name, email, phone, password_hash, role) VALUES ('Maria Silva', 'maria@x.com', '11999998888', $1, 'student') RETURNING id`, [hash])).id;
  const app = createApp();
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await db.pool.end();
});

test('parseYouTubeId aceita os formatos comuns', () => {
  assert.strictEqual(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'dQw4w9WgXcQ');
  assert.strictEqual(parseYouTubeId('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'dQw4w9WgXcQ');
  assert.strictEqual(parseYouTubeId('youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(parseYouTubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.strictEqual(parseYouTubeId('https://vimeo.com/123'), null);
});

test('mergeSegments une trechos sobrepostos', () => {
  assert.deepStrictEqual(progress.mergeSegments([[10, 20], [0, 5], [5.5, 12], [30, 40]]), [[0, 20], [30, 40]]);
  assert.strictEqual(progress.coverage([[0, 20], [30, 140]], 100), 90);
});

test('fluxo completo: admin monta curso, aluno assiste, faz prova, libera módulo e conclui', async () => {
  const admin = new Client();
  await admin.login('admin@x.com', 'senha123');

  let r = await admin.req('POST', '/admin/cursos', { title: 'Onboarding' });
  ids.course = Number(r.location.split('/').pop());
  await admin.req('POST', `/admin/cursos/${ids.course}`, {
    title: 'Onboarding', published: 'on', sequential_lessons: 'on', certificate_enabled: 'on', min_watch_percent: 90, workload_hours: 2,
  });
  await admin.req('POST', `/admin/cursos/${ids.course}/modulos`, { title: 'Módulo 1' });
  await admin.req('POST', `/admin/cursos/${ids.course}/modulos`, { title: 'Módulo 2' });
  const [m1, m2] = await db.many('SELECT id FROM modules WHERE course_id = $1 ORDER BY position', [ids.course]);
  await admin.req('POST', `/admin/modulos/${m1.id}/aulas`, { youtube: 'https://youtu.be/dQw4w9WgXcQ', title: 'Aula 1' });
  await admin.req('POST', `/admin/modulos/${m1.id}/aulas`, { youtube: '', title: 'Leitura' });
  await admin.req('POST', `/admin/modulos/${m2.id}/aulas`, { youtube: 'https://youtu.be/aaaaaaaaaaa', title: 'Aula 2.1' });
  r = await admin.req('POST', `/admin/modulos/${m1.id}/aulas`, { youtube: 'https://vimeo.com/1', title: 'x' });
  assert.match((await admin.req('GET', r.location)).text, /Link do YouTube inválido/);
  const lessons = await db.many(`SELECT l.id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE m.course_id = $1 ORDER BY m.position, l.position`, [ids.course]);
  const [l1, l2, l3] = lessons.map((x) => x.id);

  // prova do módulo 1, 2 questões, mínimo 70%, 2 tentativas
  r = await admin.req('POST', `/admin/cursos/${ids.course}/provas`, { module_id: m1.id, title: 'Prova 1' });
  ids.quiz = Number(r.location.split('/').pop());
  await admin.req('POST', `/admin/provas/${ids.quiz}`, {
    title: 'Prova 1', module_id: m1.id, pass_score: 70, max_attempts: 2, time_limit_minutes: 0, required: 'on', show_answers: 'on',
  });
  await admin.req('POST', `/admin/provas/${ids.quiz}/questoes`, {
    kind: 'single', text: '2+2?', option_text: ['3', '4', '', '', '', ''], option_correct: '1', points: 1,
  });
  await admin.req('POST', `/admin/provas/${ids.quiz}/questoes`, { kind: 'truefalse', text: 'O céu é azul', tf_correct: 'true', points: 1 });
  r = await admin.req('POST', `/admin/provas/${ids.quiz}/questoes`, { kind: 'single', text: 'sem correta', option_text: ['a', 'b'], points: 1 });
  assert.match((await admin.req('GET', r.location)).text, /Marque ao menos uma alternativa correta/);

  // módulo 2 só libera após aprovação na prova 1; tentativa de usar prova do próprio módulo é rejeitada
  r = await admin.req('POST', `/admin/modulos/${m2.id}`, { title: 'Módulo 2', require_previous: 'on', unlock_quiz_id: ids.quiz });
  const m2row = await db.one('SELECT unlock_quiz_id FROM modules WHERE id = $1', [m2.id]);
  assert.strictEqual(m2row.unlock_quiz_id, ids.quiz);

  // gatilhos: conclusão em até 7 dias → notificar admin; reprovação → webhook inválido (erro registrado)
  await admin.req('POST', '/admin/gatilhos', {
    name: 'Concluiu rápido', active: 'on', event: 'course_completed', course_id: ids.course, comparison: 'within', days: 7,
    delay: 0, delay_unit: 'minutes', action: 'notify_admin', notify_title: '{{nome}} concluiu {{curso}} em {{dias}} dias', message: 'nota {{nota}}',
  });
  await admin.req('POST', '/admin/gatilhos', {
    name: 'Concluiu devagar', active: 'on', event: 'course_completed', comparison: 'after', days: 30,
    delay: 0, delay_unit: 'minutes', action: 'notify_admin', message: 'x',
  });
  await admin.req('POST', '/admin/gatilhos', {
    name: 'Reprovou', active: 'on', event: 'quiz_failed', delay: 1, delay_unit: 'hours', action: 'notify_admin', message: 'reprovou com {{nota}}',
  });
  assert.strictEqual((await db.one('SELECT count(*)::int AS n FROM triggers')).n, 3);

  // matrícula
  await admin.req('POST', `/admin/usuarios/${ids.student}/matricular`, { course_id: ids.course });

  // ---- aluno ----
  const aluno = new Client();
  await aluno.login('maria@x.com', 'senha123');
  r = await aluno.req('GET', `/curso/${ids.course}`);
  assert.match(r.text, /Seja aprovado na prova &#34;Prova 1&#34;/);

  // aula 2 bloqueada (sequencial) e módulo 2 bloqueado
  r = await aluno.req('GET', `/aula/${l2}`);
  assert.strictEqual(r.status, 302);
  r = await aluno.req('POST', `/api/progress/${l3}`, { segments: [[0, 10]], duration: 100 }, { json: true });
  assert.strictEqual(r.status, 403);

  // anti-fraude: pular 100s num único heartbeat recém iniciado não conta
  r = await aluno.req('GET', `/aula/${l1}`);
  assert.strictEqual(r.status, 200);
  let hb = JSON.parse((await aluno.req('POST', `/api/progress/${l1}`, { segments: [[0, 5]], position: 5, duration: 100 }, { json: true })).text);
  assert.strictEqual(hb.percent, 5);
  hb = JSON.parse((await aluno.req('POST', `/api/progress/${l1}`, { segments: [[5, 100]], position: 100, duration: 100 }, { json: true })).text);
  assert.strictEqual(hb.rejected, true);
  assert.strictEqual(hb.completed, false);

  hb = await heartbeat(aluno, l1, 5, 60);
  assert.strictEqual(hb.percent, 60);
  hb = await heartbeat(aluno, l1, 55, 92);
  assert.strictEqual(hb.completed, true);

  // aula de texto
  r = await aluno.req('POST', `/aula/${l2}/concluir`, {});
  assert.strictEqual(r.status, 302);

  // prova: 1ª tentativa errada
  r = await aluno.req('POST', `/prova/${ids.quiz}/iniciar`, {});
  let attemptUrl = r.location;
  const qs = await db.many('SELECT q.id, q.kind FROM questions q WHERE quiz_id = $1 ORDER BY position', [ids.quiz]);
  const opts = await db.many('SELECT o.* FROM question_options o JOIN questions q ON q.id = o.question_id WHERE q.quiz_id = $1', [ids.quiz]);
  const correct = (qid) => opts.find((o) => o.question_id === qid && o.is_correct).id;
  const wrong = (qid) => opts.find((o) => o.question_id === qid && !o.is_correct).id;
  await aluno.req('GET', attemptUrl);
  r = await aluno.req('POST', attemptUrl, { [`q${qs[0].id}`]: wrong(qs[0].id), [`q${qs[1].id}`]: correct(qs[1].id) });
  r = await aluno.req('GET', r.location);
  assert.match(r.text, /50%/);
  assert.match(r.text, /Tentar novamente \(1 restante\)/);
  let pending = await db.one(`SELECT j.* FROM trigger_jobs j JOIN triggers t ON t.id = j.trigger_id WHERE t.name = 'Reprovou'`);
  assert.ok(pending && pending.status === 'pending' && new Date(pending.run_at) > new Date(), 'reprovação agenda gatilho com atraso');

  // 2ª tentativa correta → libera módulo 2
  r = await aluno.req('POST', `/prova/${ids.quiz}/iniciar`, {});
  attemptUrl = r.location;
  r = await aluno.req('POST', attemptUrl, { [`q${qs[0].id}`]: correct(qs[0].id), [`q${qs[1].id}`]: correct(qs[1].id) });
  r = await aluno.req('GET', r.location);
  assert.match(r.text, /Aprovado/);
  assert.match(r.text, /Liberado: Módulo 2/);

  // não pode iniciar de novo após aprovado
  r = await aluno.req('POST', `/prova/${ids.quiz}/iniciar`, {});
  assert.strictEqual(r.status, 400);

  // módulo 2 → conclui curso
  hb = await heartbeat(aluno, l3, 0, 95);
  assert.strictEqual(hb.completed, true);
  assert.strictEqual(hb.courseCompleted, true);

  const enr = await db.one('SELECT * FROM enrollments WHERE user_id = $1 AND course_id = $2', [ids.student, ids.course]);
  assert.ok(enr.completed_at);
  const cert = await db.one('SELECT * FROM certificates WHERE user_id = $1', [ids.student]);
  assert.ok(cert);
  r = await new Client().req('GET', `/certificado/${cert.code}`);
  assert.match(r.text, /Maria Silva/);

  // gatilhos: apenas "Concluiu rápido" enfileirado para conclusão
  await triggers.processJobs();
  const jobs = await db.many(`SELECT j.*, t.name FROM trigger_jobs j JOIN triggers t ON t.id = j.trigger_id ORDER BY j.id`);
  assert.deepStrictEqual(jobs.map((j) => j.name).sort(), ['Concluiu rápido', 'Reprovou']);
  const fast = jobs.find((j) => j.name === 'Concluiu rápido');
  assert.strictEqual(fast.status, 'done', fast.last_error);
  const notif = await db.one('SELECT * FROM notifications ORDER BY id DESC LIMIT 1');
  assert.match(notif.title, /Maria Silva concluiu Onboarding em 0 dias/);

  // relatórios
  r = await admin.req('GET', `/admin/relatorios/curso/${ids.course}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /Maria Silva/);
  r = await admin.req('GET', `/admin/relatorios/curso/${ids.course}?formato=csv`);
  assert.match(r.text, /Maria Silva;maria@x.com/);
  r = await admin.req('GET', `/admin/usuarios/${ids.student}`);
  assert.match(r.text, /Concluiu o curso/);
  for (const p of ['/admin', '/admin/cursos', `/admin/cursos/${ids.course}`, `/admin/provas/${ids.quiz}`, `/admin/aulas/${l1}`,
    '/admin/usuarios', '/admin/empresas', '/admin/relatorios', `/admin/relatorios/aula/${l1}`, '/admin/gatilhos',
    '/admin/gatilhos/novo', '/admin/gatilhos/execucoes', '/admin/configuracoes', '/', `/curso/${ids.course}`]) {
    const res = await admin.req('GET', p);
    assert.strictEqual(res.status, 200, `${p} → ${res.status}`);
  }

  // aluno não acessa o admin
  r = await aluno.req('GET', '/admin');
  assert.strictEqual(r.status, 403);
});

test('gatilho por tempo: não concluiu em X dias (e cancela se concluir antes)', async () => {
  const hash = await bcrypt.hash('x', 4);
  const u = await db.one(`INSERT INTO users (name, email, password_hash, role) VALUES ('João', 'joao@x.com', $1, 'student') RETURNING id`, [hash]);
  await progress.enroll(u.id, ids.course);
  await db.query(`UPDATE enrollments SET enrolled_at = now() - interval '10 days' WHERE user_id = $1`, [u.id]);
  const t = await db.one(
    `INSERT INTO triggers (name, event, course_id, conditions, action, action_config, created_at)
     VALUES ('Lembrete 7d', 'course_not_completed', $1, '{"days": 7}', 'notify_admin', '{"message": "{{nome}} {{progresso}}"}', now() - interval '5 days')
     RETURNING id`, [ids.course]);
  await triggers.scanScheduled();
  await triggers.scanScheduled(); // idempotente
  const jobs = await db.many('SELECT * FROM trigger_jobs WHERE trigger_id = $1', [t.id]);
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].user_id, u.id); // Maria já concluiu, não entra
  await triggers.processJobs();
  const done = await db.one('SELECT * FROM trigger_jobs WHERE id = $1', [jobs[0].id]);
  assert.strictEqual(done.status, 'done', done.last_error);

  // gatilho criado agora não pega quem já estava atrasado (sem include_existing)
  const t2 = await db.one(
    `INSERT INTO triggers (name, event, course_id, conditions, action, action_config)
     VALUES ('Novo', 'course_not_completed', $1, '{"days": 7}', 'notify_admin', '{}') RETURNING id`, [ids.course]);
  await triggers.scanScheduled();
  assert.strictEqual((await db.one('SELECT count(*)::int AS n FROM trigger_jobs WHERE trigger_id = $1', [t2.id])).n, 0);
});

test('prova com tempo esgotado conta como tentativa reprovada', async () => {
  const quizService = require('../src/services/quiz');
  const quiz = await db.one('UPDATE quizzes SET time_limit_minutes = 1, max_attempts = 0 WHERE id = $1 RETURNING *', [ids.quiz]);
  const hash = await bcrypt.hash('x', 4);
  const u = await db.one(`INSERT INTO users (name, email, password_hash, role) VALUES ('Ana', 'ana@x.com', $1, 'student') RETURNING id`, [hash]);
  await progress.enroll(u.id, ids.course, { silent: true });
  const attempt = await quizService.startAttempt(u.id, quiz);
  await db.query(`UPDATE quiz_attempts SET started_at = now() - interval '5 minutes' WHERE id = $1`, [attempt.id]);
  const again = await quizService.startAttempt(u.id, quiz); // expira a anterior e abre nova
  assert.notStrictEqual(again.id, attempt.id);
  const old = await db.one('SELECT * FROM quiz_attempts WHERE id = $1', [attempt.id]);
  assert.strictEqual(old.status, 'expired');
  assert.strictEqual(old.passed, false);
});

// ---------- recuperação de senha, gestor da empresa e WhatsApp ----------

const http = require('http');
const settings = require('../src/services/settings');

async function fakeWhatsApp() {
  const received = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, ...JSON.parse(body) });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => srv.listen(0, r));
  await settings.setMany({
    whatsapp_api_url: `http://127.0.0.1:${srv.address().port}/api/messages/send`,
    whatsapp_api_token: 'tok123',
    public_url: base,
  });
  return { received, close: () => srv.close() };
}

test('recuperação de senha só por e-mail: link único, não usa WhatsApp e não revela e-mails', async () => {
  const wa = await fakeWhatsApp();
  const emails = [];
  const originalSendEmail = triggers.sendEmail;
  triggers.sendEmail = async (to, subject, text) => { emails.push({ to, subject, text }); return 'ok'; };
  try {
    const c = new Client();
    // sem SMTP: tela orienta a falar com o suporte
    const r0 = await c.req('GET', '/recuperar-senha');
    assert.match(r0.text, /não está disponível/);
    await settings.setMany({ smtp_host: 'smtp.teste.local' });

    let r = await c.req('GET', '/recuperar-senha');
    r = await c.req('POST', '/recuperar-senha', { email: 'naoexiste@x.com' });
    assert.match(r.text, /Se <strong>naoexiste@x.com<\/strong> estiver cadastrado/);
    assert.strictEqual(emails.length, 0);

    r = await c.req('POST', '/recuperar-senha', { email: 'MARIA@x.com' });
    assert.match(r.text, /estiver cadastrado/);
    await new Promise((res) => setTimeout(res, 50));
    assert.strictEqual(emails.length, 1);
    assert.strictEqual(emails[0].to, 'maria@x.com');
    assert.strictEqual(wa.received.length, 0, 'não deve enviar recuperação por WhatsApp');
    const link = emails[0].text.match(/https?:\/\/\S+\/redefinir-senha\/\S+/)[0];
    const path = new URL(link).pathname;

    r = await c.req('GET', path);
    assert.match(r.text, /maria@x.com/);
    r = await c.req('POST', path, { password: 'novaSenha1', confirm: 'diferente' });
    assert.match(r.text, /A confirmação não confere/);
    r = await c.req('POST', path, { password: 'novaSenha1', confirm: 'novaSenha1' });
    assert.strictEqual(r.location, '/login');

    // link não pode ser reutilizado
    r = await c.req('GET', path);
    assert.match(r.text, /inválido, já foi usado ou expirou/);

    // senha nova funciona, antiga não
    const aluno = new Client();
    await aluno.req('GET', '/login');
    r = await aluno.req('POST', '/login', { email: 'maria@x.com', password: 'senha123' });
    assert.strictEqual(r.status, 401);
    await aluno.login('maria@x.com', 'novaSenha1');
    await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [ids.student, await bcrypt.hash('senha123', 4)]);

    // token no banco é hash, não o token puro
    const token = path.split('/').pop();
    assert.strictEqual(await db.one('SELECT 1 FROM password_resets WHERE token_hash = $1', [token]), null);
  } finally {
    triggers.sendEmail = originalSendEmail;
    await settings.setMany({ smtp_host: '' });
    wa.close();
  }
});

test('gestor vê só a própria empresa e recebe gatilho de aluno parado', async () => {
  const wa = await fakeWhatsApp();
  try {
    const hash = await bcrypt.hash('senha123', 4);
    const acme = await db.one(`INSERT INTO companies (name) VALUES ('ACME') RETURNING id`);
    const other = await db.one(`INSERT INTO companies (name) VALUES ('Outra') RETURNING id`);
    await db.query('UPDATE users SET company_id = $1 WHERE id = $2', [acme.id, ids.student]);
    const outsider = await db.one(
      `INSERT INTO users (name, email, password_hash, role, company_id) VALUES ('Fora', 'fora@x.com', $1, 'student', $2) RETURNING id`,
      [hash, other.id]);
    await progress.enroll(outsider.id, ids.course, { silent: true });
    await db.query(`UPDATE enrollments SET enrolled_at = now() - interval '10 days' WHERE user_id = $1`, [outsider.id]);

    // admin cria o gestor pela tela (exige empresa)
    const admin = new Client();
    await admin.login('admin@x.com', 'senha123');
    let r = await admin.req('POST', '/admin/usuarios', { name: 'Gestor', email: 'gestor@x.com', phone: '11988887777', role: 'manager', password: 'senha123' });
    assert.match((await admin.req('GET', r.location)).text, /precisa estar vinculado a uma empresa/);
    r = await admin.req('POST', '/admin/usuarios', {
      name: 'Gestor ACME', email: 'gestor@x.com', phone: '11988887777', role: 'manager', company_id: acme.id, password: 'senha123',
    });
    assert.strictEqual((await db.one(`SELECT role FROM users WHERE email = 'gestor@x.com'`)).role, 'manager');

    const gestor = new Client();
    await gestor.req('GET', '/login');
    r = await gestor.req('POST', '/login', { email: 'gestor@x.com', password: 'senha123' });
    assert.strictEqual(r.location, '/gestor');
    r = await gestor.req('GET', '/gestor');
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /Maria Silva/);
    assert.doesNotMatch(r.text, /Fora/);
    r = await gestor.req('GET', `/gestor/curso/${ids.course}`);
    assert.match(r.text, /Maria Silva/);
    assert.doesNotMatch(r.text, /fora@x.com/);
    r = await gestor.req('GET', `/gestor/curso/${ids.course}?formato=csv`);
    assert.match(r.text, /Maria Silva/);
    assert.doesNotMatch(r.text, /Fora/);
    r = await gestor.req('GET', `/gestor/aluno/${ids.student}`);
    assert.strictEqual(r.status, 200);
    r = await gestor.req('GET', `/gestor/aluno/${outsider.id}`);
    assert.strictEqual(r.status, 404);
    r = await gestor.req('GET', '/admin');
    assert.strictEqual(r.status, 403);

    // aluno comum não entra no painel do gestor
    const aluno = new Client();
    await aluno.login('maria@x.com', 'senha123');
    assert.strictEqual((await aluno.req('GET', '/gestor')).status, 403);

    // gatilho: aluno parado → WhatsApp para o gestor da empresa
    const joao = await db.one(`SELECT id FROM users WHERE email = 'joao@x.com'`);
    await db.query('UPDATE users SET company_id = $1 WHERE id = $2', [acme.id, joao.id]);
    await db.query(`UPDATE activity SET created_at = now() - interval '10 days' WHERE user_id = $1`, [joao.id]);
    const t = await db.one(
      `INSERT INTO triggers (name, event, course_id, conditions, action, action_config)
       VALUES ('Avisar gestor', 'inactive', $1, '{"days": 3, "include_existing": true}', 'whatsapp',
               '{"to": "managers", "message": "{{nome}} está parado em {{curso}} ({{progresso}})"}') RETURNING id`, [ids.course]);
    await triggers.scanScheduled();
    await triggers.processJobs();
    const job = await db.one('SELECT * FROM trigger_jobs WHERE trigger_id = $1 AND user_id = $2', [t.id, joao.id]);
    assert.strictEqual(job.status, 'done', job.last_error);
    const msg = wa.received.find((m) => m.body.startsWith('João'));
    assert.ok(msg, 'gestor recebeu a mensagem');
    assert.strictEqual(msg.number, '5511988887777');
    // aluno de outra empresa sem gestor → erro registrado, não envia para ninguém errado
    const outsiderJob = await db.one('SELECT * FROM trigger_jobs WHERE trigger_id = $1 AND user_id = $2', [t.id, outsider.id]);
    assert.match(outsiderJob.last_error, /não tem gestor/);
  } finally {
    wa.close();
  }
});
