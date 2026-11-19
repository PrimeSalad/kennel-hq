#!/usr/bin/env node
// Kennel HQ — run `kennel` in any project folder. Each dog is a headless Claude Code worker
// (your own Claude login, no API key). Chou plans big requests into tickets, QA runs once per batch,
// mistakes become lessons, and everything lands in the shared brain at <folder>/.kennel/.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTUI, width, fit, pad, strip } from './tui.mjs';
import { portrait, mini } from './sprites.mjs';
import { newToken, lanAddress, qrLines, qrMatrix } from './remote.mjs';
import { installSkills, hasSkills, pluginDir, skillNames, skillsInstalled, DOG_SKILLS, SOURCES } from './skills.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Bump when the office page needs something new from the server, so an old running server says "restart me".
const API_VERSION = 5;

// `kennel ask|status|…` talk to a running server; they live in client.mjs.
const CLIENT_CMDS = new Set(['skills', 'ask', 'wait', 'status', 'brain', 'read', 'lessons', 'teach', 'bad', 'qa', 'import-claude', 'learn-git', 'stop', 'install-skill']);
if (CLIENT_CMDS.has(process.argv[2])) {
  const { run } = await import('./client.mjs');
  process.exit(await run(process.argv.slice(2)));
}

/* ================================================================== config */
const HEADLESS = process.argv[2] === 'serve'; // background mode: no prompt, logs only (used by the Claude skill)
const argv = process.argv.slice(HEADLESS ? 3 : 2);
const flag = f => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
if (flag('-h') || flag('--help')) {
  console.log(`
  kennel [folder] [options]       open Kennel HQ with the interactive prompt
  kennel serve [folder] [options] run it in the background (no prompt, logs only)

  Talk to a running Kennel from any terminal in the project folder:
    kennel ask "<task>" [--dog <name>] [--plan] [--wait]
    kennel status | wait | brain [search] | read <id> | lessons [dog]
    kennel teach <dog|team> "<rule>" | bad <id> "<what's wrong>" [--wait]
    kennel qa [--wait] | import-claude | stop
    kennel install-skill            install the /kennel skill for Claude Code

  The dogs work on the project folder using your Claude Code login.

  Access (default: full access, the dogs run with --dangerously-skip-permissions)
    --safe            dogs can read and edit files but can't run commands
    --read-only       dogs can read files but not change anything

  --remote          open the office to your phone on the same Wi-Fi (shows a QR code)
  --mcp             let the dogs use your MCP servers / claude.ai connectors (off to save tokens)
  --review <mode>   QA: smart (default: only risky or untested changes), always, off
  --no-review       same as --review off
  --no-plan         never split big requests into tickets
  --no-triage       skip Lucifur's front desk (every message becomes a job)
  --triage-model <n> model for the front desk (default: haiku when quiet, sonnet when the pack is busy)
  --model <name>    model for the work (default: opus)
  --qa-model <name> model for QA checks (default: sonnet)
  --chat-model <n>  model for chatting with the dogs (default: haiku)
  --effort <lvl>    low | medium | high | xhigh | max
  --port <n>        port for the office page (default 4321, or the next free one)
  --no-open         don't open the browser
`);
  process.exit(0);
}
const VALUE_FLAGS = ['--port', '--model', '--effort', '--qa-model', '--chat-model', '--review', '--triage-model'];
const folderArg = argv.find((a, i) => !a.startsWith('-') && !VALUE_FLAGS.includes(argv[i - 1]));
const WORKDIR = path.resolve(folderArg || process.cwd());
if (!fs.existsSync(WORKDIR) || !fs.statSync(WORKDIR).isDirectory()) { console.error(`Not a folder: ${WORKDIR}`); process.exit(1); }
const FOLDER = path.basename(WORKDIR);
const ACCESS = flag('--read-only') ? 'read-only' : flag('--safe') ? 'safe' : 'full';
// QA: "smart" (default) only checks risky or unverified changes, "always" checks every change, "off" never.
const REVIEW_MODE = flag('--no-review') ? 'off' : ['always', 'smart', 'off'].includes(opt('--review', '')) ? opt('--review', '') : 'smart';
const REVIEW = REVIEW_MODE !== 'off' && ACCESS !== 'read-only';
const PLAN = !flag('--no-plan');
// Front desk: every message from you is read first by Lucifur on a tiny, cheap call, so greetings and
// questions don't start a full (expensive) job.
const TRIAGE = !flag('--no-triage');
const TRIAGE_MODEL = opt('--triage-model', process.env.KENNEL_TRIAGE_MODEL || 'haiku');
// When several messages arrive together, or the pack is busy, the desk has to reason about the live board
// (follow-ups, duplicates, file clashes), so it uses a stronger model. Still a single small call with no tools.
const DESK_MODEL = opt('--triage-model', process.env.KENNEL_DESK_MODEL || 'sonnet');
const NO_OPEN = flag('--no-open') || HEADLESS;
const USE_MCP = flag('--mcp');
let REMOTE = flag('--remote');
const MODEL = opt('--model', process.env.KENNEL_MODEL || '');
// Opus does the work. Haiku runs the front desk and chat, Sonnet runs the (rare) QA checks.
const WORK_MODEL = MODEL || 'opus';
const QA_MODEL = opt('--qa-model', process.env.KENNEL_QA_MODEL || 'sonnet');
const EFFORT = opt('--effort', process.env.KENNEL_EFFORT || '');
let PORT = Number(opt('--port', process.env.PORT)) || 4321;

// Workflow rules
const MAX_FIX_ROUNDS = 2;        // QA can send work back this many times before it's handed to you
const QA_DELAY_MS = 12_000;      // wait this long after the pack goes quiet before running QA (more work may come)
const SMALL_DIFF_LINES = 8;      // changes this small that the dog already tested skip QA
const QA_OFF_AT = 0.80;          // 5h limit usage where QA is skipped
const PAUSE_AT = 0.95;           // 5h limit usage where new work waits for the reset
const DOC_FILE = /\.(md|mdx|txt|rst|png|jpe?g|gif|svg|webp|ico|mp4|mov|mkv|webm|avi|m4v|wav|mp3|m4a|aac|flac|ogg|srt|vtt|ass|cube|psd)$/i;

const PUBLIC = path.join(here, '..', 'public');
const BRAIN_DIR = path.join(WORKDIR, '.kennel');
const MEM_DIR = path.join(BRAIN_DIR, 'memories');
fs.mkdirSync(MEM_DIR, { recursive: true });
try { if (!fs.existsSync(path.join(BRAIN_DIR, '.gitignore'))) fs.writeFileSync(path.join(BRAIN_DIR, '.gitignore'), '# Kennel HQ brain. Delete this file if you want to commit it.\n*\n'); } catch { /* fine */ }
const IS_GIT = fs.existsSync(path.join(WORKDIR, '.git'));

// `claude` isn't always on PATH (the native installer puts it in ~/.local/bin), so look in the usual places too.
function findClaude() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const home = os.homedir();
  const candidates = [process.env.KENNEL_CLAUDE, 'claude', path.join(home, '.local', 'bin', exe), path.join(home, '.claude', 'local', exe),
    '/usr/local/bin/claude', '/opt/homebrew/bin/claude'].filter(Boolean);
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return { cmd, version: r.stdout.trim() };
  }
  return { cmd: 'claude', version: null };
}
const { cmd: CLAUDE, version: CLAUDE_VERSION } = findClaude();

/* ================================================================== team */
const DOGS = {
  chou: {
    name: 'Chou', breed: 'Corgi', role: 'Lead Developer', rgb: [255, 179, 71], types: ['Decision', 'Review', 'Code'],
    job: 'Make technical decisions, review code and plans, write architecture decision records, and break big work into tickets. When reviewing, give specific findings ordered by importance, with file paths and line numbers.',
  },
  harley: {
    name: 'Harley', breed: 'Shih Tzu', role: 'Software Engineer', rgb: [182, 156, 255], types: ['Code'],
    job: 'Write and change application code, frontend and backend. Follow the conventions already in the project.',
  },
  bacon: {
    name: 'Bacon', breed: 'Mal-Shi (Maltese × Shih Tzu)', role: 'Database Manager', rgb: [255, 122, 92], types: ['Schema'],
    job: 'Design schemas, write SQL, migrations (always with a rollback), indexes and query optimizations. Say briefly why each index exists. Use whatever database and migration tool the project already uses; default to PostgreSQL if there is none. Never run a migration against a real or shared database; local/dev only.',
  },
  pitchie: {
    name: 'Pitchie', breed: 'Japanese Spitz', role: 'QA Tester', rgb: [126, 224, 176], types: ['Test', 'Bug'],
    job: 'Write test plans and automated tests using the project\'s existing test setup (Vitest for unit and Playwright for end-to-end if there is none). Hunt for bugs; report each with steps to reproduce, expected vs actual behaviour, severity, and the file and line. Use TYPE Bug when the main output is a bug report.',
  },
  tiger: {
    name: 'Tiger', breed: 'Beagle', role: 'DevOps Engineer', rgb: [121, 199, 255], types: ['Deploy'],
    job: 'Write CI/CD pipelines (GitHub Actions unless the project uses something else), Dockerfiles, infrastructure config, alert rules and deploy runbooks. Always include how to roll back. Never deploy to or change real cloud resources yourself; prepare the config and tell the human the command.',
  },
  asky: {
    name: 'Asky', breed: 'Mal-Shi (Shih Tzu × Maltese)', role: 'UI/UX Designer', rgb: [232, 121, 249], types: ['Design', 'Code'],
    job: `Own how the product looks, feels and reads, and build it in code yourself in the project's stack. Your skills:
- UX: user flows, information architecture, wireframes, usability heuristics (Nielsen), onboarding and conversion flows, forms and validation UX, empty/loading/error/success states, UX writing and microcopy.
- Visual design: typography (type scale, pairing, line length, rhythm), color systems (semantic tokens, contrast, dark mode), spacing scales and layout grids, iconography, illustration and imagery direction, data visualization.
- Design systems: design tokens, component libraries and variants, documentation, consistency audits.
- Accessibility: WCAG 2.2 AA, keyboard paths and focus states, ARIA, screen readers, color-blind safe palettes, reduced motion, touch target sizes.
- Motion: micro-interactions, transitions with purpose, easing and duration, performance-safe animation.
- Front-end craft: semantic HTML, CSS grid/flexbox/container queries/custom properties, Tailwind, CSS modules, CSS-in-JS, React/Vue/Svelte/React Native styling, SVG, responsive images, Core Web Vitals (CLS, LCP), i18n and RTL.
- Design QA: compare the build against the intent at phone, tablet and desktop widths and fix what's off.
Make interfaces distinctive and intentional, never generic AI-looking. If design-related Claude Code skills are available to you, use them.`,
  },
  biscuit: {
    name: 'Biscuit', breed: 'Golden Retriever', role: 'Technical Writer', rgb: [45, 212, 191], types: ['Docs'],
    job: `Own the documentation, written for the people who will actually read it:
- READMEs, setup and onboarding guides, how-tos and tutorials, runbooks, architecture notes, changelogs and release notes.
- API and code docs: JSDoc/TSDoc/docstrings, OpenAPI descriptions, meaningful code comments (why, not what).
- Keep docs in sync with the code: read the code before documenting it, and fix docs that no longer match.
- Every command and example must work: run them when you can, and say so when you couldn't.
- Match the project's existing doc style and structure. Be concise: short sentences, real examples, no filler or marketing tone.`,
  },
  lucifur: {
    name: 'Lucifur', breed: 'Doberman', role: 'Mentor', rgb: [239, 68, 68], types: ['Lesson'], readOnly: true,
    job: 'Teach. Explain how the code works, why something broke, and the concepts behind it, at the level the human needs, using small examples from this very project. Go step by step, and end with the one thing worth remembering. You never change code.',
  },

  // The Cattery: the video studio upstairs. Cats, because editors keep cat hours.
  seah: {
    name: 'Seah', breed: 'Grey cat', animal: 'cat', role: 'Lead Video Editor', rgb: [124, 214, 168], types: ['Video', 'Decision'],
    job: `Lead the video studio and own the edit. Your craft:
- Story and pacing: find the hook in the first 2 seconds, cut on action and on the beat, remove dead air, J- and L-cuts, keep a rhythm.
- FFmpeg: trim, concat, reframe (16:9, 9:16, 1:1, 4:5), speed ramps, overlays, picture-in-picture, crossfades, frame-accurate seeking. Re-encode with sane defaults (H.264 yuv420p, +faststart, CRF 18–23) unless the project says otherwise.
- Remotion (React video) when the edit is built in code: compositions, sequences, timing in frames, rendering.
- Plan multi-part video jobs for the other cats: Yuki (motion), Shadow (color/VFX), Snow (sound/captions), Goose (shorts/thumbnails).
- Delivery: platform specs (YouTube 16:9, Shorts/Reels/TikTok 9:16 under their length limits), file size targets, bitrate.`,
  },
  yuki: {
    name: 'Yuki', breed: 'White cat', animal: 'cat', role: 'Motion Designer', rgb: [196, 181, 253], types: ['Video', 'Design'],
    job: `Design and build motion graphics in code, mostly Remotion (React video), sometimes HTML/CSS/SVG/Lottie.
- Titles, intros/outros, logo reveals, lower thirds, kinetic typography, animated charts and explainers, transitions.
- Motion craft: never linear easing, springs for entrances, stagger elements by a few frames, exits faster than entrances, a clear type hierarchy and a limited palette, safe margins for every aspect ratio.
- Build reusable components with props (text, colors, duration) so edits are cheap. Preview at low resolution before a full render.`,
  },
  shadow: {
    name: 'Shadow', breed: 'Black Persian', animal: 'cat', role: 'Colorist & VFX', rgb: [251, 146, 60], types: ['Video'],
    job: `Own how the footage looks.
- Color: correct first (exposure, white balance, contrast), then grade (look, mood, skin tones). Apply and build LUTs (.cube), match shots to each other, keep broadcast-safe levels.
- FFmpeg filters: eq, curves, colorbalance, lut3d, colorspace/zscale (HDR to SDR tone mapping), denoise (hqdn3d/nlmeans), sharpen (unsharp), deband, stabilize (vidstab), chroma key (chromakey/colorkey + despill), masks and compositing.
- Always grade from the original source, never re-grade an already graded export. Compare before/after stills (extract a frame) and say what changed.`,
  },
  snow: {
    name: 'Snow', breed: 'Tuxedo cat', animal: 'cat', role: 'Sound & Captions', rgb: [125, 211, 252], types: ['Video', 'Docs'],
    job: `Own everything you hear and read in a video.
- Audio: clean dialogue (highpass, de-noise with afftdn/arnndn, de-ess, compression), music beds with ducking under voice (sidechaincompress), fades, sync audio to video, remove silences.
- Loudness: two-pass loudnorm to the platform target (about -14 LUFS for YouTube/streaming, -16 for podcasts, true peak -1 dBTP), and report the measured values.
- Captions: transcribe when a tool is available (whisper/faster-whisper), write SRT/VTT with good line breaks (max ~42 chars, 2 lines, reading speed), burn them in with styled subtitles or animated Remotion captions, and translate them when asked.`,
  },
  goose: {
    name: 'Goose', breed: 'Black cat', animal: 'cat', role: 'Shorts & Thumbnails', rgb: [250, 204, 21], types: ['Video', 'Design'],
    job: `Turn videos into things people click and watch on every platform.
- Shorts/Reels/TikTok: find the strongest moments, cut 15–60 s vertical versions with a hook in the first second, reframe to 9:16 keeping the subject centered, big readable captions inside the safe zone.
- Thumbnails and cover frames: pick or extract the best frame, design bold, high-contrast thumbnails (1280×720) with few words; also GIF and still exports.
- Delivery: export per-platform files with correct resolution, fps, bitrate and duration limits, plus titles, descriptions, chapters and hashtags when asked.`,
  },
};
// Video work needs tools on the machine; tell the cats how to work with media safely.
const VIDEO_RULES = `Working with media:
- Check your tools first (ffmpeg -version, ffprobe, node/Remotion in package.json, python3 for scripts). If something essential is missing, say exactly how to install it instead of faking the result.
- ffprobe every input before you touch it (duration, resolution, fps, codecs, audio channels). Never overwrite or re-encode the source files: write results to a new file (an out/ or exports/ folder, or name-edit.mp4).
- Test on a short excerpt or a low-resolution preview first, then do the full render. Long renders: run them once, at the end.
- Verify the output with ffprobe (duration, streams, size) and, for visual changes, extract a frame to check. Report the output path, length, resolution and file size.`;
const IDS = Object.keys(DOGS);
const ROUTES = [
  ['snow', /\b(audio|sound|music|voice ?over|loudness|lufs|podcast|subtitles?|captions?|srt|vtt|transcribe|transcript|ducking|denoise)\b/i],
  ['shadow', /\b(colou?r ?grad\w*|grade|lut|luts|vfx|green ?screen|chroma|stabili[sz]e|hdr|tone ?map\w*)\b/i],
  ['goose', /\b(shorts?|reels?|tiktok|thumbnails?|vertical video|gif)\b/i],
  ['yuki', /\b(motion graphics?|remotion|lower thirds?|intro|outro|logo reveal|kinetic|title card)\b/i],
  ['seah', /\b(video|videos|footage|clip|clips|ffmpeg|montage|timeline|b-?roll|vlog|youtube)\b/i],

  ['bacon', /\b(db|database|sql|query|queries|index|indexes|migration|migrations|schema|table|tables|postgres|mysql|mongo|sqlite|prisma|supabase|backup|redis)\b/i],
  ['pitchie', /\b(test|tests|testing|qa|bug|bugs|regression|e2e|verify|repro|flaky)\b/i],
  ['tiger', /\b(deploy|deployment|ci|cd|docker|dockerfile|k8s|kubernetes|infra|server|servers|pipeline|release|devops|aws|nginx|dns|ssl|cloudflare)\b/i],
  ['asky', /\b(ui|ux|design|redesign|css|style|styling|layout|colou?rs?|fonts?|typography|animation|responsive|mobile view|figma|tailwind|landing|look|looks|pangit|ganda|gandahan|accessibility|a11y|dark mode)\b/i],
  ['biscuit', /\b(docs?|documentation|document|readme|changelog|release notes|jsdoc|tsdoc|docstrings?|guide|tutorial|how-?to|onboarding|wiki|api docs)\b/i],
  ['lucifur', /\b(explain|teach|turo|ituro|paano|bakit|why|how does|what is|ano ang|ano yung|learn|lesson|understand|intindihin)\b/i],
  ['chou', /\b(review|plan|planning|architecture|adr|decide|decision|estimate|roadmap|spec|breakdown|overview)\b/i],
];
const route = text => (ROUTES.find(([, re]) => re.test(text)) || ['harley'])[0];
// A request gets planned into tickets when it's long or clearly has several parts.
// Video projects are planned by Seah (the studio lead) instead of Chou.
const VIDEO_WORK = /\b(video|videos|footage|clips?|reels?|shorts?|tiktok|youtube|vlog|montage|trailer|teaser|promo video|motion graphics|remotion|ffmpeg|subtitles?|captions?|color ?grad\w*|thumbnails?)\b/i;
const plannerFor = text => (VIDEO_WORK.test(text) ? 'seah' : 'chou');
const needsPlan = text => text.length > 220 || (text.match(/\b(and then|then|tapos|saka|also|plus|pati)\b|;|\n|\d\)\s/gi) || []).length >= 2;

