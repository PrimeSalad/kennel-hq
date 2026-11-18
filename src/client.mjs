// Kennel HQ client: `kennel ask|wait|status|brain|read|lessons|teach|bad|qa|import-claude|stop|install-skill`.
// Talks to the Kennel server running for a project folder (found via <folder>/.kennel/server.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const NAMES = { chou: 'Chou', harley: 'Harley', bacon: 'Bacon', pitchie: 'Pitchie', tiger: 'Tiger', asky: 'Asky', biscuit: 'Biscuit', lucifur: 'Lucifur', claude: 'Claude', team: 'Team' };
const STATUS = {
  verified: '✓ passed QA', 'self-checked': '✓ small + self-tested', 'pending-qa': '… waiting for QA', checking: '… in QA',
  fixing: '✗ being fixed', failed: '✗ failed', 'needs-you': '! NEEDS YOU', 'qa-skipped': '- QA skipped (limit)',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function run(args) {
  const cmd = args[0];
  const rest = args.slice(1);
  const flag = f => { const i = rest.indexOf(f); if (i >= 0) { rest.splice(i, 1); return true; } return false; };
  const opt = f => { const i = rest.indexOf(f); if (i >= 0 && rest[i + 1]) { const v = rest[i + 1]; rest.splice(i, 2); return v; } return null; };

  if (cmd === 'install-skill') return installSkill();

  const dir = path.resolve(opt('--dir') || process.cwd());
  const base = findServer(dir);
  if (!base) {
    console.error(`Kennel HQ isn't running for ${dir}
Start it with:  kennel serve    (in the background)
           or:  kennel          (interactive, with the office in your browser)`);
    return 2;
  }
  const api = async (p, body) => {
    const r = await fetch(base + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  const wait = flag('--wait');
  const timeoutMin = Number(opt('--timeout')) || 30;
  const since = Date.now() - 1000;

  try {
    switch (cmd) {
      case 'status': return printStatus(await api('/api/state'), base);
      case 'skills': {
        if (rest[0] === 'update') { await api('/api/skills', {}); console.log('Updating the skills from GitHub (see the Kennel terminal).'); return 0; }
        const r = await api('/api/skills');
        for (const [dog, list] of Object.entries(r.dogs)) console.log(`${(NAMES[dog] || dog).padEnd(8)} ${list.join(', ') || '(not downloaded yet)'}`);
        console.log(`from: ${r.sources.join(', ')}`);
        return 0;
      }
      case 'ask': {
        const dog = opt('--dog');
        const plan = flag('--plan');
        const text = rest.join(' ').trim();
        if (!text) { console.error('usage: kennel ask "<task>" [--dog <name>] [--plan] [--wait]'); return 1; }
        const r = await api('/api/task', { text, dog, plan, from: 'cli' });
        console.log(r.kind === 'plan' ? `Chou is planning it into tickets (id ${r.id}).` : `${NAMES[r.dog]} picked it up (id ${r.id}).`);
        return wait ? waitIdle(api, since, timeoutMin) : 0;
      }
      case 'wait': return waitIdle(api, since - 10 * 60_000, timeoutMin);
      case 'bad': {
        const [id, ...words] = rest;
        if (!id || !words.length) { console.error('usage: kennel bad <memory id> "<what is wrong>" [--wait]'); return 1; }
        const r = await api('/api/feedback', { id, text: words.join(' ') });
        console.log(`${NAMES[r.dog]} learned from that and is fixing it (id ${r.id}).`);
        return wait ? waitIdle(api, since, timeoutMin) : 0;
      }
      case 'teach': {
        const [who, ...words] = rest;
        if (!who || !words.length) { console.error('usage: kennel teach <dog|team> "<rule>"'); return 1; }
        const r = await api('/api/teach', { dog: who.toLowerCase(), text: words.join(' ') });
        console.log(r.lesson ? `${NAMES[r.lesson.dog] || 'Team'} learned: ${r.lesson.text}` : 'They already know that.');
        return 0;
      }
      case 'qa': {
        const r = await api('/api/qa', {});
        console.log(r.started ? `QA started for ${r.started} job(s).` : 'Nothing is waiting for QA.');
        return wait && r.started ? waitIdle(api, since, timeoutMin) : 0;
      }
      case 'learn-git': {
        console.log('Reading your branches and commits…');
        const r = await api('/api/learn-git', {});
        console.log(`Learned ${r.rules.length} git rules (${r.added} new):\n${r.rules.map(x => `  · ${x}`).join('\n')}`);
        return 0;
      }
      case 'import-claude': {
        console.log('Importing Claude Code memory (sorting out which rules apply to every project)…');
        const r = await api('/api/import', {});
        console.log(`Imported ${r.lessons} team lessons${r.memories ? ` and ${r.memories} notes about this project` : ''}${r.known ? `, ${r.known} already known` : ''}.`);
        return 0;
      }
      case 'brain': {
        const s = await api('/api/state');
        const q = rest.join(' ').toLowerCase();
        const list = s.brain.filter(m => !q || `${m.title} ${m.note}`.toLowerCase().includes(q)).slice(0, 20);
        if (!list.length) { console.log('Nothing in the brain yet.'); return 0; }
        for (const m of list) console.log(memLine(m));
        return 0;
      }
      case 'read': {
        if (!rest[0]) { console.error('usage: kennel read <memory id>'); return 1; }
        console.log((await api(`/api/memory/${encodeURIComponent(rest[0])}`)).output);
        return 0;
      }
      case 'lessons': {
        const s = await api('/api/state');
        const who = (rest[0] || '').toLowerCase();
        const list = s.lessons.filter(l => !who || l.dog === who);
        if (!list.length) { console.log('No lessons yet.'); return 0; }
        const src = { you: 'from you', review: 'from QA', claude: 'from Claude Code', self: 'self' };
        for (const l of list) console.log(`${(NAMES[l.dog] || l.dog).padEnd(8)} ${l.text}  (${src[l.source] || l.source})`);
        return 0;
      }
      case 'stop': await api('/api/quit', {}); console.log('Kennel HQ stopped.'); return 0;
    }
  } catch (err) {
    console.error(`kennel ${cmd}: ${err.message}`);
    return 1;
  }
  return 1;
}

function findServer(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, '.kennel', 'server.json'), 'utf8'));
    process.kill(s.pid, 0);
    return `http://127.0.0.1:${s.port}`;
  } catch { return null; }
}

