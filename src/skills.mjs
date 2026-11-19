// Each dog's (and cat's) skills: picked from popular open-source skill repos, downloaded once from GitHub into ~/.kennel,
// and handed to the dog as its own Claude Code plugin (--plugin-dir). The skill text only loads when a dog
// actually uses a skill, so having them costs little until then.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HOME = path.join(os.homedir(), '.kennel');
const SRC = path.join(HOME, 'skills-src');
const DOGS_DIR = path.join(HOME, 'dogs');

// Where the skills come from. Every one of these is MIT or Apache-2.0; their license files are copied along.
export const SOURCES = {
  superpowers: { repo: 'obra/superpowers', base: 'skills/', license: ['LICENSE'] },
  anthropic: { repo: 'anthropics/skills', base: 'skills/', license: [] }, // each skill folder has its own LICENSE.txt (Apache-2.0)
  uipro: { repo: 'nextlevelbuilder/ui-ux-pro-max-skill', base: '.claude/skills/', license: ['LICENSE'] },
  caveman: { repo: 'JuliusBrussee/caveman', base: 'skills/', license: ['LICENSE', 'LICENSE-MIT'] },
  pgaiguide: { repo: 'timescale/pg-aiguide', base: 'skills/', license: ['LICENSE'] },
  humanizer: { repo: 'blader/humanizer', whole: 'humanizer', license: ['LICENSE'] },
  terrashark: { repo: 'LukasNiessen/terrashark', whole: 'terrashark', license: ['LICENSE'] },
  // The cats' video studio
  ffmpeg: { repo: 'kajisho5/ffmpeg-skill', whole: 'ffmpeg-skill', license: ['LICENSE'] }, // 42 FFmpeg tools (MIT)
  remotion: { repo: 'remotion-dev/skills', base: 'skills/', license: [] }, // Remotion's official agent skills
  remotionmg: { repo: 'haidrrrry/claude-remotion-skill', base: '', license: ['LICENSE'] }, // motion-graphics craft (MIT)
};

// [source, skill folder]. A skill listed twice for one dog is only installed once.
export const DOG_SKILLS = {
  chou: [['superpowers', 'writing-plans'], ['superpowers', 'executing-plans'], ['superpowers', 'brainstorming'], ['superpowers', 'requesting-code-review'],
    ['superpowers', 'receiving-code-review'], ['caveman', 'caveman-review']],
  harley: [['superpowers', 'test-driven-development'], ['superpowers', 'systematic-debugging'], ['superpowers', 'verification-before-completion'],
    ['caveman', 'surgical-patch'], ['caveman', 'safe-refactor'], ['caveman', 'investigate-first'], ['anthropic', 'mcp-builder'], ['anthropic', 'claude-api']],
  asky: [['uipro', 'ui-ux-pro-max'], ['uipro', 'design-system'], ['uipro', 'ui-styling'], ['uipro', 'design'], ['anthropic', 'frontend-design'],
    ['anthropic', 'web-artifacts-builder'], ['anthropic', 'canvas-design'], ['anthropic', 'theme-factory'], ['anthropic', 'algorithmic-art']],
  bacon: [['pgaiguide', 'postgres'], ['pgaiguide', 'design-postgres-tables'], ['pgaiguide', 'postgres-database-migration'], ['pgaiguide', 'schema-exploration'],
    ['pgaiguide', 'migrate-postgres-tables-to-hypertables'], ['caveman', 'migration'], ['superpowers', 'verification-before-completion']],
  pitchie: [['anthropic', 'webapp-testing'], ['superpowers', 'test-driven-development'], ['superpowers', 'verification-before-completion'],
    ['superpowers', 'systematic-debugging'], ['caveman', 'caveman-review'], ['caveman', 'verify-and-stop']],
  tiger: [['terrashark', 'terrashark'], ['superpowers', 'finishing-a-development-branch'], ['superpowers', 'using-git-worktrees'],
    ['superpowers', 'verification-before-completion'], ['caveman', 'caveman-commit'], ['caveman', 'lean-build'], ['caveman', 'verify-and-stop']],
  biscuit: [['humanizer', 'humanizer'], ['anthropic', 'doc-coauthoring'], ['anthropic', 'internal-comms'], ['superpowers', 'writing-skills'],
    ['anthropic', 'docx'], ['anthropic', 'pdf'], ['anthropic', 'pptx'], ['anthropic', 'xlsx']],
  lucifur: [['caveman', 'caveman-explore'], ['caveman', 'investigate-first'], ['superpowers', 'systematic-debugging'], ['superpowers', 'brainstorming'],
    ['superpowers', 'receiving-code-review']],
  // the cats: video studio upstairs
  seah: [['ffmpeg', 'ffmpeg-skill'], ['remotion', 'remotion-best-practices'], ['remotion', 'remotion-render'], ['remotion', 'remotion-multimedia'],
    ['superpowers', 'writing-plans'], ['superpowers', 'verification-before-completion']],
  yuki: [['remotionmg', 'remotion-motion-graphics'], ['remotion', 'remotion-best-practices'], ['remotion', 'remotion-create'], ['remotion', 'remotion-render'],
    ['anthropic', 'algorithmic-art'], ['anthropic', 'canvas-design']],
  shadow: [['ffmpeg', 'ffmpeg-skill'], ['remotion', 'remotion-multimedia'], ['remotion', 'remotion-best-practices'], ['anthropic', 'canvas-design'],
    ['superpowers', 'verification-before-completion']],
  snow: [['ffmpeg', 'ffmpeg-skill'], ['remotion', 'remotion-captions'], ['remotion', 'remotion-multimedia'], ['superpowers', 'verification-before-completion']],
  goose: [['ffmpeg', 'ffmpeg-skill'], ['remotion', 'remotion-best-practices'], ['remotion', 'remotion-render'], ['anthropic', 'canvas-design'],
    ['anthropic', 'slack-gif-creator']],
};