/* ================================================================== storage */
const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const BRAIN_FILE = path.join(BRAIN_DIR, 'brain.json');
const USAGE_FILE = path.join(BRAIN_DIR, 'usage.json');
const LESSONS_FILE = path.join(BRAIN_DIR, 'lessons.json');
const brain = readJSON(BRAIN_FILE, []);
const usage = readJSON(USAGE_FILE, { tokens: 0, cost: 0, tasks: 0 });
const lessons = readJSON(LESSONS_FILE, []); // {id, dog: id|'team', text, source: self|review|you|claude, t}
let limits = null;
const saveBrain = () => fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
const saveUsage = () => fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
const saveLessons = () => fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessons, null, 2));
const memPath = id => path.join(MEM_DIR, `${id}.md`);
const readOutput = id => { try { return fs.readFileSync(memPath(id), 'utf8'); } catch { return null; } };
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const findMem = id => brain.find(m => m.id === id);

// Your avatar at the boss desk. Global, so it follows you to every project.
const PROFILE_FILE = path.join(os.homedir(), '.kennel', 'profile.json');
let profile = readJSON(PROFILE_FILE, null);
const HEX = /^#[0-9a-f]{6}$/i;
function setProfile(d) {
  const p = {
    name: String(d.name || '').trim().slice(0, 24) || 'Boss',
    look: d.look === 'female' ? 'female' : 'male',
    skin: HEX.test(d.skin) ? d.skin : '#f1c27d',
    hair: HEX.test(d.hair) ? d.hair : '#24191f',
    outfit: HEX.test(d.outfit) ? d.outfit : '#3b4a6b',
  };
  fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(p, null, 2));
  profile = p;
  emit({ type: 'profile', profile });
  return p;
}

// Coco was renamed to Asky: carry her old work and lessons over.
for (const m of brain) if (m.dog === 'coco') m.dog = 'asky';
for (const l of lessons) if (l.dog === 'coco') l.dog = 'asky';

// QA states that were in flight when kennel was closed go back to the queue.
for (const m of brain) if (m.status === 'checking') m.status = 'pending-qa';

function addLesson(dog, text, source) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text || /^(none|n\/a|-|nothing)\.?$/i.test(text)) return null;
  const key = text.toLowerCase();
  if (lessons.some(l => l.dog === dog && l.text.toLowerCase() === key)) return null;
  const lesson = { id: rid(), dog, text, source, t: Date.now() };
  lessons.unshift(lesson);
  const counts = {};
  for (let i = 0; i < lessons.length; i++) {
    const k = lessons[i].dog; counts[k] = (counts[k] || 0) + 1;
    if (counts[k] > (k === 'team' ? 80 : 40)) lessons.splice(i--, 1);
  }
  saveLessons();
  emit({ type: 'lesson', lesson });
  return lesson;
}

function setStatus(mem, status, extra = {}) {
  if (!mem) return;
  Object.assign(mem, { status }, extra);
  saveBrain();
  emit({ type: 'memupdate', mem });
}
// A fix memory points at what it fixed; a verdict applies to the whole chain.
function setChainStatus(mem, status, extra) {
  const seen = new Set();
  while (mem && !seen.has(mem.id)) { seen.add(mem.id); setStatus(mem, status, extra); mem = mem.fixOf ? findMem(mem.fixOf) : null; }
}

/* ================================================================== import Claude Code memory */
// Notes from other projects can mention clients, people and incidents, so Claude distils them into
// general working rules first; only those rules become team lessons here.
function distillRules(items) {
  return new Promise(resolve => {
    const prompt = `Below are notes Claude Code saved about how a developer likes to work, collected across many of their projects.
Pull out only the rules that would help on ANY software project: coding and verification habits, git/commit preferences, design taste, communication style.
Skip anything tied to one specific project, client, product, person, deadline or incident, and never include names.
Merge duplicates. Write each as a short imperative rule (max 25 words).
Output one rule per line as "RULE: ...", at most 15 rules, and nothing else.

${items.map(i => `- ${i}`).join('\n')}`;
    quickClaude(prompt).then(text => resolve(text == null ? null : [...text.matchAll(/^RULE:\s*(.+)$/gm)].map(m => m[1].trim())));
  });
}

// A small one-shot Claude call with no tools, no MCP and a tiny system prompt: cheap summarising jobs.
function quickClaude(prompt, system = 'You turn raw notes into short, general, reusable rules. Follow the output format exactly.') {
  return new Promise(resolve => {
    const child = spawn(CLAUDE, ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--strict-mcp-config',
      '--disable-slash-commands', '--effort', 'low', '--model', QA_MODEL, '--system-prompt', system],
    { cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let outText = '';
    child.stdout.on('data', b => { outText += b; });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try { const r = JSON.parse(outText); resolve(r.is_error ? null : String(r.result || '')); } catch { resolve(null); }
    });
    child.stdin.end(prompt);
  });
}

/* ================================================================== learn the git workflow */
const GIT_FILE = path.join(BRAIN_DIR, 'git.json');
const git = (...a) => { const r = spawnSync('git', a, { cwd: WORKDIR, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }); return r.status === 0 ? r.stdout.trim() : ''; };
function gitFingerprint() { return git('for-each-ref', '--format=%(refname:short) %(objectname:short)', 'refs/heads', 'refs/remotes'); }

async function learnGit() {
  if (!IS_GIT) return { error: 'This folder isn\'t a git repo.' };
  const branches = git('for-each-ref', '--sort=-committerdate', '--count=60', '--format=%(refname:short) | %(committerdate:relative)', 'refs/heads', 'refs/remotes');
  const commits = git('log', '--all', '-n', '120', '--no-merges', '--format=%s');
  const merges = git('log', '--all', '-n', '25', '--merges', '--format=%s');
  const current = git('rev-parse', '--abbrev-ref', 'HEAD');
  const base = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD') || '(unknown)';
  const files = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'CONTRIBUTING.md', 'commitlint.config.js', '.commitlintrc', '.commitlintrc.json', '.husky/commit-msg', '.github/workflows']
    .filter(f => fs.existsSync(path.join(WORKDIR, f)));
  if (!commits) return { error: 'No commits to learn from yet.' };
  const prompt = `Below is the git history of a software project. Work out how this team actually uses git, so new teammates can follow the same workflow.
Cover only what the history shows clearly: branch naming pattern and prefixes, which branch work starts from and merges into, commit message style (format, prefixes, tense, language, ticket ids), how merges/PRs happen, and anything the config files imply.
Skip guesses, skip anything about specific features, and never include people's names.
Write each finding as a short imperative rule (max 25 words). Output one rule per line as "RULE: ...", at most 8 rules, and nothing else.

Current branch: ${current}
Default remote branch: ${base}
Workflow files present: ${files.join(', ') || 'none'}

Branches (newest first):
${branches}

Merge commits:
${merges || '(none)'}

Recent commit messages:
${commits}`;
  const text = await quickClaude(prompt);
  if (text == null) return { error: 'Couldn\'t analyse the git history right now.' };
  const rules = [...text.matchAll(/^RULE:\s*(.+)$/gm)].map(m => m[1].trim());
  let added = 0;
  for (const r of rules) if (addLesson('team', r, 'git')) added++;
  fs.writeFileSync(GIT_FILE, JSON.stringify({ learned: Date.now(), fingerprint: gitFingerprint(), rules }, null, 2));
  return { added, rules };
}

// Learn once per repo, and again when the branches have changed and it's been a few days.
function gitNeedsLearning() {
  if (!IS_GIT || !CLAUDE_VERSION) return false;
  const g = readJSON(GIT_FILE, null);
  if (!g) return true;
  return Date.now() - g.learned > 3 * 86400_000 && g.fingerprint !== gitFingerprint();
}

async function importClaudeMemory() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const thisProject = WORKDIR.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const res = { lessons: 0, memories: 0, known: 0, projects: 0, general: 0, distilled: true };
  const others = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return res; }
  for (const dir of dirs) {
    const memDir = path.join(root, dir.name, 'memory');
    let files = [];
    try { files = fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md'); } catch { continue; }
    if (!files.length) continue;
    res.projects++;
    const isThis = dir.name.toLowerCase() === thisProject;
    for (const f of files) {
      const src = path.join(memDir, f);
      let raw; try { raw = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n'); } catch { continue; }
      const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      const fm = m ? m[1] : '';
      const body = (m ? m[2] : raw).trim();
      const get = k => fm.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '');
      const type = (get('type') || '').toLowerCase();
      const name = get('name') || f.replace(/\.md$/, '');
      const desc = get('description') || body.split('\n').find(Boolean) || name;
      if (type === 'user' || type === 'feedback') {
        if (isThis) { if (addLesson('team', desc, 'claude')) res.lessons++; else res.known++; }
        else others.push(desc);
      } else if (isThis) {
        // Project facts only come in for the project they belong to.
        if (brain.some(x => x.src === src)) { res.known++; continue; }
        const id = rid();
        const mem = { id, dog: 'claude', type: 'Memory', title: name, note: desc.slice(0, 240), t: Date.now(), src, files: [], kind: 'import' };
        fs.writeFileSync(memPath(id), `# ${name}\n\n_Imported from Claude Code memory (${f})_\n\n> ${desc}\n\n---\n\n${body}\n`);
        brain.unshift(mem); res.memories++;
        emit({ type: 'memadd', mem });
      }
    }
  }
  saveBrain();
  if (others.length && CLAUDE_VERSION) {
    const rules = await distillRules(others);
    if (!rules) res.distilled = false;
    for (const rule of rules || []) { if (addLesson('team', rule, 'claude')) { res.lessons++; res.general++; } else res.known++; }
  }
  return res;
}

/* ================================================================== prompts */
const ACCESS_TEXT = {
  full: 'You have full access to this machine: you can read and edit files and run any command. Use it carefully. Never delete or overwrite things outside the task, never run destructive commands (rm -rf, git reset --hard, force-push, dropping databases) unless the task explicitly asks, never touch real/production systems, never force-push, and only push to a remote when the human or a team lesson asks for it.',
  safe: 'You can read and edit files in this project but you can\'t run commands. If something needs running (tests, migrations, installs), say exactly what to run.',
  'read-only': 'You can read the project but not change it. Put any code you write in your reply.',
};

function persona(id, kind) {
  const d = DOGS[id];
  const team = IDS.map(k => `${DOGS[k].name} (${DOGS[k].role})`).join(', ');
  const lessonText = ''; // lessons go in the prompt (see relevantLessons) so this text never changes and stays cached
  const format = kind === 'task' || kind === 'fix'
    ? `When you're finished, your final reply must use exactly this format:
TYPE: one of ${d.types.join(' | ')}
SUMMARY: one sentence, under 25 words, saying what you did (teammates see this in the brain)
LESSON: one short, reusable rule you learned about this project or your own work that would help next time, or "none"
---
<report in Markdown. If the human asked a question, start with the direct, complete answer to it. Then: what you changed (file paths), what you ran to verify it and the result, anything the human must run or decide. If nothing needed changing, just answer.>`
    : 'Use the reply format given in the request.';
  const where = d.animal === 'cat' ? 'in the Cattery, Kennel HQ\'s video studio upstairs' : 'at Kennel HQ';
  return `You are ${d.name}, a ${d.breed} who works as the ${d.role} ${where}. Kennel HQ is a small team: dogs build software downstairs and cats make videos upstairs (${team}). The human who runs the team gives you work in the project folder you're in.

Your job: ${d.job}
${d.animal === 'cat' ? `\n${VIDEO_RULES}\n` : ''}${hasSkills(id) ? `
Your skills (use the Skill tool when one fits the job; don't load ones that don't): ${skillNames(id).join(', ')}.
` : ''}
${ACCESS_TEXT[kind === 'plan' || d.readOnly ? 'read-only' : ACCESS]}
Git: don't create, switch or delete branches, and don't commit or push, unless the task or a team lesson asks for it. When you do, follow the team's git conventions from the lessons.
Teammates may be working in this folder at the same time, so only touch what your task needs and re-read a file right before you edit it.

How to avoid mistakes without wasting effort:
- Read only the code you need, and match the project's existing patterns.
- ${ACCESS === 'full' ? 'After changing code, run the project\'s own checks that cover what you touched (tests, typecheck, lint, build — see package.json, Makefile, pyproject…) and fix failures before you finish. If there are no checks, at least run or import what you touched.' : 'Re-read your changes before you finish.'}
- Never say something works unless you verified it. If you couldn't verify, say so plainly.
- If the task is a question ("bakit…?", "how does…?", "is it safe to…?"), the answer is the deliverable: investigate as needed and answer it clearly. Only change code if they asked for a change.
- If the task is ambiguous, pick the most reasonable reading and state the assumption. The human isn't watching live, so decide instead of asking.

Think like a senior engineer:
- First pin down the goal and what "done" means. Then find the real cause or the right place (Grep/Glob), not just the first match.
- Before changing a function, signature or shared style, check who uses it and keep them working.
- Handle the edge cases the change obviously creates (empty, null, error, loading states). No TODOs or placeholder code.
- If it's already done, or the request rests on a wrong assumption, say so instead of changing code.
- When notes from the front desk name files, start there.
- Keep reports short. No restating the task.
${lessonText}
The team brain (given in the request, full notes under .kennel/memories/) is what the team already did and decided. Stay consistent with it. Write in a clear, professional tone; no role-play. Write your report in the same language the task was written in (English, Tagalog, Taglish or any other); code and technical terms stay as they are.

${format}`;
}