function memLine(m) {
  const st = STATUS[m.status] ? `  [${STATUS[m.status]}]` : m.kind === 'review' ? `  [QA ${m.verdict}]` : '';
  return `${m.id}  ${(NAMES[m.dog] || m.dog).padEnd(8)} ${m.title}${st}\n${' '.repeat(m.id.length)}  ${m.note}${m.files?.length ? `\n${' '.repeat(m.id.length)}  files: ${m.files.join(', ')}` : ''}`;
}

function printStatus(s, base) {
  console.log(`Kennel HQ · ${s.folder} · ${base.replace('127.0.0.1', 'localhost')} · access: ${s.access} · QA: ${s.review ? 'on' : 'off'}${s.paused ? ' · PAUSED (limit)' : ''}`);
  for (const id of Object.keys(s.queues)) {
    const c = s.current[id];
    const what = c ? `${{ review: 'QA', fix: 'fixing', plan: 'planning' }[c.kind] || 'working on'}: ${c.title.replace(/^(QA|Fix|Plan): /, '')}` : 'idle';
    console.log(`  ${NAMES[id].padEnd(8)} ${what}${s.queues[id] ? `  (+${s.queues[id]} queued)` : ''}`);
  }
  const pend = s.brain.filter(m => m.status === 'pending-qa' || m.status === 'checking').length;
  const needs = s.brain.filter(m => m.status === 'needs-you');
  const w = s.limits?.unifiedWindows;
  console.log(`  ${s.usage.tasks} jobs done · ${s.lessons.length} lessons${pend ? ` · ${pend} waiting for QA` : ''}${w ? ` · 5h limit ${Math.round(w.five_hour.utilization * 100)}% used` : ''}`);
  for (const m of needs) console.log(`  ! needs you: ${m.title} (kennel read ${m.id})`);
  return 0;
}

