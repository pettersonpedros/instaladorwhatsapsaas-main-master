/* Rotinas automáticas (verifica a cada minuto; cada execução é registrada
   em job_runs para nunca repetir o mesmo envio):
   - relatórios agendados nos dias/horário configurados;
   - avisos de fim de teste por e-mail;
   - aviso ao comercial quando um teste termina com "suspender". */
const D = require('../shared/domain');
const store = require('./db');
const mailer = require('./mailer');
const svc = require('./services');

async function runReports(now) {
  const S = store.state({ history: false });
  for (const r of S.reports.filter(x => x.on)) {
    const ref = D.dueToday(r, now); if (!ref) continue;
    if (!store.claimJob(`rep:${r.id}:${ref}`)) continue;
    const rows = D.reportRows(S, r.tipo);
    const preview = rows.slice(0, 31).map(x => x.join(' | ')).join('\n');
    const res = await mailer.send({
      to: r.dest,
      subject: `YUV — ${r.tipo} (${D.dBR(D.isoOf(now))})`,
      text: `Relatório "${r.tipo}" gerado automaticamente.\n\n${preview}${rows.length > 31 ? `\n… e mais ${rows.length - 31} linhas no anexo.` : ''}`,
      attachments: r.fmt === 'E-mail' ? [] : [{ filename: `${D.slug(r.tipo)}.csv`, content: D.toCSV(rows) }]
    });
    store.db.prepare('UPDATE reports SET last_run=? WHERE id=?').run(new Date().toISOString(), r.id);
    console.log(`[agenda] relatório ${r.tipo} → ${r.dest}: ${res.ok ? 'ok' : res.error}`);
  }
}

async function runTrials(now) {
  const S = store.state({ history: false });
  const today = D.isoOf(now);
  for (const c of S.clients.filter(x => x.status === 'teste' && x.trial)) {
    const ti = D.trialInfo(c);
    // envia o aviso do dia (ou com até 2 dias de atraso, se o servidor ficou fora)
    const due = ti.ag.filter(a => !a.env && a.em <= today && D.diffDays(today, a.em) <= 2 && c.trial.fim >= today);
    const a = due[due.length - 1];
    if (a && store.claimJob(`trial:${c.id}:${a.d}:${c.trial.fim}`)) {
      try { await svc.sendTrialNotice(c.id, { d: a.d }, 'sistema'); } catch (e) { console.error('[agenda] aviso de teste', c.name, e.message); }
    }
    if (c.trial.aoFim === 'suspender' && c.trial.fim < today && store.claimJob(`trialend:${c.id}:${c.trial.fim}`)) {
      const to = S.cfg.emailComercial || S.cfg.emailFinanceiro;
      await mailer.send({ to, subject: `Teste terminou: ${c.name}`, text: `O teste gratuito de ${c.name} terminou em ${D.dBR(c.trial.fim)} e está configurado para suspender.\n\nDispositivos: ${D.calc(S, c).devices}\nContato: ${c.trial.email}\n\nConverta em cliente ou encerre o contrato no YUV Financeiro.` });
      store.addHistory(c.id, `Teste terminou — comercial avisado (${to})`, 'sistema');
    }
  }
}

let timer = null, running = false;
async function tick() {
  if (running) return; running = true;
  const now = new Date();
  try { await runReports(now); await runTrials(now); }
  catch (e) { console.error('[agenda]', e); }
  finally { running = false; }
}
function start() { if (timer) return; tick(); timer = setInterval(tick, 60e3); }
function stop() { clearInterval(timer); timer = null; }

module.exports = { start, stop, tick, runReports, runTrials };