// Only the lessons that matter for this job: everything you taught, plus the ones that share words with the task.
function relevantLessons(dog, text) {
  const words = new Set((text.toLowerCase().match(/[a-z0-9_]{4,}/g) || []));
  const score = l => { let s = 0; for (const w of words) if (l.text.toLowerCase().includes(w)) s++; return s; };
  const pick = (list, n) => list.map(l => ({ l, s: score(l) + (l.source === 'you' ? 2 : 0) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map(x => x.l);
  const fromYou = lessons.filter(l => l.source === 'you' && (l.dog === 'team' || l.dog === dog)).slice(0, 6);
  const chosen = new Map([...fromYou, ...pick(lessons.filter(l => l.dog === 'team'), 8), ...pick(lessons.filter(l => l.dog === dog), 6)].map(l => [l.id, l]));
  return chosen.size ? `<lessons>\nFollow these; they come from earlier mistakes, QA and the human:\n${[...chosen.values()].map(l => `- ${l.text}`).join('\n')}\n</lessons>\n\n` : '';
}

function brainContext(text, limit = 8) {
  if (!brain.length) return 'The brain is empty. This is the team\'s first task in this project.';
  const words = new Set((text.toLowerCase().match(/[a-z0-9_]{3,}/g) || []));
  const scored = brain.filter(m => m.kind !== 'review').map(m => {
    const hay = `${m.title} ${m.note} ${(m.files || []).join(' ')}`.toLowerCase();
    let s = 0; for (const w of words) if (hay.includes(w)) s++;
    return { m, s };
  });
  const picked = new Map();
  scored.filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).forEach(x => picked.set(x.m.id, x.m));
  scored.slice(0, Math.ceil(limit / 2)).forEach(x => picked.set(x.m.id, x.m));
  return [...picked.values()].map(m =>
    `- [${m.type}${m.status ? ', ' + m.status : ''}] ${DOGS[m.dog]?.name ?? 'Claude'}: ${m.title} — ${m.note}${m.files?.length ? ` (files: ${m.files.join(', ')})` : ''} → .kennel/memories/${m.id}.md`).join('\n');
}

function planPrompt(task) {
  return `Break this request from the human into tickets for the team (software dogs and video cats). Don't do the work yourself. Only look at as much of the project as you need to plan well, and keep it quick.

Rules:
- As few tickets as possible (1 to 6). If one dog can do it all, make one ticket.
- Give each ticket to the best dog: harley (app code), asky (UI/UX design and styling, built in code), biscuit (documentation: READMEs, guides, API docs, changelogs), bacon (database), pitchie (tests), tiger (CI, deploy, infra), chou (decisions, reviews), lucifur (explanations and teaching notes; he can't change code); the video studio cats: seah (video editing, cuts, ffmpeg, delivery), yuki (motion graphics, Remotion animation, titles), shadow (color grading, VFX, green screen), snow (audio, music, loudness, captions/subtitles), goose (shorts/reels, thumbnails, platform exports).
- Tickets that touch the same files must be ordered with "after", not run in parallel.
- Don't add a ticket just to test or review the work; QA runs automatically at the end. Only give Pitchie a ticket if the human asked for tests.

Request:
${task.text}

Reply in exactly this format:
TYPE: Decision
SUMMARY: one sentence describing the plan
LESSON: none
TICKET 1: <dog> | <short title> | after: -
DETAIL 1: <exactly what to do, 1 to 4 sentences, with file paths if you know them>
TICKET 2: <dog> | <short title> | after: 1
DETAIL 2: ...
---
<the plan in a few lines of Markdown>`;
}

function reviewPrompt(task) {
  const jobs = task.items.map((it, i) => `### Job ${i + 1}: by ${DOGS[it.author].name}${it.round > 1 ? ` (fix attempt ${it.round - 1})` : ''}
Task: ${it.rootText}
Their report: ${it.report.slice(0, 2500)}
Files changed: ${it.files.length ? it.files.join(', ') : '(none recorded; check git status)'}`).join('\n\n');
  return `You're the QA gate. Check these finished jobs before they ship. Be strict but fair: fail a job only for real problems (bugs, broken tests or build, task not actually done, risky or destructive changes), never for style.

${jobs}

How to check, without wasting effort:
1. ${ACCESS === 'full' ? 'Run the project\'s checks (tests, typecheck, lint, build) ONCE for all jobs together, not once per job.' : 'You can\'t run commands, so check the logic by reading.'}
2. Read each job's changes${IS_GIT ? ' (git diff -- <files> is fastest)' : ''}.
3. Confirm each job does what its task asked and doesn't break anything nearby.
Do not edit any files.

Reply in exactly this format, one RESULT line per job:
TYPE: Review
SUMMARY: one sentence overall
${task.items.map((_, i) => `RESULT ${i + 1}: PASS   or   RESULT ${i + 1}: FAIL | <one-line reason>
LESSON ${i + 1}: <if FAIL, one short rule that dog should follow next time; otherwise none>`).join('\n')}
---
<findings per job: file:line, what's wrong, what you ran and the results>`;
}

/* ================================================================== events */
const sseClients = new Set();
const listeners = new Set();
// The last few hundred job events, so the office can rebuild each prompt's timeline after a reload.
const TRACKED = new Set(['queued', 'start', 'tool', 'diff', 'done', 'review', 'error', 'plan', 'triage-start', 'triage', 'undone', 'committed', 'merged', 'hold']);
// Kept on disk too, so the Tasks tab survives a restart.
const EVENTS_FILE = path.join(BRAIN_DIR, 'events.json');
const recentEvents = readJSON(EVENTS_FILE, []);
let eventsTimer = null;
function emit(ev) {
  if (TRACKED.has(ev.type)) {
    recentEvents.push({ ...ev, at: Date.now() }); if (recentEvents.length > 600) recentEvents.shift();
    clearTimeout(eventsTimer); eventsTimer = setTimeout(() => { try { fs.writeFileSync(EVENTS_FILE, JSON.stringify(recentEvents)); } catch { /* fine */ } }, 1500);
  }
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) res.write(line);
  for (const fn of listeners) fn(ev);
}

/* ================================================================== queue + orchestration */
const queues = Object.fromEntries(IDS.map(k => [k, []]));
const current = {};
const doneIds = new Set();
const failedIds = new Set();
const recentErrors = [];
let paused = false;
let qaTimer = null;
const rel = p => { if (!p) return ''; const r = path.relative(WORKDIR, path.resolve(WORKDIR, p)); return r.startsWith('..') ? p : r.replace(/\\/g, '/'); };
const short = s => (s.length > 140 ? s.slice(0, 137) + '…' : s);
const usedPct = () => limits?.unifiedWindows?.five_hour?.utilization ?? 0;

// kind: task | fix | review | plan
function enqueue(task, front = false) {
  task.id ||= rid(); task.t ||= Date.now(); task.kind ||= 'task'; task.round ||= 1; task.deps ||= [];
  task.rootText ||= task.text; task.rootTitle ||= task.title;
  if (task.kind !== 'review') clearTimeout(qaTimer);
  if (front) queues[task.dog].unshift(task); else queues[task.dog].push(task);
  backToDesk(task.dog);
  emit({ type: 'queued', dog: task.dog, task: { id: task.id, title: task.title, from: task.from, kind: task.kind, waitsFor: task.deps.length, brief: task.brief,
    parent: task.followOf || task.fixOf || task.planId || task.triage || null, follow: Boolean(task.followOf), targets: task.kind === 'review' ? task.items.map(i => i.memId) : undefined } });
  pumpAll();
  return task;
}

function assign(text, dogId, from = 'web', forcePlan = false, files = [], brief = '', triage = null, size = '', claims = []) {
  let full = files.length ? `${text}\n\nFiles to work with: ${files.join(', ')}` : text;
  if (brief) full += `\n\nNotes from the front desk (to save you exploring): ${brief}`;
  // The files this job will most likely edit, so it never runs at the same time as a job already in them.
  claims = [...new Set([...claims, ...files, ...filesIn(`${text} ${brief}`)])].slice(0, 10);
  const base = { title: short(text.replace(/\s+/g, ' ')), text: full, userText: text, from, brief, triage, size, claims };
  if (DOGS[dogId]) return enqueue({ dog: dogId, ...base });
  if (PLAN && (forcePlan || needsPlan(text))) {
    return enqueue({ ...base, dog: plannerFor(text), kind: 'plan', title: short(`Plan: ${base.title}`), rootTitle: base.title, claims: [] });
  }
  return enqueue({ dog: route(text), ...base });
}

// Project paths mentioned in a piece of text (full paths, or a file name that's unique in the project).
let fileCache = { t: 0, list: [], byName: new Map() };
function projectFiles() {
  if (Date.now() - fileCache.t > 15_000) {
    const list = listFiles(), byName = new Map();
    for (const f of list) { const b = f.split('/').pop(); byName.set(b, byName.has(b) ? null : f); }
    fileCache = { t: Date.now(), list, set: new Set(list), byName };
  }
  return fileCache;
}
function filesIn(text) {
  const { set, byName } = projectFiles();
  const found = new Set();
  for (const tok of String(text).match(/[\w@.\-/\\]+\.[a-z0-9]{1,6}\b/gi) || []) {
    const t = tok.replace(/\\/g, '/').replace(/^\.\//, '');
    if (set.has(t)) found.add(t);
    else if (!t.includes('/') && byName.get(t)) found.add(byName.get(t));
  }
  return [...found];
}

/* ------------------------------------------------------------------ the front desk (central dispatcher) */
// Every message from you lands in one inbox. Messages that arrive together (or while the desk is still
// deciding) are read in ONE call that also sees the live board: who's working on what, what's queued, and
// what just finished. So nothing gets done twice, a follow-up continues the session it belongs to instead
// of starting from zero, and related messages become one job.
const DESK_WINDOW_MS = 900;   // wait this long for more messages before deciding
const DESK_MAX_BATCH = 8;
const RECENT_MS = 3 * 3600_000;
const inbox = [];
let deskBusy = false, deskTimer = null;

const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
function liveBoard() {
  const now = Date.now();
  const running = IDS.filter(d => current[d] && current[d].kind !== 'review').map(d => {
    const cur = current[d], files = [...busyFiles(cur)].slice(0, 5);
    return `- [${cur.id}] ${DOGS[d].name} is ${cur.kind === 'plan' ? 'planning' : 'working on'}: "${cur.rootTitle || cur.title}" (${Math.round((now - cur.started) / 1000)}s in${files.length ? `; files: ${files.join(', ')}` : ''})`;
  });
  const queued = IDS.flatMap(d => queues[d].filter(t => t.kind !== 'review').map(t =>
    `- [${t.id}] ${DOGS[d].name}${t.kind === 'plan' ? ' will plan' : ''}: "${t.rootTitle || t.title}" (not started${t.deps.length ? ', waits for another job' : ''})`));
  const finished = brain.filter(m => isWork(m) && m.status !== 'undone' && now - m.t < RECENT_MS).slice(0, 6).map(m =>
    `- [${m.id}] ${DOGS[m.dog]?.name || m.dog}, ${ago(m.t)}${m.status ? `, ${m.status}` : ''}: "${m.rootTitle || m.title}". ${m.note}${m.files?.length ? ` (files: ${m.files.slice(0, 5).join(', ')})` : ''}`);
  return { running, queued, finished, busy: running.length + queued.length > 0 };
}

function triagePrompt(batch, board) {
  const team = 'chou (lead dev: planning, reviews, decisions), harley (app code), asky (UI/UX design and styling), biscuit (documentation), bacon (database), pitchie (tests/QA), tiger (CI, deploy, infra), lucifur (explains code; read-only); video studio cats: seah (lead video editor: cuts, pacing, ffmpeg, exports), yuki (motion graphics: Remotion animation, titles, intros), shadow (color grading, VFX, green screen), snow (audio mix, loudness, captions/subtitles), goose (shorts/reels, thumbnails, platform delivery)';
  const paths = projectFiles().list.filter(p => !DOC_FILE.test(p) || /readme/i.test(p)).slice(0, 150).join('\n');
  const msgs = batch.map((m, i) => `[${i + 1}]${m.dogId ? ` (addressed to ${m.dogId})` : ''}${m.files.length ? ` (files attached: ${m.files.join(', ')})` : ''}\n"""${m.text}"""`).join('\n\n');
  return `Team: ${team}.

BOARD (job ids in brackets)
Working now:
${board.running.join('\n') || '(nobody)'}
Queued, not started:
${board.queued.join('\n') || '(nothing)'}
Finished recently:
${board.finished.join('\n') || '(nothing yet)'}

Project files:
${paths || '(none)'}

${batch.length > 1 ? `${batch.length} MESSAGES arrived at about the same time` : 'MESSAGE'}:
${msgs}

Decide what happens to each message. Pick ONE action:
- "reply": greetings, thanks, small talk, or anything you can fully answer without reading the code (including "what's the team doing?", answered from the board). Put the answer in "reply": short, professional, same language as the message.
- "question": a question about this project's code that needs reading files but no changes. Set "dog" (lucifur for explanations, otherwise the addressed dog or the expert).
- "follow": the message continues, extends or refers back to a job on the board: "also…", "pati…", "tapos…", "yung kanina", "it/that", "now add tests for that", "make it blue instead". Set "job". The same dog continues in its own session and does not re-read the project, which is far cheaper than a new task. Use it whenever the message clearly builds on a board job (running or finished). If the follow-up needs a different specialist (e.g. tests for Harley's change → Pitchie), use "task" instead and mention the job in "brief".
- "fix": the message says a FINISHED job is wrong or broken ("mali", "di gumana", "still broken"). Set "job". The dog fixes it in its session and learns a lesson.
- "add": extra detail or a change of mind for a job that is QUEUED and not started. Set "job"; it is folded into that job.
- "same": asks for something that is already running or queued. Set "job" and a one-line "reply" saying who is on it. Nothing new starts.
- "task": new work: change, build, fix, test, document or deploy something.
- "plan": a big request with several separate parts that should be split into tickets.

Also:
- "with": if a message is part of the same work as an EARLIER message in this list, set "with" to that message's number and it is merged into it (e.g. [1] "add dark mode" + [2] "put the toggle in the navbar" → [2] with 1). Unrelated requests stay separate so different dogs work in parallel.
- "dog": for task, keep the addressed dog unless they clearly can't do it; otherwise the best expert.
- "files": for task, follow and fix: the project files the work will most likely edit, only from the list above, at most 6. The team uses this to keep two dogs out of the same file, so be accurate.
- "brief": for task, follow and plan: 1 to 3 sentences that make the job cheaper (where to look, what "done" means, related board jobs). Don't restate the message.
- "size": for task: "small" (one or two files, a few lines), "medium", or "large".

Return only JSON, one entry per message:
{"decisions":[{"n":1,"action":"reply|question|follow|fix|add|same|task|plan","job":"","with":0,"dog":"","reply":"","brief":"","size":"","files":[]}]}`;
}

function triageCall(batch) {
  const board = liveBoard();
  // A lone message with an idle pack is easy: the cheap model. Anything that needs judgment about the board: the stronger one.
  const model = batch.length > 1 || board.busy || board.finished.length ? DESK_MODEL : TRIAGE_MODEL;
  return new Promise(resolve => {
    const child = spawn(CLAUDE, ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--strict-mcp-config',
      '--disable-slash-commands', '--effort', 'low', '--model', model,
      '--system-prompt', 'You are the dispatcher at the front desk of a small software team. You see everything the team is doing and decide quickly what happens to each message from the lead engineer, so no work is duplicated, follow-ups continue the job they belong to, and tokens are not wasted. Output one JSON object and nothing else.'],
    { cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let outText = '';
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 60000);
    child.stdout.on('data', b => { outText += b; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(outText);
        if (r.is_error) return resolve(null);
        const m = String(r.result || '').match(/\{[\s\S]*\}/);
        const j = m ? JSON.parse(m[0]) : null;
        const u = r.usage || {};
        const spent = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        addUsage('lucifur', spent);
        let list = Array.isArray(j?.decisions) ? j.decisions : j?.action ? [{ n: 1, ...j }] : null;
        if (!list) return resolve(null);
        list = list.filter(x => x && ['reply', 'question', 'follow', 'fix', 'add', 'same', 'task', 'plan'].includes(x.action));
        resolve({ list, tokens: spent, model });
      } catch { resolve(null); }
    });
    child.stdin.end(triagePrompt(batch, board));
  });
}

// Every message from you goes through here. A leading "!" skips the front desk.
function frontDesk(text, dogId, from = 'web', forcePlan = false, files = []) {
  if (text.startsWith('!')) return Promise.resolve(assign(text.slice(1).trim(), dogId, from, forcePlan, files));
  if (!TRIAGE || !CLAUDE_VERSION || forcePlan) return Promise.resolve(assign(text, dogId, from, forcePlan, files));
  return new Promise(resolve => {
    const tid = rid();
    emit({ type: 'triage-start', tid, text: short(text), dog: DOGS[dogId] ? dogId : null, from });
    inbox.push({ tid, text, dogId: DOGS[dogId] ? dogId : null, from, files, resolve });
    scheduleDesk();
  });
}
function scheduleDesk() {
  if (deskBusy || deskTimer || !inbox.length) return;
  deskTimer = setTimeout(runDesk, DESK_WINDOW_MS);
}
async function runDesk() {
  deskTimer = null;
  if (deskBusy || !inbox.length) return;
  deskBusy = true;
  const batch = inbox.splice(0, DESK_MAX_BATCH);
  try {
    // An exact repeat of something already running or queued never reaches the model.
    const fresh = [];
    for (const m of batch) {
      const dup = sameAsActive(m.text);
      if (dup) settleDesk(m, { action: 'same', job: dup.id, dog: dup.dog, reply: `${DOGS[dup.dog].name} is already on that.` });
      else fresh.push(m);
    }
    if (fresh.length) {
      const r = await triageCall(fresh);
      if (!r) for (const m of fresh) { emit({ type: 'triage', tid: m.tid, action: 'task', dog: m.dogId, fallback: true }); m.resolve(assign(m.text, m.dogId, m.from, false, m.files, '', m.tid)); }
      else dispatch(fresh, r);
    }
  } catch (err) {
    for (const m of batch) if (!m.done) { emit({ type: 'triage', tid: m.tid, action: 'task', dog: m.dogId, fallback: true }); m.resolve(assign(m.text, m.dogId, m.from, false, m.files, '', m.tid)); }
    emit({ type: 'notice', text: `Front desk error: ${err.message}` });
  } finally {
    deskBusy = false;
    scheduleDesk();
  }
}

const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function sameAsActive(text) {
  const key = norm(text);
  if (key.length < 12) return null;
  for (const d of IDS) {
    for (const t of [current[d], ...queues[d]]) if (t && t.userText && norm(t.userText) === key) return t;
  }
  return null;
}

function dispatch(batch, r) {
  const byN = new Map(r.list.map(d => [Number(d.n), d]));
  const items = batch.map((m, i) => Object.assign(m, { d: byN.get(i + 1) || null }));
  items[0].tokens = r.tokens; items[0].model = r.model;
  // Messages that belong to the same work as an earlier one in this batch are merged into it (last first,
  // so a chain 3 → 2 → 1 ends up whole in 1).
  for (let i = items.length - 1; i > 0; i--) {
    const w = Number(items[i].d?.with);
    if (!(w >= 1 && w <= i)) continue;
    const host = items[w - 1];
    host.text += `\n\nAlso: ${items[i].text}`;
    host.files = [...new Set([...host.files, ...items[i].files])];
    if (host.d && items[i].d?.files) host.d.files = [...new Set([...(host.d.files || []), ...items[i].d.files])];
    items[i].into = host;
  }
  for (const it of items) {
    if (it.into) { settleDesk(it, { action: 'with', into: it.into.tid }); continue; }
    try { decide(it); } catch (err) { if (!it.done) { emit({ type: 'triage', tid: it.tid, action: 'task', dog: it.dogId, fallback: true }); it.resolve(assign(it.text, it.dogId, it.from, false, it.files, '', it.tid)); } }
  }
}

function settleDesk(it, ev, result = null) {
  it.done = true;
  emit({ type: 'triage', tid: it.tid, tokens: it.tokens, model: it.model, ...ev });
  it.resolve(result || { kind: ev.action, dog: ev.dog || null, id: ev.job || null });
}

function decide(it) {
  const { d, text, from, files, tid } = it;
  if (!d) { emit({ type: 'triage', tid, action: 'task', dog: it.dogId, fallback: true }); it.done = true; return it.resolve(assign(text, it.dogId, from, false, files, '', tid)); }
  const dog = it.dogId || (DOGS[d.dog] ? d.dog : null);
  const { set } = projectFiles();
  const claims = [...new Set([...(Array.isArray(d.files) ? d.files.map(String).filter(f => set.has(f)) : []), ...files])].slice(0, 8);
  const brief = String(d.brief || '').trim();
  const job = String(d.job || '').trim();

  if (d.action === 'reply' && d.reply) {
    // Answered at the desk: nobody starts a job. It's kept in Lucifur's chat so you can see it later.
    const thread = (chats.lucifur ||= { session: null, messages: [] });
    const you = { role: 'you', text, files, t: Date.now() }, reply = { role: 'dog', text: String(d.reply).trim(), t: Date.now(), desk: true };
    thread.messages.push(you, reply); saveChats();
    settleDesk(it, { action: 'reply', dog: 'lucifur', reply: reply.text }, { kind: 'reply', dog: 'lucifur', reply: reply.text });
    emit({ type: 'chat', dog: 'lucifur', message: you });
    emit({ type: 'chat-done', dog: 'lucifur', message: reply, totals: usage, quiet: true });
    return;
  }
  if (d.action === 'question') {
    const who = DOGS[d.dog] ? d.dog : dog || 'lucifur';
    settleDesk(it, { action: 'question', dog: who }, { kind: 'chat', dog: who });
    chat(who, text, files);
    return;
  }
  if (d.action === 'same' && (runningJob(job) || queuedJob(job))) {
    const t = runningJob(job) || queuedJob(job);
    return settleDesk(it, { action: 'same', job, dog: t.dog, reply: String(d.reply || `${DOGS[t.dog].name} is already on that.`).trim() });
  }
  if (d.action === 'add' || d.action === 'follow' || d.action === 'fix') {
    const finished = findMem(job);
    if (d.action === 'fix' && finished && isWork(finished) && !runningJob(job) && !queuedJob(job) && !activeFollowOf(job)) {
      const t = feedback(job, text, from);
      if (t) return settleDesk(it, { action: 'fix', job, dog: t.dog }, { id: t.id, dog: t.dog, kind: 'fix' });
    }
    const wasQueued = queuedJob(activeFollowOf(job) || job);
    const t = followUp(job, text, from, { claims, brief, triage: tid });
    if (t) {
      const action = wasQueued ? 'add' : 'follow';
      return settleDesk(it, { action, job: t.followOf || t.id, dog: t.dog, waits: Boolean(t.deps?.length), brief }, { id: t.id, dog: t.dog, kind: action });
    }
    // The job it pointed at is gone or can't be continued: treat it as new work.
  }
  const plan = d.action === 'plan';
  const size = ['small', 'medium', 'large'].includes(d.size) ? d.size : '';
  emit({ type: 'triage', tid, action: plan ? 'plan' : 'task', dog, brief, size, planner: plan ? plannerFor(text) : undefined, tokens: it.tokens, model: it.model });
  it.done = true;
  const task = assign(text, dog, from, plan, files, brief, tid, size, claims);
  it.resolve({ id: task.id, dog: task.dog, kind: task.kind });
}

function pumpAll() { for (const id of IDS) pump(id); }
function pump(dog) {
  if (paused || current[dog]) return;
  const q = queues[dog];
  for (let i = 0; i < q.length; i++) {
    const task = q[i];
    const broken = task.deps.find(d => failedIds.has(d));
    if (broken) {
      q.splice(i--, 1); failedIds.add(task.id);
      emit({ type: 'error', dog, id: task.id, message: `Skipped “${task.title}” because a ticket it depends on failed.` });
      continue;
    }
    if (!task.deps.every(d => doneIds.has(d))) continue;
    // Don't let two dogs edit the same files at once: wait for whoever is in them right now.
    const clash = fileClash(task);
    if (clash) {
      if (task.heldBy !== clash.dog) { task.heldBy = clash.dog; emit({ type: 'hold', dog, id: task.id, by: clash.dog, files: clash.files }); }
      continue;
    }
    q.splice(i, 1);
    start(task);
    return;
  }
}

// The files a running job is in (edited so far, plus what the desk expects it to touch).
const busyFiles = cur => new Set([...(cur.files || []), ...(cur.claims || [])]);
function fileClash(task) {
  if (!task.claims?.length || (task.kind !== 'task' && task.kind !== 'fix')) return null;
  for (const d of IDS) {
    const cur = current[d];
    if (!cur || d === task.dog || (cur.kind !== 'task' && cur.kind !== 'fix')) continue;
    const busy = busyFiles(cur);
    const files = task.claims.filter(f => busy.has(f));
    if (files.length) return { dog: d, files };
  }
  return null;
}

// What the rest of the pack is doing right now, so a dog works around its teammates instead of into them.
function teamNow(dog) {
  const rows = IDS.filter(d => d !== dog && current[d] && current[d].kind !== 'review').map(d => {
    const cur = current[d], files = [...busyFiles(cur)].slice(0, 6);
    return `- ${DOGS[d].name}: ${cur.rootTitle || cur.title}${files.length ? ` (files: ${files.join(', ')})` : ''}`;
  });
  return rows.length ? `<teammates_now>\nThese teammates are working in this folder right now. Don't edit their files; if your task truly needs one, do your part around it and say so in your report.\n${rows.join('\n')}\n</teammates_now>\n\n` : '';
}

// A follow-up continues the newest session in its job's chain (job → its fixes and follow-ups),
// so the dog remembers everything it already did instead of re-reading the project.
function latestInChain(id) {
  let best = findMem(id);
  for (let guard = 0; best && guard < 20; guard++) {
    const next = brain.find(m => (m.followOf === best.id || m.fixOf === best.id) && m.session && m.status !== 'undone');
    if (!next) break;
    best = next;
  }
  return best;
}

function start(task) {
  const { dog } = task;
  // Follow-ups are resolved now, not when they were queued: the job they build on may have just finished.
  if (task.followOf && task.followText != null) {
    const m = latestInChain(task.followOf);
    task.resume = m?.session || null;
    task.text = followPrompt(m, task.followText, task.rootTitle, task.brief);
  }
  if ((task.kind === 'task' || task.kind === 'fix') && !DOGS[dog].readOnly && ACCESS !== 'read-only') task.checkpoint = checkpoint();
  current[dog] = { ...task, chars: 0, out: '', files: new Set(), ranCmd: false, proc: null, started: Date.now(), action: 'Thinking…' };
  backToDesk(dog);
  emit({ type: 'start', dog, task: { id: task.id, title: task.title, kind: task.kind } });
  work(task)
    .then(() => doneIds.add(task.id))
    .catch(err => {
      failedIds.add(task.id);
      if (task.kind === 'review') for (const it of task.items) setStatus(findMem(it.memId), 'pending-qa');
      const message = err?.message || String(err);
      recentErrors.unshift({ t: Date.now(), dog, id: task.id, title: task.title, message }); recentErrors.length = Math.min(recentErrors.length, 20);
      emit({ type: 'error', dog, id: task.id, message });
    })
    .finally(() => { delete current[dog]; pumpAll(); scheduleQA(); });
}

/* ================================================================== idle activities */
// A dog with nothing to do walks to an office item and uses it; a new job sends it straight back to its desk.
// The server decides who is where, so the web office, the terminal and `kennel status` all show the same thing.
const ITEMS = {
  coffee: { name: 'coffee machine', verb: 'getting coffee', seats: 2, weight: 3, secs: [25, 50] },
  water: { name: 'water bowl', verb: 'drinking water', seats: 2, weight: 3, secs: [15, 30] },
  bed: { name: 'nap corner', verb: 'napping', seats: 2, weight: 2, secs: [60, 120] },
  ball: { name: 'ball', verb: 'playing ball', seats: 2, weight: 2, secs: [30, 60] },
  board: { name: 'ticket board', verb: 'reading the ticket board', seats: 1, weight: 2, secs: [15, 30] },
  // upstairs, for the cats
  cattree: { name: 'cat tree', verb: 'lounging on the cat tree', seats: 2, weight: 3, secs: [40, 90], cat: true },
  yarn: { name: 'yarn ball', verb: 'chasing the yarn', seats: 2, weight: 2, secs: [20, 45], cat: true },
  sunspot: { name: 'sunny spot', verb: 'napping in the sun', seats: 2, weight: 3, secs: [60, 140], cat: true },
  bowls: { name: 'fish bowls', verb: 'having a fish snack', seats: 2, weight: 2, secs: [15, 30], cat: true },
  couch: { name: 'screening couch', verb: 'watching the dailies', seats: 2, weight: 2, secs: [30, 70], cat: true },
};
const isCat = id => DOGS[id]?.animal === 'cat';
const HOMEBODIES = new Set(['lucifur']); // the mentor never leaves the lair
const activity = {}; // dog -> { item, seat, label, since, until }
const nextIdleAt = Object.fromEntries(IDS.map(id => [id, Date.now() + (10 + Math.random() * 50) * 1000]));
const lastItem = {};
const between = ([a, b]) => (a + Math.random() * (b - a)) * 1000;
const hasWork = dog => Boolean(current[dog] || chatting[dog] || queues[dog].length);
const openTickets = () => IDS.reduce((n, id) => n + (current[id] && current[id].kind !== 'review' ? 1 : 0) + queues[id].filter(t => t.kind !== 'review').length, 0);
const activityLabel = id => (activity[id] ? activity[id].label : '');

/** Send a dog back to its desk (it has work now) and let it rest a while before wandering again. */
function backToDesk(dog) {
  nextIdleAt[dog] = Date.now() + between([20, 45]);
  if (!activity[dog]) return;
  delete activity[dog];
  emit({ type: 'activity', dog, item: null });
}

function pickItem(dog) {
  const taken = {};
  for (const a of Object.values(activity)) taken[a.item] = (taken[a.item] || []).concat(a.seat);
  const free = Object.entries(ITEMS).filter(([k, it]) => Boolean(it.cat) === isCat(dog) && k !== lastItem[dog] && (taken[k] || []).length < it.seats);
  if (!free.length) return null;
  let r = Math.random() * free.reduce((s, [, it]) => s + it.weight, 0);
  const [item] = free.find(([, it]) => (r -= it.weight) < 0) || free[0];
  const seat = [...Array(ITEMS[item].seats).keys()].find(s => !(taken[item] || []).includes(s));
  return { item, seat };
}

function idleTick() {
  const now = Date.now();
  for (const dog of IDS) {
    if (HOMEBODIES.has(dog)) continue;
    if (hasWork(dog)) { backToDesk(dog); continue; }
    const a = activity[dog];
    if (a && now >= a.until) {
      delete activity[dog];
      nextIdleAt[dog] = now + between([20, 60]);
      emit({ type: 'activity', dog, item: null });
      continue;
    }
    if (a || paused || now < nextIdleAt[dog]) continue;
    const pick = pickItem(dog);
    if (!pick) { nextIdleAt[dog] = now + between([10, 20]); continue; } // every item is in use: stay at the desk
    const it = ITEMS[pick.item];
    const n = openTickets();
    const label = pick.item === 'board' ? (n ? `reading the ticket board (${n} open)` : 'checking the ticket board: all clear') : it.verb;
    activity[dog] = { ...pick, label, since: now, until: now + between(it.secs) };
    lastItem[dog] = pick.item;
    emit({ type: 'activity', dog, item: pick.item, seat: pick.seat, label });
  }
}
setInterval(idleTick, 4000).unref();

function stop(dog) {
  const cur = current[dog];
  if (!cur?.proc) return false;
  cur.stopped = true;
  cur.proc.kill();
  return true;
}

// QA runs once the pack has gone quiet, covering every change that still needs checking.
function busyWithWork() {
  return IDS.some(id => (current[id] && current[id].kind !== 'review') || queues[id].some(t => t.kind !== 'review'));
}
function scheduleQA() {
  if (!REVIEW) return;
  clearTimeout(qaTimer);
  if (busyWithWork() || !brain.some(m => m.status === 'pending-qa')) return;
  qaTimer = setTimeout(() => runQA(), QA_DELAY_MS);
}
function runQA(force = false) {
  if (!REVIEW || (!force && busyWithWork())) return 0;
  const pending = brain.filter(m => m.status === 'pending-qa');
  if (!pending.length) return 0;
  if (!force && usedPct() >= QA_OFF_AT) {
    for (const m of pending) setStatus(m, 'qa-skipped');
    emit({ type: 'notice', level: 'warn', text: `QA skipped to save your limit (5h limit at ${Math.round(usedPct() * 100)}%). Run /qa to check anyway.` });
    return 0;
  }
  const groups = {};
  for (const m of pending) {
    const reviewer = m.dog === 'pitchie' ? 'chou' : 'pitchie';
    (groups[reviewer] ||= []).push({
      memId: m.id, author: m.dog, round: m.round || 1, rootText: m.rootText || m.title, rootTitle: m.rootTitle || m.title,
      report: readOutput(m.id)?.split(/\n---\n/).slice(1).join('\n---\n') || m.note, files: m.files || [], session: m.session,
    });
    setStatus(m, 'checking');
  }
  for (const [reviewer, items] of Object.entries(groups)) {
    enqueue({
      dog: reviewer, kind: 'review', from: 'qa', items, model: QA_MODEL,
      title: items.length === 1 ? short(`QA: ${DOGS[items[0].author].name}'s “${items[0].rootTitle}”`) : `QA: ${items.length} jobs`,
      text: items.map(i => i.rootText).join('\n'),
    }, true);
  }
  return pending.length;
}

function describeTool(name, input = {}) {
  const f = rel(input.file_path || input.path || input.notebook_path);
  switch (name) {
    case 'Read': return { verb: 'Reading', what: f };
    case 'Edit': case 'MultiEdit': return { verb: 'Editing', what: f, wrote: true };
    case 'Write': return { verb: 'Writing', what: f, wrote: true };
    case 'Grep': return { verb: 'Searching for', what: input.pattern };
    case 'Glob': return { verb: 'Looking for', what: input.pattern };
    case 'Bash': case 'PowerShell': return {
      verb: 'Running', cmd: true,
      what: String(input.command || '').split('\n')[0].replace(/^\s*(cd|Set-Location)\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/i, '').slice(0, 90),
    };
    case 'WebFetch': case 'WebSearch': return { verb: 'Looking up', what: input.url || input.query };
    case 'Agent': case 'Task': return { verb: 'Delegating', what: input.description || '' };
    case 'Skill': return { verb: 'Using skill', what: String(input.skill || input.command || input.name || '').replace(/^kennel-[a-z]+:/, '') };
    default: return { verb: 'Using', what: name };
  }
}

// Our short replacement for Claude Code's system prompt: the environment plus the habits that keep turns few.
function leanRules() {
  const win = process.platform === 'win32';
  return `

Environment: project folder ${WORKDIR} on ${win ? 'Windows' : process.platform}.${win ? ' Use PowerShell syntax in the PowerShell tool and POSIX syntax in the Bash tool.' : ''}${IS_GIT ? ' It is a git repo.' : ''}

Work efficiently, every turn costs:
- Read a file before you edit it. When you need several files, ask for them together in one turn. Don't re-read files you already have.
- Find things with Glob and Grep, not shell commands like ls, cat or find.
- Never open the .kennel folder: it is the team's own notes, and everything relevant from it is already in your prompt.
- Make the smallest change that fully does the job. Use Edit for changes and Write only for new files.
- Run checks once, at the end, not after every edit.
- Keep the final report short: a few lines unless you're answering a question.`;
}

function work(task) {
  const { dog } = task;
  const cur = current[dog];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompts', 'none',
    '-n', `Kennel · ${DOGS[dog].name} · ${task.rootTitle}`.slice(0, 90)];
  // Your claude.ai connectors (Gmail, Drive, …) aren't needed for coding and cost tokens on every request.
  if (!USE_MCP) args.push('--strict-mcp-config');
  // Each dog gets only its own skills (a plugin built from GitHub skill repos); your personal skills and plugins stay out.
  const skilled = hasSkills(dog);
  if (skilled) args.push('--plugin-dir', pluginDir(dog), '--setting-sources', 'project,local');
  else args.push('--disable-slash-commands');
  const sk = skilled ? ',Skill' : '';
  // Opus does every job. The job's size sets the effort (small → low) and the prompt: only large jobs carry
  // Claude Code's full system prompt; everything else runs on a short one of ours (measured: 81k → ~30k tokens on the same fix).
  const size = task.kind === 'plan' || task.kind === 'review' ? 'medium' : (task.size || 'medium');
  const lean = size !== 'large';
  // Fixes continue the original session, so the dog doesn't have to re-read the project.
  if (task.resume) args.push('--resume', task.resume);
  else if (lean) args.push('--system-prompt', persona(dog, task.kind) + leanRules());
  else args.push('--exclude-dynamic-system-prompt-sections', '--append-system-prompt', persona(dog, task.kind));
  if (task.kind === 'plan' || DOGS[dog].readOnly || ACCESS === 'read-only') args.push('--permission-mode', 'default', '--tools', 'Read,Grep,Glob' + sk);
  else if (ACCESS === 'safe') args.push('--permission-mode', 'acceptEdits', '--tools', 'Read,Grep,Glob,Edit,Write' + sk);
  else args.push('--dangerously-skip-permissions', '--tools', 'Read,Grep,Glob,Edit,Write,Bash,PowerShell' + sk);
  const model = task.model || WORK_MODEL;
  if (model) args.push('--model', model);
  args.push('--effort', EFFORT || { plan: 'low', review: 'low' }[task.kind] || (size === 'small' ? 'low' : 'medium'));

  let prompt;
  if (task.kind === 'review') prompt = `${relevantLessons(dog, task.items.map(i => i.rootText).join(' '))}${reviewPrompt(task)}`;
  else if (task.kind === 'plan') prompt = `<team_brain>\n${brainContext(task.text)}\n</team_brain>\n\n${teamNow(dog)}${planPrompt(task)}`;
  else if (task.resume) prompt = `${teamNow(dog)}${task.text}`;
  else prompt = `${relevantLessons(dog, task.rootText)}<team_brain>\n${brainContext(task.rootText)}\n</team_brain>\n\n${teamNow(dog)}Task from the human:\n${task.text}`;

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { cwd: WORKDIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    cur.proc = child;
    let result = null, stderr = '', last = 0, usedModel = model;
    child.on('error', err => reject(new Error(`Couldn't start Claude Code (${err.message}). Is \`claude\` installed and logged in?`)));
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-2000); });
    child.stdin.end(prompt);

    readline.createInterface({ input: child.stdout }).on('line', line => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'system' && ev.subtype === 'init') usedModel = ev.model || usedModel;
      else if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
        const e = ev.event;
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          cur.out += e.delta.text; cur.chars += e.delta.text.length;
          cur.action = task.kind === 'review' ? 'Writing the QA report' : task.kind === 'plan' ? 'Writing the plan' : 'Writing';
          if (watching === dog) {
            const parts = ((watchBuf[dog] || '') + e.delta.text).split('\n');
            watchBuf[dog] = parts.pop();
            for (const p of parts) out(`     ${dim('│')} ${p}`);
          }
          const now = Date.now();
          if (now - last > 250) { last = now; emit({ type: 'delta', dog, id: task.id, chars: cur.chars, tail: cur.out.slice(-500) }); }
        }
      } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
        for (const b of ev.message?.content || []) {
          if (b.type !== 'tool_use') continue;
          const t = describeTool(b.name, b.input);
          if (t.wrote && t.what) cur.files.add(t.what);
          if (t.cmd) cur.ranCmd = true;
          if (['Edit', 'MultiEdit', 'Write'].includes(b.name)) emitDiff(dog, task.id, b.name, b.input || {});
          cur.action = t.cmd ? `Running ${c(SKY, '$')} ${t.what}` : `${t.verb} ${t.what || ''}`.trim();
          cur.out += `\n[${t.verb} ${t.what}]\n`;
          emit({ type: 'tool', dog, id: task.id, verb: t.verb, what: t.what, wrote: !!t.wrote, cmd: !!t.cmd });
        }
      } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
        limits = ev.rate_limit_info;
        emit({ type: 'limits', limits });
        if (!paused && usedPct() >= PAUSE_AT) {
          paused = true; pausedBy = 'limit';
          emit({ type: 'paused', text: `5h limit at ${Math.round(usedPct() * 100)}%. New work waits until it resets${limits.resetsAt ? ` (${new Date(limits.resetsAt * 1000).toLocaleTimeString()})` : ''}. Type /resume to go anyway.` });
        }
      } else if (ev.type === 'result') result = ev;
    });

    child.on('close', code => {
      if (cur.stopped) return reject(new Error('Stopped.'));
      if (!result) return reject(new Error(`Claude Code exited (code ${code}). ${stderr.trim().split('\n').slice(-2).join(' ') || 'No output.'}`));
      if (result.is_error) {
        const msg = String(result.result || result.subtype || 'Claude Code reported an error');
        if (/not logged in|\/login|authentication|oauth/i.test(msg)) return reject(new Error('Claude Code isn\'t logged in on this computer. Open a terminal, run `claude`, type /login, then try again.'));
        if (/usage limit|rate limit|limit reached/i.test(msg)) return reject(new Error('Your Claude usage limit is reached. The pack will be able to continue after it resets.'));
        return reject(new Error(msg.slice(0, 300)));
      }
      try { resolve(finish(task, result, usedModel)); } catch (e) { reject(e); }
    });
  });
}