// A dog's skill list with repeats removed (same folder name = same skill, since they share one install folder).
const uniqueSkills = dog => {
  const seen = new Set();
  return (DOG_SKILLS[dog] || []).filter(([, skill]) => !seen.has(skill) && seen.add(skill));
};

// Once a dog's plugin is built, only the skills that actually installed are listed.
export const skillNames = dog => {
  const names = uniqueSkills(dog).map(([, s]) => s);
  const dir = path.join(DOGS_DIR, dog, 'skills');
  return fs.existsSync(dir) ? names.filter(s => fs.existsSync(path.join(dir, s, 'SKILL.md'))) : names;
};
export const pluginDir = dog => path.join(DOGS_DIR, dog);
export const hasSkills = dog => fs.existsSync(path.join(pluginDir(dog), '.claude-plugin', 'plugin.json'));
export const skillsInstalled = () => Object.keys(DOG_SKILLS).every(hasSkills);

const run = (cmd, args, cwd) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', b => { err = (err + b).slice(-800); });
  p.on('error', reject);
  p.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0]} failed: ${err.trim().split('\n').pop()}`))));
});

async function fetchSource(key, paths) {
  // Clone next to the old copy and swap only when it worked, so a failed download (offline) keeps what we had.
  const s = SOURCES[key], final = path.join(SRC, key), dir = `${final}.new`, url = `https://github.com/${s.repo}.git`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  try { await clone(s, url, dir, paths); }
  catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(dir, final);
  return final;
}
async function clone(s, url, dir, paths) {
  if (s.whole) { await run('git', ['clone', '--depth', '1', '--quiet', url, dir]); return dir; }
  // Only the folders we need, not the whole repo.
  await run('git', ['clone', '--depth', '1', '--quiet', '--filter=blob:none', '--sparse', url, dir]);
  await run('git', ['sparse-checkout', 'set', '--no-cone', ...paths.map(p => `/${s.base}${p}/`), ...s.license.map(l => `/${l}`)], dir);
  return dir;
}

/** Download every skill source and build one plugin per dog. `log` gets progress lines.
 *  A source or skill that fails is logged and skipped; the rest still install. */
export async function installSkills(log = () => {}) {
  const need = {};
  for (const dog of Object.keys(DOG_SKILLS)) for (const [src, skill] of uniqueSkills(dog)) (need[src] ||= new Set()).add(skill);
  const dirs = {};
  for (const [key, skills] of Object.entries(need)) {
    log(`downloading ${SOURCES[key].repo}…`);
    try { dirs[key] = await fetchSource(key, [...skills]); }
    catch (e) { log(`  failed ${SOURCES[key].repo}: ${e.message}`); }
  }
  for (const dog of Object.keys(DOG_SKILLS)) {
    const out = pluginDir(dog);
    // A source this dog needs didn't download: keep its current skills rather than rebuild with gaps.
    const missing = [...new Set(uniqueSkills(dog).map(([k]) => k).filter(k => !dirs[k]))];
    if (missing.length && hasSkills(dog)) { log(`  kept ${dog}'s current skills (${missing.map(k => SOURCES[k].repo).join(', ')} did not download)`); continue; }
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.join(out, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(out, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: `kennel-${dog}`, version: '1.0.0', description: `Skills for ${dog} in Kennel HQ` }, null, 2));
    const credits = [];
    for (const [key, skill] of uniqueSkills(dog)) {
      const s = SOURCES[key];
      if (!dirs[key]) { log(`  skipped ${skill} for ${dog}: ${s.repo} did not download`); continue; }
      const from = s.whole ? dirs[key] : path.join(dirs[key], s.base, skill);
      const to = path.join(out, 'skills', skill);
      if (!fs.existsSync(path.join(from, 'SKILL.md'))) { log(`  skipped ${skill}: not found in ${s.repo}`); continue; }
      try {
        fs.cpSync(from, to, { recursive: true, filter: p => !/[\\/](\.git|\.github|\.claude|\.claude-plugin|node_modules)([\\/]|$)/.test(p.slice(from.length)) });
        for (const l of s.license) { const lp = path.join(dirs[key], l); if (fs.existsSync(lp)) fs.copyFileSync(lp, path.join(to, `${l}-upstream`)); }
        credits.push(`- ${skill}: https://github.com/${s.repo}`);
      } catch (e) {
        fs.rmSync(to, { recursive: true, force: true });
        log(`  failed ${skill} for ${dog}: ${e.message}`);
      }
    }
    fs.writeFileSync(path.join(out, 'CREDITS.md'), `# Skills for ${dog}\n\nThird-party skills, unchanged, with their original licenses alongside:\n${credits.join('\n')}\n`);
  }
  log('done');
}
