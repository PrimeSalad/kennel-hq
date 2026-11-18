// Each dog's skills: picked from popular open-source skill repos, downloaded once from GitHub into ~/.kennel,
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
};

// [source, skill folder]
export const DOG_SKILLS = {
  chou: [['superpowers', 'writing-plans'], ['superpowers', 'brainstorming'], ['superpowers', 'requesting-code-review'], ['superpowers', 'receiving-code-review']],
  harley: [['superpowers', 'test-driven-development'], ['superpowers', 'systematic-debugging'], ['superpowers', 'verification-before-completion'],
    ['caveman', 'surgical-patch'], ['caveman', 'safe-refactor'], ['caveman', 'investigate-first']],
  asky: [['uipro', 'ui-ux-pro-max'], ['uipro', 'design-system'], ['uipro', 'ui-styling'], ['anthropic', 'frontend-design'], ['anthropic', 'theme-factory']],
  bacon: [['pgaiguide', 'postgres'], ['pgaiguide', 'design-postgres-tables'], ['pgaiguide', 'postgres-database-migration'], ['pgaiguide', 'schema-exploration'], ['caveman', 'migration']],
  pitchie: [['anthropic', 'webapp-testing'], ['superpowers', 'test-driven-development'], ['superpowers', 'verification-before-completion'], ['caveman', 'verify-and-stop']],
  tiger: [['terrashark', 'terrashark'], ['superpowers', 'finishing-a-development-branch'], ['caveman', 'lean-build'], ['caveman', 'verify-and-stop']],
  biscuit: [['humanizer', 'humanizer']],
  lucifur: [['superpowers', 'systematic-debugging'], ['caveman', 'investigate-first']],
};

export const skillNames = dog => (DOG_SKILLS[dog] || []).map(([, s]) => s);
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
  const s = SOURCES[key], dir = path.join(SRC, key), url = `https://github.com/${s.repo}.git`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  if (s.whole) { await run('git', ['clone', '--depth', '1', '--quiet', url, dir]); return dir; }
  // Only the folders we need, not the whole repo.
  await run('git', ['clone', '--depth', '1', '--quiet', '--filter=blob:none', '--sparse', url, dir]);
  await run('git', ['sparse-checkout', 'set', '--no-cone', ...paths.map(p => `/${s.base}${p}/`), ...s.license.map(l => `/${l}`)], dir);
  return dir;
}

/** Download every skill source and build one plugin per dog. `log` gets progress lines. */
export async function installSkills(log = () => {}) {
  const need = {};
  for (const list of Object.values(DOG_SKILLS)) for (const [src, skill] of list) (need[src] ||= new Set()).add(skill);
  const dirs = {};
  for (const [key, skills] of Object.entries(need)) {
    log(`downloading ${SOURCES[key].repo}…`);
    dirs[key] = await fetchSource(key, [...skills]);
  }
  for (const [dog, list] of Object.entries(DOG_SKILLS)) {
    const out = pluginDir(dog);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.join(out, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(out, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: `kennel-${dog}`, version: '1.0.0', description: `Skills for ${dog} in Kennel HQ` }, null, 2));
    const credits = [];
    for (const [key, skill] of list) {
      const s = SOURCES[key];
      const from = s.whole ? dirs[key] : path.join(dirs[key], s.base, skill);
      const to = path.join(out, 'skills', skill);
      if (!fs.existsSync(path.join(from, 'SKILL.md'))) { log(`  skipped ${skill}: not found in ${s.repo}`); continue; }
      fs.cpSync(from, to, { recursive: true, filter: p => !/[\\/](\.git|\.github|\.claude|\.claude-plugin|node_modules)([\\/]|$)/.test(p.slice(from.length)) });
      for (const l of s.license) { const lp = path.join(dirs[key], l); if (fs.existsSync(lp)) fs.copyFileSync(lp, path.join(to, `${l}-upstream`)); }
      credits.push(`- ${skill}: https://github.com/${s.repo}`);
    }
    fs.writeFileSync(path.join(out, 'CREDITS.md'), `# Skills for ${dog}\n\nThird-party skills, unchanged, with their original licenses alongside:\n${credits.join('\n')}\n`);
  }
  log('done');
}