/* ================================================================== finishing a job */
function field(text, key) { return text.match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'))?.[1]?.trim(); }
function parseReply(text, types) {
  const sep = text.search(/^---\s*$/m);
  const output = (sep >= 0 ? text.slice(sep).replace(/^---\s*\n?/, '') : text).trim();
  const typeRaw = field(text, 'TYPE');
  return {
    type: types.find(t => t.toLowerCase() === typeRaw?.toLowerCase()) || types[0],
    note: (field(text, 'SUMMARY') || output.replace(/[#*`>\-]/g, '').trim().slice(0, 160)).trim(),
    lesson: field(text, 'LESSON'),
    output,
  };
}

// Paths where a mistake is expensive: these always get a QA check in smart mode.
const SENSITIVE = /(^|\/)(migrations?|auth|security|payments?|billing|checkout|\.github\/workflows|infra|terraform|k8s|helm)(\/|$)|\.(sql|tf)$|(^|\/)(package\.json|Dockerfile|docker-compose[^/]*|\.env[^/]*)$/i;
function qaReason(task, files, cur) {
  if (REVIEW_MODE === 'always') return 'always on';
  if (task.kind === 'fix' && task.from === 'qa') return 're-check after a failed QA';
  const code = files.filter(x => !DOC_FILE.test(x));
  if (!code.length) return null;
  const risky = code.find(x => SENSITIVE.test(x));
  if (risky) return `touches ${risky}`;
  const lines = cur.lines || 0;
  if (lines > 150 || code.length > 5) return `big change (${lines} lines, ${code.length} files)`;
  if (!cur.ranCmd && lines > 40) return 'not tested by the dog';
  return null;
}

function smallTestedChange(files, ranCmd) {
  if (!IS_GIT || !ranCmd || !files.length) return false;
  const r = spawnSync('git', ['diff', '--numstat', 'HEAD', '--', ...files], { cwd: WORKDIR, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return false;
  const rows = r.stdout.trim().split('\n').filter(Boolean);
  if (rows.length < files.length) return false; // a brand-new file isn't "small"
  const lines = rows.reduce((a, row) => { const [ad, de] = row.split('\t'); return a + (Number(ad) || 0) + (Number(de) || 0); }, 0);
  return lines <= SMALL_DIFF_LINES;
}

function finish(task, result, model) {
  const { dog } = task;
  const d = DOGS[dog];
  const cur = current[dog];
  const text = String(result.result || cur.out || '');
  const r = parseReply(text, task.kind === 'review' ? ['Review'] : task.kind === 'plan' ? ['Decision'] : d.types);
  const u = result.usage || {};
  const tokens = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const files = [...cur.files];
  const usedModel = Object.keys(result.modelUsage || {})[0] || model || 'claude';

  const mem = {
    id: task.id, dog, type: r.type, title: task.title, note: r.note, t: Date.now(), you: task.from !== 'qa',
    kind: task.kind, round: task.round, rootText: task.rootText, rootTitle: task.rootTitle, fixOf: task.fixOf,
    tokens, files, model: usedModel, turns: result.num_turns, session: result.session_id, checkpoint: task.checkpoint || null, followOf: task.followOf,
  };

  // Decide whether this needs QA.
  if (task.kind === 'task' || task.kind === 'fix') {
    const changed = files.length > 0 || cur.ranCmd;
    const why = REVIEW && changed ? qaReason(task, files, cur) : null;
    if (why) { mem.status = 'pending-qa'; mem.qaWhy = why; }
    else if (files.length) mem.status = 'self-checked';
  }

  const header = task.kind === 'review' ? `QA of ${task.items.length} job(s)` : task.text;
  fs.writeFileSync(memPath(task.id),
    `# ${task.title}\n\n_${d.name} (${d.role}) · ${r.type} · ${new Date(mem.t).toLocaleString()} · ${usedModel}_\n\n> ${r.note}\n\n**Task:** ${header}\n${files.length ? `\n**Files changed:** ${files.map(f => `\`${f}\``).join(', ')}\n` : ''}\n---\n\n${r.output}\n`);
  brain.unshift(mem); saveBrain();
  usage.cost += Number(result.total_cost_usd) || 0; usage.tasks += 1; addUsage(dog, tokens);

  if (task.kind === 'review') finishReview(task, mem, text, r);
  emit({ type: 'done', dog, id: task.id, mem, totals: usage, limits, report: task.kind === 'review' ? undefined : r.output.slice(0, 8000) });
  if (task.kind === 'task' || task.kind === 'fix') {
    addLesson(dog, r.lesson, 'self');
    if (task.fixOf) setStatus(findMem(task.fixOf), 'fixing');
  }
  if (task.kind === 'plan') finishPlan(task, text);
}

function finishPlan(task, text) {
  const rows = [...text.matchAll(/^TICKET\s*(\d+)\s*:\s*([A-Za-z]+)\s*\|\s*(.+?)\s*\|\s*after\s*:\s*(.*)$/gmi)];
  if (!rows.length) { // planner didn't give tickets: just do it directly
    enqueue({ dog: route(task.text), title: task.rootTitle, text: task.text, from: task.from });
    return;
  }
  const ids = Object.fromEntries(rows.map(m => [m[1], rid()]));
  const tickets = rows.map(m => {
    const n = m[1];
    const dog = DOGS[m[2].toLowerCase()] ? m[2].toLowerCase() : route(m[3]);
    const detail = field(text, `DETAIL\\s*${n}`) || m[3];
    const deps = (m[4].match(/\d+/g) || []).filter(x => ids[x] && x !== n).map(x => ids[x]);
    return { id: ids[n], n, dog, title: short(m[3]), detail, deps };
  });
  emit({ type: 'plan', dog: task.dog, request: task.rootTitle, plan: task.id, tickets: tickets.map(t => ({ id: t.id, n: t.n, dog: t.dog, title: t.title, after: t.deps.map(id => tickets.find(x => x.id === id)?.n) })) });
  for (const t of tickets) {
    enqueue({
      id: t.id, dog: t.dog, title: t.title, deps: t.deps, from: task.from, planId: task.id, claims: filesIn(t.detail),
      text: `${t.detail}\n\n(This is ticket ${t.n} of ${tickets.length} in Chou's plan for the human's request: “${task.text}”. Other tickets: ${tickets.filter(x => x !== t).map(x => `#${x.n} ${DOGS[x.dog].name}: ${x.title}`).join('; ') || 'none'}. Do only your ticket.)`,
      rootText: `${t.title}: ${t.detail}`, rootTitle: t.title,
    });
  }
}

function finishReview(task, mem, text, r) {
  let allPass = true;
  task.items.forEach((it, i) => {
    const n = i + 1;
    const m = text.match(new RegExp(`^RESULT[ \\t]*${n}[ \\t]*:[ \\t]*(PASS|FAIL)\\b[ \\t]*[|:—–-]?[ \\t]*(.*)$`, 'mi'));
    const verdict = m ? m[1].toUpperCase() : 'UNCLEAR';
    const reason = (m?.[2] || '').trim();
    const target = findMem(it.memId);
    if (verdict === 'PASS') {
      setChainStatus(target, 'verified', { reviewedBy: task.dog });
      emit({ type: 'review', reviewer: task.dog, author: it.author, verdict, target: it.memId, note: reason || 'looks good' });
      return;
    }
    allPass = false;
    if (verdict === 'UNCLEAR') {
      setChainStatus(target, 'needs-you', { reviewedBy: task.dog });
      emit({ type: 'review', reviewer: task.dog, author: it.author, verdict: 'FAIL', target: it.memId, gaveUp: true, note: 'QA gave no clear verdict for this job' });
      return;
    }
    addLesson(it.author, field(text, `LESSON\\s*${n}`) || reason, 'review');
    if (it.round <= MAX_FIX_ROUNDS) {
      setStatus(target, 'fixing', { reviewedBy: task.dog });
      enqueue({
        dog: it.author, kind: 'fix', from: 'qa', round: it.round + 1, fixOf: it.memId, resume: it.session,
        rootText: it.rootText, rootTitle: it.rootTitle, title: short(`Fix: ${it.rootTitle}`),
        text: `QA (${DOGS[task.dog].name}) failed your work${it.session ? '' : ` on: ${it.rootText}`}.\nReason: ${reason}\n\nFull QA findings (your work is Job ${n}):\n${r.output.slice(0, 5000)}\n\nFix the real issues, re-run the relevant checks, and reply in the TYPE / SUMMARY / LESSON / --- format.`,
      }, true);
      emit({ type: 'review', reviewer: task.dog, author: it.author, verdict, target: it.memId, note: reason });
    } else {
      setChainStatus(target, 'needs-you', { reviewedBy: task.dog });
      emit({ type: 'review', reviewer: task.dog, author: it.author, verdict, target: it.memId, gaveUp: true, note: reason });
    }
  });
  mem.verdict = allPass ? 'PASS' : 'FAIL';
  mem.targets = task.items.map(i => i.memId);
  saveBrain();
}

function feedback(memId, text, from = 'web') {
  const mem = findMem(memId);
  if (!mem || !text.trim() || !DOGS[mem.dog]) return null;
  addLesson(mem.dog, text, 'you');
  setStatus(mem, 'fixing');
  const root = mem.rootTitle || mem.title;
  return enqueue({
    dog: mem.dog, kind: 'fix', from, fixOf: mem.id, resume: latestInChain(mem.id)?.session || mem.session, round: 1, rootTitle: root, rootText: mem.rootText || root, claims: mem.files || [],
    title: short(`Fix: ${root}`),
    text: `The human says your work on “${root}” is wrong:\n${text}\n\n${mem.session ? '' : `Your earlier report is in .kennel/memories/${mem.id}.md. `}Fix it, verify it, and reply in the TYPE / SUMMARY / LESSON / --- format.`,
  }, true);
}

/* ================================================================== live code changes */
const recentDiffs = [];
function emitDiff(dog, taskId, tool, input) {
  const cut = (s, n) => { const ls = String(s ?? '').split('\n'); return ls.length > n ? [...ls.slice(0, n), `… ${ls.length - n} more lines`] : ls; };
  let hunks;
  if (tool === 'Write') hunks = [{ minus: [], plus: cut(input.content, 80) }];
  else if (tool === 'Edit') hunks = [{ minus: cut(input.old_string, 40), plus: cut(input.new_string, 40) }];
  else hunks = (input.edits || []).slice(0, 8).map(e => ({ minus: cut(e.old_string, 20), plus: cut(e.new_string, 20) }));
  const count = k => hunks.reduce((a, h) => a + h[k].filter(l => !l.startsWith('… ')).length, 0);
  if (current[dog]) current[dog].lines = (current[dog].lines || 0) + count('plus') + count('minus');
  const d = { type: 'diff', id: rid(), task: taskId, dog, file: rel(input.file_path || ''), kind: tool === 'Write' ? 'write' : 'edit', hunks, added: count('plus'), removed: count('minus'), t: Date.now() };
  recentDiffs.unshift(d);
  if (recentDiffs.length > 150) recentDiffs.pop();
  emit(d);
}

/* ================================================================== project files (for the office's file panel) */
const SKIP_DIRS = new Set(['node_modules', '.git', '.kennel', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', 'out', 'coverage', '.cache', '.turbo', 'vendor', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode', '.expo', 'Pods', '.gradle']);
function listFiles() {
  if (IS_GIT) {
    const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: WORKDIR, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) return [...new Set(r.stdout.split('\0').filter(f => f && !f.startsWith('.kennel/')))].slice(0, 10000);
  }
  const files = [];
  const walk = (dir, prefix) => {
    if (files.length >= 10000) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), `${prefix}${e.name}/`); }
      else if (e.isFile()) files.push(prefix + e.name);
    }
  };
  walk(WORKDIR, '');
  return files;
}
function readProjectFile(p) {
  const full = path.resolve(WORKDIR, p);
  if (!full.startsWith(WORKDIR + path.sep)) return { error: 'Outside the project' };
  let st; try { st = fs.statSync(full); } catch { return { error: 'Not found' }; }
  if (!st.isFile()) return { error: 'Not a file' };
  if (st.size > 600_000) return { path: p, tooBig: true, size: st.size };
  const buf = fs.readFileSync(full);
  if (buf.subarray(0, 8000).includes(0)) return { path: p, binary: true, size: st.size };
  return { path: p, size: st.size, content: buf.toString('utf8') };
}

/* ================================================================== chat with a dog */
const CHAT_MODEL = opt('--chat-model', process.env.KENNEL_CHAT_MODEL || 'haiku');
const CHAT_EFFORT = process.env.KENNEL_CHAT_EFFORT || 'low';
const CHATS_FILE = path.join(BRAIN_DIR, 'chats.json');
const chats = readJSON(CHATS_FILE, {}); // dog -> { session, messages: [{ role: you|dog, text, files, t }] }
if (chats.coco && !chats.asky) { chats.asky = chats.coco; delete chats.coco; }
const saveChats = () => fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2));
const chatting = {}; // dog -> { started, action, out, proc }
const chatWaiting = {}; // dog -> [{ text, files }]: questions that arrived while the dog was still answering
// Questions that pile up while a dog is answering go out together as one message when it's free.
function nextChat(dog) {
  const q = chatWaiting[dog];
  if (!q?.length || chatting[dog]) return;
  const batch = q.splice(0);
  chat(dog, batch.map(x => x.text).join('\n\n'), [...new Set(batch.flatMap(x => x.files))]);
}