// Wait until the pack is quiet (nothing running, queued, or waiting for QA), then report what happened.
async function waitIdle(api, since, timeoutMin) {
  const deadline = Date.now() + timeoutMin * 60_000;
  let lastLine = '';
  let quietChecks = 0;
  for (;;) {
    const s = await api('/api/state');
    const working = Object.entries(s.current);
    const queued = Object.values(s.queues).reduce((a, n) => a + n, 0);
    const qa = s.brain.some(m => m.status === 'pending-qa' || m.status === 'checking');
    const line = working.map(([id, c]) => `${NAMES[id]}: ${c.title}`).join(' | ') || (qa ? 'waiting for QA…' : '');
    if (line && line !== lastLine) { console.log(`… ${line}`); lastLine = line; }
    if (s.paused && !working.length) { console.log('Paused: the 5h Claude limit is almost used up. Work continues after it resets.'); return report(s, since, 4); }
    // QA starts a few seconds after the pack goes quiet, so require a couple of quiet checks in a row.
    quietChecks = !working.length && !queued && !qa ? quietChecks + 1 : 0;
    if (quietChecks >= 2) return report(s, since, 0);
    if (Date.now() > deadline) { console.log(`Still working after ${timeoutMin} min; stopped waiting (the pack keeps going). Run: kennel wait`); return report(s, since, 3); }
    await sleep(4000);
  }
}

function report(s, since, code) {
  const mems = s.brain.filter(m => m.t >= since).reverse();
  const work = mems.filter(m => m.kind === 'task' || m.kind === 'fix');
  const plans = mems.filter(m => m.kind === 'plan');
  const reviews = mems.filter(m => m.kind === 'review');
  const learned = s.lessons.filter(l => l.t >= since);
  const errors = (s.errors || []).filter(e => e.t >= since);
  console.log('\n=== Kennel report ===');
  for (const m of plans) console.log(`Plan (Chou): ${m.note}`);
  if (work.length) { console.log('\nWork:'); for (const m of work) console.log(memLine(m)); }
  if (reviews.length) { console.log('\nQA:'); for (const m of reviews) console.log(`${m.id}  ${NAMES[m.dog]}: ${m.verdict} — ${m.note}`); }
  if (learned.length) { console.log('\nLearned:'); for (const l of learned) console.log(`  ${(NAMES[l.dog] || l.dog).padEnd(8)} ${l.text}`); }
  if (errors.length) { console.log('\nErrors:'); for (const e of errors) console.log(`  ${NAMES[e.dog]}: ${e.message}`); }
  const needs = s.brain.filter(m => m.status === 'needs-you');
  if (needs.length) { console.log('\nNeeds you:'); for (const m of needs) console.log(`  ${m.title}  (kennel read ${m.id})`); }
  if (!work.length && !plans.length && !errors.length) console.log('Nothing new finished.');
  return code || (errors.length || needs.length ? 1 : 0);
}

function installSkill() {
  const src = path.join(here, '..', 'skills', 'kennel', 'SKILL.md');
  const destDir = path.join(os.homedir(), '.claude', 'skills', 'kennel');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, 'SKILL.md'));
  console.log(`Installed the kennel skill to ${path.join(destDir, 'SKILL.md')}
In Claude Code, say things like "send this to the pack" or "have Bacon add an index", or type /kennel.`);
  return 0;
}