function chatPersona(id) {
  const d = DOGS[id];
  const team = IDS.map(k => `${DOGS[k].name} (${DOGS[k].role})`).join(', ');
  const ls = [...lessons.filter(l => l.dog === 'team').slice(0, 20), ...lessons.filter(l => l.dog === id).slice(0, 10)];
  return `You are ${d.name}, the ${d.role} on a software team (${team}). You are answering a question from the engineer who leads the team, about the project in the current folder.

Your area: ${d.job}

How to answer:
- Professional and direct, like a senior colleague in a work chat. No role-play, no jokes, no catchphrases, no emojis, no greetings or sign-offs.
- Always reply in the same language as the engineer's latest message: English gets English, Tagalog gets Tagalog, Taglish gets Taglish, and any other language gets that language. Don't switch languages on your own. Code, file names and technical terms stay as they are.
- Lead with the answer. Then only the explanation that's needed: a few sentences or a short list. Cite files as path:line. Show code only when it clarifies.
- Look at the code (Read, Grep, Glob) only when the question depends on it, and read just what you need.
- You can't change anything from chat. If something should be changed, say what you'd change and that it can be sent as a task.
- If you're not sure, say so instead of guessing.
${ls.length ? `\nTeam conventions to respect:\n${ls.map(l => `- ${l.text}`).join('\n')}\n` : ''}`;
}

function chat(dog, text, files = []) {
  if (!DOGS[dog]) return { error: 'Unknown dog' };
  if (chatting[dog]) {
    (chatWaiting[dog] ||= []).push({ text, files });
    emit({ type: 'notice', level: 'info', text: `${DOGS[dog].name} is still answering; your next question goes right after.` });
    return { ok: true, queued: true };
  }
  const thread = (chats[dog] ||= { session: null, messages: [] });
  const msg = { role: 'you', text, files, t: Date.now() };
  thread.messages.push(msg); saveChats();
  emit({ type: 'chat', dog, message: msg });

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompts', 'none',
    '--permission-mode', 'default', '--tools', 'Read,Grep,Glob', '-n', `Kennel chat · ${DOGS[dog].name}`,
    // Lean on purpose: our own short system prompt instead of Claude Code's large default one, no MCP servers,
    // no skills list and low effort. Measured at about a third of the tokens per message.
    '--strict-mcp-config', '--disable-slash-commands', '--effort', CHAT_EFFORT];
  if (thread.session) args.push('--resume', thread.session); else args.push('--system-prompt', chatPersona(dog));
  if (CHAT_MODEL) args.push('--model', CHAT_MODEL);
  const prompt = `${thread.session ? '' : `<team_brain>\n${brainContext(text, 5)}\n</team_brain>\n\n`}${text}${files.length ? `\n\n(Files attached: ${files.join(', ')})` : ''}`;

  const st = (chatting[dog] = { started: Date.now(), action: 'Thinking…', out: '', proc: null });
  backToDesk(dog);
  emit({ type: 'chat-start', dog });
  const child = spawn(CLAUDE, args, { cwd: WORKDIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  st.proc = child;
  let result = null, last = 0, stderr = '';
  const fail = message => { delete chatting[dog]; emit({ type: 'chat-error', dog, message }); nextChat(dog); };
  child.on('error', err => fail(`Couldn't start Claude Code (${err.message}).`));
  child.stderr.on('data', b => { stderr = (stderr + b).slice(-1500); });
  child.stdin.end(prompt);
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
      const e = ev.event;
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        st.out += e.delta.text; st.action = 'Typing…';
        const now = Date.now();
        if (now - last > 150) { last = now; emit({ type: 'chat-delta', dog, text: st.out }); }
      }
    } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
      for (const b of ev.message?.content || []) {
        if (b.type !== 'tool_use') continue;
        const t = describeTool(b.name, b.input);
        st.action = `${t.verb} ${t.what || ''}`.trim();
        emit({ type: 'chat-tool', dog, action: st.action });
      }
    } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) { limits = ev.rate_limit_info; emit({ type: 'limits', limits }); }
    else if (ev.type === 'result') result = ev;
  });
  child.on('close', () => {
    if (!result) return fail(`Claude Code stopped without an answer. ${stderr.trim().split('\n').pop() || ''}`);
    if (result.is_error) {
      if (thread.session) { thread.session = null; saveChats(); } // a broken session: start fresh next time
      return fail(String(result.result || 'Claude Code reported an error').slice(0, 300));
    }
    delete chatting[dog];
    thread.session = result.session_id || thread.session;
    const reply = { role: 'dog', text: String(result.result || st.out).trim(), t: Date.now() };
    thread.messages.push(reply);
    if (thread.messages.length > 200) thread.messages.splice(0, thread.messages.length - 200);
    saveChats();
    const u = result.usage || {};
    addUsage(dog, (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
    saveUsage();
    emit({ type: 'chat-done', dog, message: reply, totals: usage });
    nextChat(dog);
  });
  return { ok: true };
}

/* ================================================================== usage, budget, undo, follow-ups, commits */
const today = () => new Date().toLocaleDateString('en-CA');
let pausedBy = '';
function addUsage(dog, tokens) {
  if (!tokens) return;
  usage.tokens += tokens;
  (usage.days ||= {})[today()] = (usage.days[today()] || 0) + tokens;
  (usage.byDog ||= {})[dog] = (usage.byDog[dog] || 0) + tokens;
  const keep = Object.keys(usage.days).sort().slice(-30); usage.days = Object.fromEntries(keep.map(k => [k, usage.days[k]]));
  saveUsage();
  emit({ type: 'usage', usage: usageSummary() });
  if (!paused && overBudget()) {
    paused = true; pausedBy = 'budget';
    emit({ type: 'paused', text: `Today's budget of ${usage.budget.toLocaleString()} tokens is used up. New work waits until tomorrow, or raise the budget.` });
  }
}
const overBudget = () => Boolean(usage.budget) && (usage.days?.[today()] || 0) >= usage.budget;
function usageSummary() {
  const days = Object.entries(usage.days || {}).sort().slice(-7).map(([day, tokens]) => ({ day, tokens }));
  return { today: usage.days?.[today()] || 0, budget: usage.budget || 0, total: usage.tokens, byDog: usage.byDog || {}, days, limits };
}
function setBudget(n) {
  usage.budget = Math.max(0, Math.round(Number(n) || 0)); saveUsage();
  if (paused && pausedBy === 'budget' && !overBudget()) { paused = false; pausedBy = ''; emit({ type: 'resumed' }); pumpAll(); }
  else if (!paused && overBudget()) {
    paused = true; pausedBy = 'budget';
    emit({ type: 'paused', text: `Today's budget of ${usage.budget.toLocaleString()} tokens is already used up. New work waits until tomorrow, or raise the budget.` });
  }
  emit({ type: 'usage', usage: usageSummary() });
  return usage.budget;
}

// Before a job touches anything, remember how the files looked, so you can undo just that job.
function checkpoint() {
  if (!IS_GIT) return null;
  const sha = git('stash', 'create') || git('rev-parse', 'HEAD');
  if (!sha) return null;
  return { sha, untracked: git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean) };
}
function undoJob(id) {
  const m = findMem(id);
  if (!m) return { error: 'Job not found.' };
  if (!m.files?.length) return { error: 'That job didn\'t change any files.' };
  if (!m.checkpoint) return { error: IS_GIT ? 'No checkpoint was saved for that job.' : 'Undo needs git. Run git init and commit in this project.' };
  const restored = [], removed = [];
  for (const file of m.files) {
    if (path.isAbsolute(file) || file.startsWith('..')) continue;
    const existed = spawnSync('git', ['cat-file', '-e', `${m.checkpoint.sha}:${file}`], { cwd: WORKDIR, windowsHide: true }).status === 0;
    if (existed) { spawnSync('git', ['restore', `--source=${m.checkpoint.sha}`, '--worktree', '--', file], { cwd: WORKDIR, windowsHide: true }); restored.push(file); }
    else if (!m.checkpoint.untracked.includes(file)) { try { fs.rmSync(path.join(WORKDIR, file)); removed.push(file); } catch { /* already gone */ } }
  }
  setStatus(m, 'undone');
  emit({ type: 'undone', id, dog: m.dog, title: m.title, restored, removed });
  return { restored, removed };
}

const isWork = t => t && (t.kind === 'task' || t.kind === 'fix');
const runningJob = id => IDS.map(d => current[d]).find(cur => cur?.id === id) || null;
const queuedJob = id => { for (const d of IDS) { const t = queues[d].find(x => x.id === id); if (t) return t; } return null; };
// A follow-up that's already queued or running on this job's chain (so a second follow-up joins it).
function activeFollowOf(id) {
  const all = [...IDS.map(d => current[d]).filter(Boolean), ...IDS.flatMap(d => queues[d])];
  for (let cur = id, guard = 0; guard < 10; guard++) {
    const next = all.find(t => isWork(t) && (t.followOf === cur || t.fixOf === cur));
    if (!next) return cur === id ? null : cur;
    cur = next.id;
  }
  return null;
}

function followPrompt(m, text, root, brief) {
  const notes = brief ? `\n\nNotes from the front desk: ${brief}` : '';
  return m?.session
    ? `Follow-up from the human on this same job:\n${text}${notes}\n\nThe files may have changed since your last turn (teammates work here too), so re-read anything before you edit it. Reply in the TYPE / SUMMARY / LESSON / --- format when you're done.`
    : `Follow-up on “${root}”${m ? ` (your earlier report is in .kennel/memories/${m.id}.md)` : ''}:\n${text}${notes}`;
}

// Fold more instructions into a job that hasn't started yet: no extra job, no extra tokens.
function addToQueued(task, text, files = []) {
  if (task.followText != null) task.followText += `\n\nAlso: ${text}`;
  else task.text += `\n\nMore from the human (added before you started):\n${text}${files.length ? `\nFiles: ${files.join(', ')}` : ''}`;
  task.rootText += `\n${text}`;
  task.claims = [...new Set([...(task.claims || []), ...files])];
  emit({ type: 'merged', id: task.id, dog: task.dog, text: short(text) });
  return task;
}

// Ask the same dog for more on a job. Finished: it continues in the same session right away. Running: it
// waits for that run and then continues its session. Not started yet: the request is folded into it.
function followUp(id, text, from = 'web', extra = {}) {
  const chained = activeFollowOf(id);
  if (chained) id = chained;
  const queued = queuedJob(id);
  if (queued) return isWork(queued) || queued.kind === 'plan' ? addToQueued(queued, text, extra.claims) : null;
  const run = runningJob(id);
  if (run && !isWork(run)) return null;
  const src = run || findMem(id);
  if (!src || !DOGS[src.dog] || (!run && src.kind !== 'task' && src.kind !== 'fix')) return null;
  const root = src.rootTitle || src.title;
  return enqueue({
    dog: src.dog, kind: 'task', from, followOf: id, followText: text, deps: run ? [id] : [], size: 'medium',
    rootText: `${src.rootText || root}\nFollow-up: ${text}`, rootTitle: root, title: short(`Follow-up: ${text}`), text: text,
    claims: [...new Set([...(extra.claims || []), ...(src.files ? [...src.files] : [])])].slice(0, 10), brief: extra.brief || '', triage: extra.triage || null,
  }, !run);
}

// Commit exactly the files a job changed, with a message in the team's own style.
async function commitJob(id) {
  const m = findMem(id);
  if (!m) return { error: 'Job not found.' };
  if (!IS_GIT) return { error: 'Not a git repo.' };
  const files = (m.files || []).filter(x => !path.isAbsolute(x) && !x.startsWith('..'));
  if (!files.length) return { error: 'That job didn\'t change any files.' };
  const diff = (git('diff', 'HEAD', '--', ...files) || '').slice(0, 12000);
  const rules = lessons.filter(l => l.source === 'git' || /commit/i.test(l.text)).slice(0, 8).map(l => `- ${l.text}`).join('\n');
  const msg = (await quickClaude(`Write a git commit message for this change.
${rules ? `Follow the team's git rules:\n${rules}\n` : 'Use a short imperative subject line.'}
What the change was for: ${m.title}. Summary: ${m.note}
Files: ${files.join(', ')}

Diff (may be cut short):
${diff}

Output only the commit message: a subject line of at most 72 characters, then optionally a blank line and a short body. No co-author trailers and no "Generated with" lines.`, 'You write concise, accurate git commit messages. Output only the message.'))?.trim().replace(/^```\w*\n?|\n?```$/g, '').trim();
  if (!msg) return { error: 'Couldn\'t write a commit message right now.' };
  spawnSync('git', ['add', '-A', '--', ...files], { cwd: WORKDIR, windowsHide: true });
  const r = spawnSync('git', ['commit', '-m', msg, '--', ...files], { cwd: WORKDIR, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return { error: (r.stderr || r.stdout || 'git commit failed').trim().split('\n').pop() };
  const sha = git('rev-parse', '--short', 'HEAD');
  setStatus(m, m.status, { commit: sha });
  emit({ type: 'committed', id, dog: m.dog, sha, message: msg });
  return { sha, message: msg };
}

function cancelQueued(id) {
  for (const dog of IDS) {
    const i = queues[dog].findIndex(t => t.id === id);
    if (i >= 0) { const [t] = queues[dog].splice(i, 1); failedIds.add(t.id); emit({ type: 'error', dog, id: t.id, message: 'Cancelled by you.' }); return true; }
  }
  return false;
}
function stopTask(id) { const dog = IDS.find(d => current[d]?.id === id); return dog ? stop(dog) : cancelQueued(id); }

// Resume automatically when the 5h window resets.
setInterval(() => {
  if (paused && pausedBy === 'budget' && !overBudget()) { paused = false; pausedBy = ''; emit({ type: 'resumed' }); pumpAll(); }
  if (paused && pausedBy !== 'budget' && limits?.resetsAt && Date.now() > limits.resetsAt * 1000) { paused = false; emit({ type: 'resumed' }); pumpAll(); }
}, 60_000).unref();

/* ================================================================== http */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function readBody(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 100_000) break; }
  try { return JSON.parse(body); } catch { return null; }
}

// Remote mode: a second listener on your network, guarded by a token (scanned once, then kept as a cookie).
const REMOTE_TOKEN = newToken();
let remoteServer = null, remoteUrl = '';
function remoteAuthorized(req, res, url) {
  if (url.searchParams.get('k') === REMOTE_TOKEN) {
    res.writeHead(302, { 'set-cookie': `kennel_k=${REMOTE_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`, location: '/' });
    res.end();
    return false;
  }
  if ((req.headers.cookie || '').split(/;\s*/).includes(`kennel_k=${REMOTE_TOKEN}`)) return true;
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<body style="background:#17131e;color:#f1e7d6;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><p>Kennel HQ: scan the QR code in your terminal to get in.</p></body>');
  return false;
}
function startRemote(cb) {
  if (remoteServer) return cb?.(null);
  const port = PORT + 1;
  remoteServer = http.createServer((req, res) => handle(req, res, true));
  remoteServer.on('error', err => { remoteServer = null; cb?.(err); });
  remoteServer.listen(port, '0.0.0.0', () => {
    remoteUrl = `http://${lanAddress()}:${port}/?k=${REMOTE_TOKEN}`;
    REMOTE = true;
    cb?.(null);
  });
}
function stopRemote() { if (remoteServer) { remoteServer.close(); remoteServer.closeAllConnections?.(); remoteServer = null; REMOTE = false; } }
function remoteBlock() {
  const qr = qrLines(remoteUrl);
  return [
    '',
    `${c(PINK, '◆')} ${bold('Remote')}  ${dim('scan with your phone (same Wi-Fi). The link carries a private key; don\'t share it.')}`,
    ...(qr ? qr.map(l => `     ${l}`) : []),
    `     ${c(SKY, remoteUrl)}`,
    dim('     Windows may ask to allow Node.js on private networks: allow it. /remote off to stop.'),
  ].join('\n');
}

// Control the pack from the Claude app: a Claude Code session with Remote Control that drives Kennel through the kennel CLI.
const REMOTE_CONTROL_PROMPT = `This Claude Code session is the remote control for Kennel HQ, which is already running in this project folder. The human is talking to you from the Claude app on their phone, so treat their messages as instructions for the pack of dogs.

- Send work to the pack with the kennel CLI (the kennel skill explains it): run \`kennel ask "<task>" --wait\` in the background, then report the result. Use \`--dog <name>\` when they name a dog.
- For "what's going on?", run \`kennel status\`. For past work, \`kennel brain\` and \`kennel read <id>\`. For corrections, \`kennel bad <id> "<what's wrong>"\`. For rules, \`kennel teach team "<rule>"\`.
- Questions about the code can go to Lucifur (\`--dog lucifur\`), or answer quickly yourself if it's simple.
- Don't edit the project yourself unless they ask you to; the pack does the work.
- Keep replies short for a phone screen: what you sent, who has it, and the result when it comes back.
- Reply in the language they write in.`;

function startClaudeRemote() {
  const name = `Kennel · ${FOLDER}`;
  const promptFile = path.join(BRAIN_DIR, 'remote-control.md');
  fs.writeFileSync(promptFile, REMOTE_CONTROL_PROMPT);
  const command = `"${CLAUDE}" --remote-control "${name}" --append-system-prompt-file "${promptFile}"`;
  if (process.platform === 'win32') {
    const script = path.join(BRAIN_DIR, 'remote-control.cmd');
    fs.writeFileSync(script, `@echo off\r\nchcp 65001 >nul\r\ntitle Kennel HQ - Claude Remote Control\r\ncd /d "${WORKDIR}"\r\necho Starting a Claude Code session you can control from the Claude app...\r\n${command}\r\n`);
    exec(`start "Kennel HQ - Claude Remote Control" cmd /k "${script}"`, { cwd: WORKDIR, windowsHide: false });
    return { ok: true, name };
  }
  if (process.platform === 'darwin') {
    const inner = `cd ${JSON.stringify(WORKDIR)} && ${command}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    exec(`osascript -e "tell application \\"Terminal\\" to do script \\"${inner}\\""`, () => {});
    return { ok: true, name };
  }
  return { ok: false, name, command: `cd "${WORKDIR}" && ${command}` };
}

const server = http.createServer((req, res) => handle(req, res, false));
async function handle(req, res, remote) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  if (remote && !remoteAuthorized(req, res, url)) return;

  if (p === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': hello\n\n');
    sseClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }
  if (p === '/api/state') {
    return json(res, 200, {
      apiVersion: API_VERSION, ready: Boolean(CLAUDE_VERSION), engine: 'claude-code', version: CLAUDE_VERSION, model: MODEL || 'default', qaModel: QA_MODEL,
      folder: FOLDER, path: WORKDIR, access: ACCESS, review: REVIEW, paused, port: PORT, errors: recentErrors,
      brain: brain.slice(0, 400), lessons, usage, usageSummary: usageSummary(), limits, diffs: recentDiffs.slice(0, 80), profile, events: recentEvents,
      skills: Object.fromEntries(IDS.map(id => [id, hasSkills(id) ? skillNames(id) : []])),
      current: Object.fromEntries(Object.entries(current).map(([k, c]) => [k, { id: c.id, title: c.title, chars: c.chars, kind: c.kind, action: strip(c.action || '') }])),
      chatting: Object.fromEntries(Object.entries(chatting).map(([k, s]) => [k, { action: s.action, text: s.out }])),
      queues: Object.fromEntries(IDS.map(k => [k, queues[k].length])),
      activities: Object.fromEntries(Object.entries(activity).map(([k, a]) => [k, { item: a.item, seat: a.seat, label: a.label, since: a.since }])),
    });
  }
  if (p === '/api/remote') {
    const state = () => ({ on: Boolean(remoteServer), url: remoteServer ? remoteUrl : '', qr: remoteServer ? qrMatrix(remoteUrl) : null, local: !remote });
    if (req.method === 'GET') return json(res, 200, state());
    // Only this computer can open or close remote access, never a phone that's already connected.
    if (remote) return json(res, 403, { error: 'Remote access can only be changed from the computer running Kennel.' });
    const d = await readBody(req);
    if (d?.on === false) { stopRemote(); out(dim('  remote access turned off from the office')); emit({ type: 'remote', on: false }); return json(res, 200, state()); }
    return startRemote(err => {
      if (err) return json(res, 500, { error: `Couldn't open remote access: ${err.message}` });
      out(remoteBlock());
      emit({ type: 'remote', on: true });
      json(res, 200, state());
    });
  }
  if (p === '/api/claude-remote' && req.method === 'POST') {
    if (remote) return json(res, 403, { error: 'Start Claude Remote Control from the computer running Kennel.' });
    if (!CLAUDE_VERSION) return json(res, 503, { error: 'Claude Code CLI not found.' });
    const r = startClaudeRemote();
    out(r.ok ? `  ${c(PINK, '◆')} opened a Claude Remote Control session ${dim(`“${r.name}”`)}: open the Claude app on your phone → Code, and pick it.`
      : dim(`  run this in another terminal for Claude Remote Control: ${r.command}`));
    return json(res, 200, r);
  }
  if (p === '/api/usage') {
    if (req.method === 'POST') { const d = await readBody(req); return json(res, 200, { budget: setBudget(d?.budget) }); }
    return json(res, 200, usageSummary());
  }
  if (req.method === 'POST' && ['/api/undo', '/api/followup', '/api/commit', '/api/cancel'].includes(p)) {
    const d = (await readBody(req)) || {};
    if (p === '/api/undo') { const r = undoJob(String(d.id || '')); return json(res, r.error ? 400 : 200, r); }
    if (p === '/api/cancel') return json(res, 200, { ok: stopTask(String(d.id || '')) });
    if (p === '/api/commit') { const r = await commitJob(String(d.id || '')); return json(res, r.error ? 400 : 200, r); }
    const text = String(d.text || '').trim();
    if (!text) return json(res, 400, { error: 'Say what to do next.' });
    const t = followUp(String(d.id || ''), text);
    return t ? json(res, 200, { id: t.id, dog: t.dog }) : json(res, 404, { error: 'Job not found.' });
  }
  if (p === '/api/skills') {
    if (req.method === 'POST') { if (remote) return json(res, 403, { error: 'Update skills from the computer running Kennel.' }); doSkills(); return json(res, 200, { started: true }); }
    return json(res, 200, { dogs: Object.fromEntries(IDS.map(id => [id, hasSkills(id) ? skillNames(id) : []])), sources: Object.values(SOURCES).map(s => s.repo) });
  }
  if (p === '/api/tree') return json(res, 200, { folder: FOLDER, files: listFiles() });
  if (p === '/api/profile' && req.method === 'POST') { const d = await readBody(req); return d ? json(res, 200, { profile: setProfile(d) }) : json(res, 400, { error: 'Bad JSON' }); }
  if (p === '/api/file') {
    const r = readProjectFile(String(url.searchParams.get('path') || ''));
    return json(res, r.error ? 404 : 200, r);
  }
  if (p === '/api/chat' && req.method === 'GET') {
    const dog = url.searchParams.get('dog');
    return json(res, 200, { messages: chats[dog]?.messages || [], busy: chatting[dog] ? { action: chatting[dog].action, text: chatting[dog].out } : null });
  }
  if (p === '/api/chat' && req.method === 'POST') {
    const data = await readBody(req);
    const text = String(data?.text || '').trim();
    if (!text) return json(res, 400, { error: 'Message is empty' });
    if (!CLAUDE_VERSION) return json(res, 503, { error: 'Claude Code CLI not found.' });
    const r = chat(String(data.dog || 'lucifur'), text, Array.isArray(data.files) ? data.files.map(String).slice(0, 20) : []);
    return json(res, r.error ? 409 : 200, r);
  }
  if (p === '/api/chat/reset' && req.method === 'POST') {
    const dog = url.searchParams.get('dog');
    if (chats[dog]) { chats[dog] = { session: null, messages: [] }; saveChats(); }
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/qa') {
    const d = await readBody(req);
    if (d?.id) { const m = findMem(d.id); if (!m || !DOGS[m.dog]) return json(res, 404, { error: 'Job not found' }); setStatus(m, 'pending-qa', { qaWhy: 'asked by you' }); }
    return json(res, 200, { started: runQA(true) });
  }
  if (req.method === 'POST' && p === '/api/import') return json(res, 200, await importClaudeMemory());
  if (req.method === 'POST' && p === '/api/learn-git') { const r = await learnGit(); return json(res, r.error ? 400 : 200, r); }
  if (req.method === 'POST' && p === '/api/quit') {
    json(res, 200, { ok: true });
    for (const id of IDS) stop(id);
    setTimeout(() => process.exit(0), 300);
    return;
  }
  if (req.method === 'POST' && ['/api/task', '/api/feedback', '/api/teach'].includes(p)) {
    const data = await readBody(req);
    if (!data) return json(res, 400, { error: 'Bad JSON' });
    const text = String(data.text || '').trim();
    if (!text) return json(res, 400, { error: 'Text is empty' });
    if (p === '/api/teach') return json(res, 200, { lesson: addLesson(DOGS[data.dog] ? data.dog : 'team', text, 'you') });
    if (!CLAUDE_VERSION) return json(res, 503, { error: 'Claude Code CLI not found.' });
    if (p === '/api/feedback') {
      const t = feedback(String(data.id || ''), text);
      return t ? json(res, 200, { id: t.id, dog: t.dog }) : json(res, 404, { error: 'Memory not found' });
    }
    const files = Array.isArray(data.files) ? data.files.map(String).slice(0, 20) : [];
    // Claude Code (the skill) writes its own briefs, so it skips the front desk.
    if (data.from === 'cli') { const task = assign(text, data.dog, 'cli', Boolean(data.plan), files); return json(res, 200, { id: task.id, dog: task.dog, kind: task.kind }); }
    // Answer right away; the front desk works in the background and the office follows along through events.
    frontDesk(text, data.dog, 'web', Boolean(data.plan), files).catch(err => emit({ type: 'notice', text: `Front desk error: ${err.message}` }));
    return json(res, 200, { kind: 'desk' });
  }
  if (p === '/api/stop' && req.method === 'POST') return json(res, 200, { stopped: stop(url.searchParams.get('dog')) });
  if (p.startsWith('/api/memory/')) {
    const id = decodeURIComponent(p.slice('/api/memory/'.length));
    const mem = findMem(id);
    if (!mem) return json(res, 404, { error: 'Not found' });
    return json(res, 200, { mem, output: readOutput(id) ?? mem.note });
  }

  const relPath = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, relPath);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/* ================================================================== terminal */
const tty = process.stdout.isTTY;
const c = (rgb, s) => tty ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[39m` : s;
const dim = s => tty ? `\x1b[2m${s}\x1b[22m` : s;
const bold = s => tty ? `\x1b[1m${s}\x1b[22m` : s;
const PINK = [255, 143, 192], RED = [255, 107, 107], MINT = [126, 224, 176], SKY = [121, 199, 255], AMBER = [255, 179, 71], GRAY = [110, 102, 128];
const dn = id => (DOGS[id] ? c(DOGS[id].rgb, bold(DOGS[id].name)) : bold(id === 'team' ? 'Team' : 'Claude'));
const pct = x => `${Math.round((x || 0) * 100)}%`;
const limitLine = () => limits?.unifiedWindows
  ? `5h limit ${pct(limits.unifiedWindows.five_hour?.utilization)} · weekly ${pct(limits.unifiedWindows.seven_day?.utilization)}`
  : '';
let watching = null;
const watchBuf = {};
const MINTTY = !HEADLESS && process.platform === 'win32' && !process.stdin.isTTY && (process.env.MSYSTEM || process.env.TERM_PROGRAM === 'mintty');

const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const KIND = { review: 'QA', fix: 'Fixing', plan: 'Planning' };
const fmtDur = ms => { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
const fmtK = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const dot = id => c(DOGS[id]?.rgb || PINK, '●');
const nm = id => c(DOGS[id]?.rgb || PINK, bold(DOGS[id]?.name || (id === 'team' ? 'Team' : 'Claude')));
const branch = s => `  ${dim('⎿')}  ${s}`;
const cont = s => `     ${s}`;

// Live block above the input box: one row per working dog, Claude Code style.
function statusLines(frame) {
  const lines = [];
  IDS.forEach((id, i) => {
    const cur = current[id];
    if (!cur) return;
    const kind = KIND[cur.kind];
    const title = cur.title.replace(/^(QA|Fix|Plan): /, '');
    lines.push(`${c(DOGS[id].rgb, SPIN[(frame + i * 3) % SPIN.length])} ${c(DOGS[id].rgb, bold(DOGS[id].name.padEnd(8)))}${cur.action || 'Thinking…'}  ${dim(`${kind ? kind + ' · ' : ''}${title} · ${fmtDur(Date.now() - cur.started)}${cur.chars ? ` · ↓ ${fmtK(cur.chars)}` : ''}`)}`);
  });
  IDS.forEach((id, i) => {
    const ch = chatting[id];
    if (ch) lines.push(`${c(DOGS[id].rgb, SPIN[(frame + i * 3) % SPIN.length])} ${c(DOGS[id].rgb, bold(DOGS[id].name.padEnd(8)))}${ch.action}  ${dim(`chat · ${fmtDur(Date.now() - ch.started)}`)}`);
  });
  const queued = IDS.reduce((a, id) => a + queues[id].length, 0);
  const idle = IDS.filter(id => !current[id] && !chatting[id]);
  if (!lines.length && !queued) return [dim(`  no tickets · ${idleSummary(idle)}`)];
  const tail = [];
  if (idle.length) tail.push(`idle: ${idleSummary(idle)}`);
  else tail.push('the whole pack is busy');
  if (queued) tail.push(`${queued} queued`);
  if (tail.length) lines.push(dim(`  ${tail.join(' · ')}`));
  return lines;
}

// "Chou, Tiger napping · Bacon getting coffee · Harley at the desk": idle dogs grouped by what they're doing.
function idleSummary(ids) {
  const groups = new Map();
  for (const id of ids) {
    const what = activity[id] ? ITEMS[activity[id].item].verb : 'at the desk';
    groups.set(what, [...(groups.get(what) || []), DOGS[id].name]);
  }
  return [...groups].map(([what, names]) => `${names.join(', ')} ${what}`).join(' · ');
}

function footerLine(cols, hint) {
  const left = hint || dim('/help · @dog picks one · tab completes · ↑ history · ctrl+c twice quits');
  const u = usedPct();
  const parts = [];
  if (paused) parts.push(c(RED, '❚❚ paused'));
  if (limits) parts.push(c(u >= 0.8 ? RED : u >= 0.6 ? AMBER : MINT, `5h ${pct(u)}`));
  const pend = brain.filter(m => m.status === 'pending-qa' || m.status === 'checking').length;
  if (pend) parts.push(c(AMBER, `QA ${pend} waiting`));
  const needs = brain.filter(m => m.status === 'needs-you').length;
  if (needs) parts.push(c(RED, `${needs} need you`));
  if (remoteServer) parts.push(c(SKY, 'remote on'));
  parts.push(ACCESS === 'full' ? c(RED, 'full access') : dim(ACCESS));
  parts.push(dim(WORK_MODEL));
  const right = parts.join(dim(' · '));
  const gap = cols - 2 - width(left) - width(right);
  return `  ${left}${gap > 1 ? ' '.repeat(gap) : '  '}${right}`;
}

function out(line) { if (tui) tui.log(line); else console.log(line); }
let lastChatFrom = '';
function chatFromTerminal(dog, text) {
  lastChatFrom = 'terminal';
  const r = chat(dog, text);
  if (r.error) { lastChatFrom = ''; out(dim(`  ${r.error}`)); }
}

listeners.add(ev => {
  if (ev.type === 'queued') {
    const { kind, title, from, waitsFor } = ev.task;
    const t = title.replace(/^(QA|Fix|Plan): /, '');
    if (kind === 'plan') out(`\n${dot(ev.dog)} ${nm(ev.dog)} ${c(AMBER, 'is planning')} ${dim('“')}${t}${dim('”')}`);
    else if (kind === 'review') out(`\n${dot(ev.dog)} ${nm(ev.dog)} ${c(AMBER, 'QA check')} ${dim(t)}`);
    else if (kind === 'fix') out(`\n${dot(ev.dog)} ${nm(ev.dog)} ${c(AMBER, 'is fixing')} ${t}`);
    else out(`\n${dot(ev.dog)} ${nm(ev.dog)} ${dim('←')} ${t}${waitsFor ? dim('  · waits for an earlier ticket') : ''}${from === 'web' ? dim('  · from the office') : from === 'cli' ? dim('  · from Claude Code') : ''}`);
  }
  if (ev.type === 'tool') {
    const s = ev.cmd ? `${c(SKY, '$')} ${ev.what}` : ev.wrote ? `${c(SKY, ev.verb)} ${ev.what}` : dim(`${ev.verb} ${ev.what}`);
    out(`  ${dim('⎿')}  ${c(DOGS[ev.dog].rgb, DOGS[ev.dog].name.padEnd(8))}${s}`);
  }
  if (ev.type === 'diff') {
    const cols = (process.stdout.columns || 100) - 10, lines = [];
    for (const h of ev.hunks) {
      for (const l of h.minus) lines.push(l.startsWith('… ') ? dim(`       ${l}`) : `       ${c([255, 150, 160], fit('- ' + l, cols))}`);
      for (const l of h.plus) lines.push(l.startsWith('… ') ? dim(`       ${l}`) : `       ${c([150, 230, 180], fit('+ ' + l, cols))}`);
    }
    const shown = lines.slice(0, 10);
    if (lines.length > shown.length) shown.push(dim(`       … ${lines.length - shown.length} more lines (Changes tab in the office)`));
    out(`     ${dim(ev.kind === 'write' ? 'wrote' : 'edited')} ${ev.file}  ${c(MINT, '+' + ev.added)} ${c(RED, '−' + ev.removed)}\n${shown.join('\n')}`);
  }
  if (ev.type === 'plan') {
    out([branch(dim(`split into ${ev.tickets.length} ticket${ev.tickets.length > 1 ? 's' : ''}`)),
      ...ev.tickets.map(t => cont(`${dim('#' + t.n)} ${nm(t.dog)}  ${t.title}${t.after.length ? dim(`  after #${t.after.join(', #')}`) : ''}`))].join('\n'));
  }
  if (ev.type === 'done') {
    const m = ev.mem;
    if (watchBuf[ev.dog]) { out(`     ${dim('│')} ${watchBuf[ev.dog]}`); watchBuf[ev.dog] = ''; }
    if (m.kind === 'review' || m.kind === 'plan') return;
    const qa = m.status === 'pending-qa' ? c(AMBER, `  QA: ${m.qaWhy || 'needed'}`) : m.status === 'self-checked' ? dim('  no QA needed') : '';
    out([`\n${c(MINT, '✓')} ${nm(ev.dog)} ${bold('done')} ${dim('·')} ${m.title}${qa}`,
      branch(m.note),
      ...(m.files.length ? [cont(`${dim('files')}  ${m.files.join(', ')}`)] : []),
      cont(dim(`${m.turns} turns · ${fmtK(m.tokens)} tokens · id ${m.id}`))].join('\n'));
    // A question (or a job that changed nothing) gets its answer printed right here.
    if (ev.report && (!m.files.length || /\?\s*$/.test(m.title))) {
      const body = ev.report.split('\n'), shown = body.slice(0, 40);
      out(`\n${shown.map(l => `     ${l}`).join('\n')}${body.length > shown.length ? `\n${cont(dim(`… full answer: /read ${m.id}`))}` : ''}`);
    }
  }
  if (ev.type === 'review') {
    if (ev.verdict === 'PASS') out(`${c(MINT, '✓')} ${c(MINT, 'QA passed')} ${nm(ev.author)} ${dim(`· ${DOGS[ev.reviewer].name}: ${ev.note}`)}`);
    else if (ev.gaveUp) out(`${c(RED, '!')} ${c(RED, bold('Needs you'))} ${nm(ev.author)}  ${ev.note}\n${cont(dim(`/read ${ev.target}`))}`);
    else out(`${c(RED, '✗')} ${c(RED, 'QA failed')} ${nm(ev.author)}  ${ev.note}\n${cont(dim('going back to fix it'))}`);
  }
  if (ev.type === 'lesson' && ev.lesson.source !== 'claude' && ev.lesson.source !== 'git') {
    const src = { you: 'from you', review: 'from QA', self: 'own lesson', git: 'from your git history' }[ev.lesson.source] || ev.lesson.source;
    out(`  ${c(PINK, '✦')} ${nm(ev.lesson.dog)} learned ${dim('·')} ${ev.lesson.text} ${dim(`(${src})`)}`);
  }
  if (ev.type === 'triage-start') out(`\n${dot('lucifur')} ${nm('lucifur')} ${dim('(front desk) is reading:')} ${ev.text}`);
  if (ev.type === 'triage') {
    if (ev.action === 'reply') out(`  ${dim('⎿')}  ${ev.reply.split('\n').join('\n     ')}\n     ${dim('answered at the desk, no job started')}`);
    else if (ev.action === 'question') out(`  ${dim('⎿')}  ${dim('a question: sent to')} ${nm(ev.dog)}${dim('\'s chat (cheaper than a full job)')}`);
    else if (ev.action === 'follow') out(`  ${dim('⎿')}  ${dim('a follow-up on job')} ${ev.job}${dim(': ')}${nm(ev.dog)} ${dim(ev.waits ? 'continues the same session as soon as the current run ends' : 'continues in the same session (no re-reading)')}`);
    else if (ev.action === 'add') out(`  ${dim('⎿')}  ${dim('added to')} ${nm(ev.dog)}${dim('\'s queued job (it hasn\'t started yet, so no extra job)')}`);
    else if (ev.action === 'fix') out(`  ${dim('⎿')}  ${dim('a correction: back to')} ${nm(ev.dog)} ${dim('to fix it in the same session, and they\'ll learn from it')}`);
    else if (ev.action === 'same') out(`  ${dim('⎿')}  ${ev.reply || 'already on it'} ${dim(`(job ${ev.job}, nothing new started)`)}`);
    else if (ev.action === 'with') out(`  ${dim('⎿')}  ${dim('same work as your previous message: merged into one job')}`);
    else if (!ev.fallback) out(`  ${dim('⎿')}  ${dim(ev.action === 'plan' ? `a big one: to ${DOGS[ev.planner]?.name || 'Chou'} for planning` : 'real work: to')} ${ev.action === 'plan' ? '' : nm(ev.dog || route(''))}${ev.brief ? `\n     ${dim('brief:')} ${ev.brief}` : ''}`);
  }
  if (ev.type === 'merged') out(`  ${dim('⎿')}  ${nm(ev.dog)} ${dim('will also:')} ${ev.text}`);
  if (ev.type === 'hold') out(`  ${dim('⎿')}  ${nm(ev.dog)} ${dim(`waits for ${DOGS[ev.by].name} to finish with ${ev.files.join(', ')}`)}`);
  if (ev.type === 'chat' && lastChatFrom !== 'terminal') out(`\n${c(GRAY, 'you → ')}${nm(ev.dog)}  ${ev.message.text}${dim('  · from the office')}`);
  if (ev.type === 'chat') lastChatFrom = '';
  if (ev.type === 'chat-done' && !ev.quiet) {
    const body = ev.message.text.split('\n').map(l => `     ${l}`).join('\n');
    out(`\n${dot(ev.dog)} ${nm(ev.dog)} ${dim('says')}\n${body}`);
  }
  if (ev.type === 'chat-error') out(`${c(RED, '✗')} ${nm(ev.dog)}  ${c(RED, ev.message)}`);
  if (ev.type === 'undone') out(`  ${c(AMBER, '↶')} undid ${nm(ev.dog)}'s “${ev.title}” ${dim(`(restored ${ev.restored.length}, removed ${ev.removed.length})`)}`);
  if (ev.type === 'committed') out(`  ${c(MINT, '✓')} committed ${ev.sha}  ${ev.message.split('\n')[0]}`);
  if (ev.type === 'notice') out(`${c(AMBER, '!')} ${ev.text}`);
  if (ev.type === 'paused') out(`${c(RED, '❚❚')} ${c(RED, 'Paused')}  ${ev.text}`);
  if (ev.type === 'resumed') out(`${c(MINT, '▶')} Limit reset, the pack is back to work`);
  if (ev.type === 'error') out(`${c(RED, '✗')} ${nm(ev.dog)}  ${c(RED, ev.message)}`);
});

const HELP = `
  ${bold('Give a task')}              just type it. Small ones go straight to the right dog; big ones
                           (long, or several parts) get split into tickets by Chou first.
  ${bold('@dog <task>')}              send to one dog, no planning, e.g.  @bacon add an index for orders
  ${bold('?dog <message>')}           chat with a dog, e.g.  ?lucifur bakit nag-e-error yung login?
                           (they can read the code to answer, but won't change anything)
  ${bold('/plan <request>')}          force Chou to plan it into tickets
  ${bold('/qa')}                      run QA now on everything that hasn't been checked
  ${bold('/bad <id> <what>')}         tell a dog their work is wrong; they learn from it and fix it
  ${bold('/teach <dog|team> <rule>')} teach a lesson, e.g.  /teach team we use pnpm, not npm
  ${bold('/lessons [dog]')}           what they've learned
  ${bold('/import-claude')}           copy what your Claude Code remembers into the pack's brain
  ${bold('/learn-git')}               learn your branch / commit / merge habits from this repo's history
  ${bold('/skills')} [update]          each dog's skills (from popular GitHub skill repos)
  ${bold('/follow <id> <what>')}      ask for more on a finished job, in the same session
  ${bold('/undo <id>')}               put back the files a job changed (needs git)
  ${bold('/commit <id>')}             commit a job's files with a message in your team's style
  ${bold('/usage')} · ${bold('/budget 500k')}     tokens per dog and day · a daily token budget
  ${bold('/remote')} [off]            open the office on your phone (same Wi-Fi) with a QR code
  ${bold('/claude-remote')}           control the pack from the Claude app (Claude Code Remote Control)
  ${bold('/status')}                  who's doing what + your Claude limit
  ${bold('/brain [search]')}          recent memories (ids are shown here)
  ${bold('/read <id>')}               a memory's full output
  ${bold('/watch <dog>|off')}         stream a dog's writing live here
  ${bold('/stop <dog>')}              stop what a dog is doing
  ${bold('/resume')}                  continue after a limit pause
  ${bold('/open')}                    open the office in the browser
  ${bold('/quit')}                    close Kennel HQ
`;

function status() {
  for (const id of IDS) {
    const cur = current[id];
    const waiting = queues[id].filter(t => !t.deps.every(d => doneIds.has(d))).length;
    const q = queues[id].length;
    const doing = cur ? `${{ review: 'QA', fix: 'fixing', plan: 'planning' }[cur.kind] || 'working on'} “${cur.title.replace(/^(QA|Fix|Plan): /, '')}”${cur.files.size ? dim(` · edited ${cur.files.size} file(s)`) : ''}` : dim(activity[id] ? `idle · ${activityLabel(id)}` : 'idle');
    out(`  ${dn(id).padEnd(tty ? 30 : 8)} ${dim(DOGS[id].role.padEnd(18))} ${doing}${q ? dim(`  +${q} queued${waiting ? ` (${waiting} waiting on other tickets)` : ''}`) : ''}`);
  }
  const pend = brain.filter(m => m.status === 'pending-qa').length;
  out(dim(`  ${usage.tasks} jobs · ${lessons.length} lessons · ${pend ? `${pend} waiting for QA · ` : ''}${usage.tokens.toLocaleString()} tokens${limitLine() ? ' · ' + limitLine() : ''}${paused ? ' · PAUSED (/resume)' : ''}`));
}

let gettingSkills = false;
async function doSkills() {
  if (gettingSkills) return;
  gettingSkills = true;
  out(dim("  getting the pack's skills from GitHub (one time, about 20 seconds)…"));
  try {
    await installSkills(m => { if (m !== 'done') out(dim(`    ${m}`)); });
    out(`  ${c(PINK, '◆ skills ready')}  ${IDS.map(id => `${nm(id)} ${dim(String(skillNames(id).length))}`).join(dim(' · '))}  ${dim('(/skills to see them)')}`);
    emit({ type: 'skills' });
  } catch (err) { out(c(RED, `  couldn't get the skills: ${err.message}. The dogs work fine without them; try /skills update later.`)); }
  finally { gettingSkills = false; }
}
function skillsTable() {
  return IDS.map(id => `  ${nm(id).padEnd(tty ? 26 : 8)} ${hasSkills(id) ? skillNames(id).join(dim(', ')) : dim('not downloaded yet')}`).join('\n')
    + `\n  ${dim('from: ' + [...new Set(Object.values(SOURCES).map(s => s.repo))].join(', '))}`;
}

let learningGit = false;
async function doLearnGit(auto = false) {
  if (learningGit) return;
  learningGit = true;
  out(dim(`  ${auto ? 'first time in this repo: ' : ''}reading your branches and commits to learn the team's git workflow…`));
  try {
    const r = await learnGit();
    if (r.error) out(dim(`  ${r.error}`));
    else out([`  ${c(PINK, '◆ git workflow learned')} ${dim(`${r.rules.length} rules, ${r.added} new`)}`, ...r.rules.map(x => cont(`${dim('·')} ${x}`))].join('\n'));
  } finally { learningGit = false; }
}

let importing = false;
async function doImport() {
  if (importing) { out(dim('  already importing…')); return; }
  importing = true;
  out(dim('  reading Claude Code memory… (Claude is sorting out which rules apply to every project)'));
  try {
    const r = await importClaudeMemory();
    if (!r.projects) { out(dim('  no Claude Code memory found in ~/.claude/projects')); return; }
    out(`  ${c(PINK, '◆ imported')} from ${r.projects} Claude Code project memories: ${bold(r.lessons)} team lessons${r.general ? dim(` (${r.general} general rules)`) : ''}${r.memories ? `, ${bold(r.memories)} notes about this project` : ''}${r.known ? dim(`, ${r.known} already known`) : ''}`);
    out(dim(r.distilled ? '  Client names and project details from other folders were left out. See /lessons team.' : '  Couldn\'t sort the other projects\' notes, so only this project\'s were imported. Try again later.'));
  } finally { importing = false; }
}

function handleLine(line) {
  const s = line.trim();
  if (!s) return;
  const [cmd, ...rest] = s.split(/\s+/);
  const arg = s.slice(cmd.length).trim();
  switch (cmd) {
    case '/help': case 'help': out(HELP); return;
    case '/quit': case '/exit': return quit();
    case '/chat': {
      const who = (rest[0] || '').toLowerCase();
      const msg = arg.slice((rest[0] || '').length).trim();
      if (!DOGS[who] || !msg) { out(dim('  usage: /chat <dog> <message>   or   ?lucifur <message>')); return; }
      chatFromTerminal(who, msg);
      return;
    }
    case '/status': status(); return;
    case '/open': openBrowser(); out(dim(`  opened http://localhost:${PORT}`)); return;
    case '/import-claude': doImport(); return;
    case '/learn-git': doLearnGit(); return;
    case '/usage': {
      const u = usageSummary();
      out([`  ${bold('today')} ${u.today.toLocaleString()} tokens${u.budget ? dim(` of ${u.budget.toLocaleString()} budget`) : ''}${limitLine() ? dim(' · ' + limitLine()) : ''}`,
        ...Object.entries(u.byDog).sort((a, b) => b[1] - a[1]).map(([d, n]) => `  ${nm(d).padEnd(tty ? 26 : 8)} ${n.toLocaleString()}`),
        dim(`  last days: ${u.days.map(x => `${x.day.slice(5)} ${fmtK(x.tokens)}`).join(' · ')}`)].join('\n'));
      return;
    }
    case '/budget': {
      if (!arg) { out(dim(`  daily budget: ${usage.budget ? usage.budget.toLocaleString() + ' tokens' : 'none'}. Set it with /budget 500000, or /budget off`)); return; }
      const n = arg === 'off' ? 0 : Number(arg.replace(/[,_]/g, '').replace(/k$/i, '000').replace(/m$/i, '000000'));
      if (!Number.isFinite(n)) { out(dim('  usage: /budget 500k  ·  /budget off')); return; }
      setBudget(n); out(dim(`  daily budget: ${n ? n.toLocaleString() + ' tokens' : 'off'}`)); return;
    }
    case '/undo': { if (!arg) { out(dim('  usage: /undo <id>   (ids are in /brain)')); return; } const r = undoJob(arg); out(r.error ? c(RED, `  ${r.error}`) : `  ${c(MINT, '↶ undone')} ${dim(`restored ${r.restored.length} file(s), removed ${r.removed.length}`)}`); return; }
    case '/commit': { if (!arg) { out(dim('  usage: /commit <id>')); return; } commitJob(arg).then(r => out(r.error ? c(RED, `  ${r.error}`) : `  ${c(MINT, '✓ committed')} ${r.sha}  ${r.message.split('\n')[0]}`)); return; }
    case '/follow': { const id = rest[0], text = arg.slice((id || '').length).trim(); if (!id || !text) { out(dim('  usage: /follow <id> <what next>')); return; } if (!followUp(id, text, 'terminal')) out(dim('  no job with that id (see /brain)')); return; }
    case '/skills': if (arg === 'update') doSkills(); else out(skillsTable()); return;
    case '/claude-remote': case '/rc': {
      if (!CLAUDE_VERSION) { out(c(RED, '  Claude Code CLI not found.')); return; }
      const r = startClaudeRemote();
      out(r.ok ? `  ${c(PINK, '◆')} opened a Claude Remote Control session ${dim(`“${r.name}”`)} in a new window.\n     On your phone: Claude app → Code → pick “${r.name}”. Then just tell it what the pack should do.`
        : `  Run this in another terminal:\n     ${r.command}`);
      return;
    }
    case '/remote':
      if (arg === 'off') { stopRemote(); out(dim('  remote access is off')); return; }
      if (remoteServer) { out(remoteBlock()); return; }
      startRemote(err => out(err ? c(RED, `  couldn't start remote: ${err.message}`) : remoteBlock()));
      return;
    case '/resume': paused = false; out(dim('  resumed')); pumpAll(); return;
    case '/qa': { const n = runQA(true); out(dim(n ? `  QA started for ${n} job(s)` : '  nothing waiting for QA')); return; }
    case '/plan': if (!arg) { out(dim('  usage: /plan <request>')); return; } assign(arg, null, 'terminal', true); return;
    case '/brain': {
      const q = arg.toLowerCase();
      const list = brain.filter(m => !q || `${m.title} ${m.note}`.toLowerCase().includes(q)).slice(0, 12);
      if (!list.length) { out(dim('  nothing in the brain yet')); return; }
      const badge = m => ({ verified: c(MINT, ' ✓'), 'self-checked': c(MINT, ' ✓ self'), failed: c(RED, ' ✗'), fixing: c(AMBER, ' fixing'), 'needs-you': c(RED, ' ! needs you'), checking: c(AMBER, ' QA…'), 'pending-qa': c(AMBER, ' QA later'), 'qa-skipped': dim(' QA skipped') }[m.status] || '');
      for (const m of list) out(`  ${dim(m.id)}  ${c(DOGS[m.dog]?.rgb || PINK, (DOGS[m.dog]?.name || 'Claude').padEnd(8))} ${m.title}${badge(m)}\n  ${' '.repeat(m.id.length)}  ${dim(m.note)}`);
      return;
    }
    case '/read': { const o = readOutput(arg); out(o ? `\n${o}` : dim('  no memory with that id (see /brain)')); return; }
    case '/lessons': {
      const who = arg.toLowerCase();
      const list = lessons.filter(l => !who || l.dog === who).slice(0, 40);
      if (!list.length) { out(dim('  no lessons yet')); return; }
      const src = { you: 'from you', review: 'from QA', claude: 'from Claude Code', git: 'from git history', self: 'self' };
      for (const l of list) out(`  ${dn(l.dog).padEnd(tty ? 30 : 8)} ${l.text} ${dim(`(${src[l.source] || l.source})`)}`);
      return;
    }
    case '/teach': {
      const who = (rest[0] || '').toLowerCase();
      const target = DOGS[who] ? who : who === 'team' ? 'team' : null;
      const text = target ? arg.slice(rest[0].length).trim() : '';
      if (!target || !text) { out(dim('  usage: /teach <dog|team> <lesson>')); return; }
      if (!addLesson(target, text, 'you')) out(dim('  they already know that'));
      return;
    }
    case '/bad': {
      const id = rest[0]; const text = arg.slice((id || '').length).trim();
      if (!id || !text) { out(dim('  usage: /bad <memory id> <what is wrong>   (ids are in /brain)')); return; }
      if (!feedback(id, text, 'terminal')) out(dim('  no memory with that id (see /brain)'));
      return;
    }
    case '/watch':
      watching = DOGS[arg.toLowerCase()] ? arg.toLowerCase() : null;
      out(watching ? dim(`  watching ${DOGS[watching].name}. Their writing streams here.`) : dim('  stopped watching'));
      return;
    case '/stop': {
      const who = arg.toLowerCase();
      out(DOGS[who] ? (stop(who) ? dim(`  stopping ${DOGS[who].name}…`) : dim(`  ${DOGS[who].name} isn't working on anything`)) : dim('  usage: /stop <dog>'));
      return;
    }
  }
  if (s.startsWith('/')) { out(dim('  unknown command, try /help')); return; }
  const ask = s.match(/^\?\s*(\w+)[:,]?\s+([\s\S]+)$/);
  if (ask && DOGS[ask[1].toLowerCase()]) { chatFromTerminal(ask[1].toLowerCase(), ask[2]); return; }
  // "copy my claude's brain / memory" in plain words
  if (/claude/i.test(s) && /(brain|memor|alaala)/i.test(s) && /(copy|import|add|kunin|kopya|lagay|get)/i.test(s)) { doImport(); return; }
  if (!CLAUDE_VERSION) { out(c(RED, '  Claude Code CLI not found.') + ' Install it and log in, then restart kennel.'); return; }
  const m = s.match(new RegExp(`^@?(${IDS.join('|')})\\b[:,]?\\s+(.+)$`, 'i'));
  const go = m ? frontDesk(m[2], m[1].toLowerCase(), 'terminal') : frontDesk(s, null, 'terminal');
  go.catch(err => out(c(RED, `  front desk error: ${err.message}`)));
}

const COMMANDS = ['/help', '/status', '/chat ', '/plan ', '/qa', '/bad ', '/teach ', '/lessons', '/import-claude', '/learn-git', '/skills', '/usage', '/budget ', '/undo ', '/commit ', '/follow ', '/remote', '/claude-remote', '/brain', '/read ', '/watch ', '/stop ', '/resume', '/open', '/quit'];
function completeInput(text) {
  if (/^\?\w*$/.test(text)) return IDS.map(i => `?${i} `).filter(x => x.startsWith(text.toLowerCase()));
  const sub = text.match(/^\/(watch|stop|lessons|teach|chat) (\w*)$/);
  if (sub) return [...IDS, ...(sub[1] === 'teach' ? ['team'] : [])].filter(i => i.startsWith(sub[2].toLowerCase())).map(i => `/${sub[1]} ${i} `);
  if (text.startsWith('/')) return COMMANDS.filter(x => x.startsWith(text));
  if (/^@\w*$/.test(text)) return IDS.map(i => `@${i} `).filter(x => x.startsWith(text.toLowerCase()));
  return [];
}

function quit() { for (const id of IDS) stop(id); tui?.restore(); process.exit(0); }
const tui = HEADLESS ? null : createTUI({
  placeholder: 'Give the pack a task…   e.g.  @harley fix the login bug',
  status: frame => statusLines(frame),
  footer: footerLine,
  busy: () => IDS.some(id => current[id] || chatting[id]),
  complete: completeInput,
  onSubmit: handleLine,
  onExit: quit,
});
process.on('SIGINT', quit);
process.on('SIGTERM', quit);

// One Kennel per folder. server.json tells `kennel ask/status/…` where to find it.
const SERVER_FILE = path.join(BRAIN_DIR, 'server.json');
try {
  const s = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'));
  process.kill(s.pid, 0); // throws if that process is gone
  console.error(`Kennel HQ is already running for this folder (pid ${s.pid}, http://localhost:${s.port}).
Use  kennel status  /  kennel ask "..."  to talk to it, or  kennel stop  to stop it.
(If that's wrong, delete ${SERVER_FILE}.)`);
  process.exit(1);
} catch { /* not running */ }
process.on('exit', () => {
  tui?.restore();
  try { if (JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(SERVER_FILE); } catch { /* fine */ }
});

function openBrowser() {
  const url = `http://localhost:${PORT}`;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

let tries = 0;
server.on('error', err => {
  if (err.code === 'EADDRINUSE' && tries++ < 20) { PORT++; server.listen(PORT, '127.0.0.1'); return; }
  console.error(err.code === 'EADDRINUSE' ? c(RED, 'No free port found. Use --port <n>.') : err);
  process.exit(1);
});

const AUTHOR = 'Gene Elpie Landoy';
// Big block-letter title with an amber → pink → violet gradient.
function titleArt(cols) {
  const F = {
    K: ['█  █', '█ █ ', '██  ', '█ █ ', '█  █'], E: ['████', '█   ', '███ ', '█   ', '████'], N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
    L: ['█   ', '█   ', '█   ', '█   ', '████'], H: ['█  █', '█  █', '████', '█  █', '█  █'], Q: [' ██ ', '█  █', '█  █', '█ ██', ' ███'], ' ': ['  ', '  ', '  ', '  ', '  '],
  };
  const text = 'KENNEL HQ';
  const rows = [0, 1, 2, 3, 4].map(r => [...text].map(ch => F[ch][r]).join(' '));
  const scale = cols > 0 && cols >= rows[0].length * 2 + 6 ? 2 : 1;
  const w = rows[0].length * scale;
  const stops = [[255, 179, 71], [255, 143, 192], [182, 156, 255]];
  const at = i => { const t = i / Math.max(1, w - 1) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k; return stops[k].map((v, j) => Math.round(v + (stops[k + 1][j] - v) * f)); };
  return rows.map(r => '  ' + [...r].flatMap(ch => Array(scale).fill(ch)).map((ch, i) => (ch === ' ' ? ' ' : c(at(i), ch))).join(''));
}

function banner() {
  const cols = (process.stdout.columns || 100) - 1;
  const lines = [''];
  // Compact on purpose: small title, small heads in one row, a short info box.
  if (tty && cols >= 50) {
    lines.push(...titleArt(0));
    lines.push(`  ${dim('crafted by')} ${bold(c(PINK, AUTHOR))}  ${dim('· a pack of Claude Code workers')}`);
  }
  const cell = 13;
  const dogs = IDS.filter(id => !isCat(id)), cats = IDS.filter(isCat);
  if (tty && cols >= dogs.length * cell + 2) {
    const center = (s, raw) => { const l = Math.max(0, Math.floor((11 - raw.length) / 2)); return ' '.repeat(l) + s + ' '.repeat(Math.max(0, 11 - raw.length - l)); };
    for (const [label, group] of [['the pack · software, downstairs', dogs], ['the cattery · video studio, upstairs', cats]]) {
      lines.push('', `  ${dim(label)}`);
      const heads = group.map(id => mini(id));
      for (let r = 0; r < heads[0].length; r++) lines.push(`  ${heads.map(h => h[r]).join('  ')}`);
      lines.push(`  ${group.map(id => center(c(DOGS[id].rgb, DOGS[id].name), DOGS[id].name)).join('  ')}`);
    }
  } else if (tty) lines.push(`  ${dogs.map(id => c(DOGS[id].rgb, DOGS[id].name)).join(dim(' · '))}`, `  ${cats.map(id => c(DOGS[id].rgb, DOGS[id].name)).join(dim(' · '))}`);
  lines.push('');
  const W = Math.min(cols, 92);
  const g = s => c(GRAY, s);
  const row = s => `${g('│')} ${pad(fit(s, W - 4), W - 4)} ${g('│')}`;
  const sep = dim('  ·  ');
  const access = ACCESS === 'full' ? c(RED, 'full access') : ACCESS === 'safe' ? 'edit only' : 'read-only';
  const claude = CLAUDE_VERSION ? `Claude Code ${CLAUDE_VERSION.split(' ')[0]} ${dim('·')} ${WORK_MODEL} for work` : c(RED, 'Claude Code not found');
  const head = ` ✻ Kennel HQ · by ${AUTHOR} `;
  lines.push(
    g('╭──') + c(PINK, head) + g(`${'─'.repeat(Math.max(0, W - 4 - width(head)))}╮`),
    row(`${bold(profile ? `Welcome back, ${profile.name}.` : 'Welcome.')}${sep}${dim('project')} ${FOLDER}${sep}${dim('office')} ${c(SKY, `http://localhost:${PORT}`)}`),
    row(`${dim('claude')} ${claude}${sep}${dim('access')} ${access}${sep}${dim('QA')} ${REVIEW ? (REVIEW_MODE === 'always' ? `every change (${QA_MODEL})` : 'only when needed') : 'off'}`),
    row(`${dim('brain')} ${brain.length} memories, ${lessons.length} lessons${sep}${dim(HEADLESS ? 'background mode: kennel ask "…"' : '/help · ?dog to chat · @dog to assign')}`),
    g(`╰${'─'.repeat(W - 2)}╯`),
  );
  const tips = [];
  if (!lessons.some(l => l.source === 'claude')) tips.push('/import-claude');
  if (!REMOTE) tips.push('/remote for your phone');
  if (tips.length) lines.push(dim(`  tips: ${tips.join(' · ')}`));
  if (ACCESS === 'full' && !IS_GIT) lines.push(c(AMBER, '  ! Not a git repo. Run git init and commit first so you can undo anything.'));
  if (MINTTY) lines.push(c(AMBER, '  ! Git Bash detected: line editing is unreliable here. Use PowerShell or Windows Terminal, or run: winpty kennel'));
  return lines.join('\n');
}

server.listen(PORT, '127.0.0.1', () => {
  fs.writeFileSync(SERVER_FILE, JSON.stringify({ port: PORT, pid: process.pid, started: Date.now(), headless: HEADLESS }));
  if (tui) { out(banner()); tui.start(); } else console.log(banner());
  if (!NO_OPEN) openBrowser();
  if (REMOTE) startRemote(err => out(err ? c(RED, `  couldn't start remote: ${err.message}`) : remoteBlock()));
  if (gitNeedsLearning()) setTimeout(() => doLearnGit(true), 1500);
  if (!skillsInstalled()) setTimeout(() => doSkills(), 900);
  scheduleQA(); // work left unchecked from last time
});
