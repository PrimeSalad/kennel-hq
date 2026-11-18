// A small Claude-Code-style terminal UI with no dependencies:
// a scrolling transcript, a live status block, a bordered input box and a hint line, redrawn in place.
import readline from 'node:readline';

const E = '\x1b[';
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const strip = s => String(s).replace(ANSI, '');
const wide = cp => cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff));
export function width(s) { let w = 0; for (const ch of strip(s)) w += wide(ch.codePointAt(0)) ? 2 : 1; return w; }
export function fit(s, max) {
  if (width(s) <= max) return s;
  let out = '', w = 0;
  for (const m of String(s).matchAll(/(\x1b\[[0-9;?]*[ -/]*[@-~])|([\s\S])/gu)) {
    if (m[1]) { out += m[1]; continue; }
    const cw = wide(m[2].codePointAt(0)) ? 2 : 1;
    if (w + cw > max - 1) break;
    out += m[2]; w += cw;
  }
  return out + '…\x1b[0m';
}
export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));

const rgb = (r, g, b) => s => `${E}38;2;${r};${g};${b}m${s}${E}39m`;
const gray = rgb(110, 102, 128);
const dimc = rgb(140, 132, 158);

/**
 * opts: {
 *   placeholder: string,
 *   status(frame, cols): string[]   lines shown above the input box
 *   footer(cols, hint): string       the hint line under the box
 *   busy(): boolean                  animate while true
 *   complete(text): string[]         completions for the current input
 *   onSubmit(line), onExit()
 * }
 */
export function createTUI(opts) {
  const out = process.stdout, inp = process.stdin;
  const interactive = Boolean(out.isTTY && inp.isTTY);

  if (!interactive) {
    // Pipes, Git Bash (mintty) and the like: plain line mode.
    const rl = readline.createInterface({ input: inp, output: out, prompt: 'kennel > ' });
    rl.on('line', l => opts.onSubmit(l));
    rl.on('close', () => opts.onExit());
    return {
      interactive,
      log(s) { console.log(strip(s)); },
      start() { rl.prompt(); },
      restore() {},
    };
  }

  let chars = [], cur = 0, history = [], hi = -1, draft = null;
  let drawn = 0, cursorRow = 0, frame = 0, hint = '', hintTimer = null, lastCtrlC = 0, pasting = false;
  let pending = [], scheduled = false, started = false, closed = false;

  const flash = (msg, ms = 2500) => { hint = msg; clearTimeout(hintTimer); hintTimer = setTimeout(() => { hint = ''; schedule(); }, ms); schedule(); };

  function region() {
    const cols = Math.max(30, (out.columns || 100) - 1);
    const lines = [];
    const st = opts.status(frame, cols);
    if (st.length) lines.push(...st.map(l => fit(l, cols)), '');
    const inner = cols - 4;          // "│ " … " │"
    const avail = inner - 2;         // minus "> "
    let shown, curCol;
    if (!chars.length) { shown = dimc(fit(opts.placeholder, avail)); curCol = 0; }
    else {
      let start = 0;
      while (width(chars.slice(start, cur).join('')) > avail - 1) start++;
      let end = start, w = 0;
      while (end < chars.length && w + width(chars[end]) <= avail) { w += width(chars[end]); end++; }
      shown = chars.slice(start, end).join('');
      curCol = width(chars.slice(start, cur).join(''));
    }
    lines.push(gray(`╭${'─'.repeat(cols - 2)}╮`));
    const inputRow = lines.length;
    lines.push(`${gray('│')} ${rgb(255, 179, 71)('>')} ${pad(shown, avail)} ${gray('│')}`);
    lines.push(gray(`╰${'─'.repeat(cols - 2)}╯`));
    lines.push(fit(opts.footer(cols, hint), cols));
    return { lines, inputRow, inputCol: 4 + curCol };
  }

  const clearSeq = () => (drawn ? `${cursorRow ? `${E}${cursorRow}A` : ''}\r${E}0J` : '');

  function flush() {
    scheduled = false;
    if (closed) return;
    const { lines, inputRow, inputCol } = region();
    let s = `${E}?25l${clearSeq()}`;
    if (pending.length) { s += pending.join('\n') + '\n'; pending = []; }
    s += lines.join('\n');
    const up = lines.length - 1 - inputRow;
    if (up) s += `${E}${up}A`;
    s += `\r${E}${inputCol + 1}G${E}?25h`;
    out.write(s);
    drawn = lines.length; cursorRow = inputRow;
  }
  function schedule() { if (!scheduled && started) { scheduled = true; setImmediate(flush); } }

  function setText(t) { chars = [...t]; cur = chars.length; }
  function insert(t) { const add = [...t]; chars.splice(cur, 0, ...add); cur += add.length; }

  function submit() {
    const line = chars.join('').trim();
    chars = []; cur = 0; hi = -1; draft = null;
    if (!line) { schedule(); return; }
    if (history[history.length - 1] !== line) history.push(line);
    pending.push('', `${E}48;2;48;42;58m${E}38;2;225;216;235m > ${line} ${E}0m`);
    schedule();
    opts.onSubmit(line);
  }

  function complete() {
    const text = chars.join('');
    const options = opts.complete(text);
    if (options.length === 1) setText(options[0]);
    else if (options.length > 1) {
      let common = options[0];
      for (const o of options) while (!o.startsWith(common)) common = common.slice(0, -1);
      if (common.length > text.length) setText(common);
      flash(options.map(o => o.trim()).join('   '), 4000);
    }
  }

  function exit() {
    if (closed) return;
    restore();
    opts.onExit();
  }
  function restore() {
    if (closed) return;
    closed = true;
    out.write(`${clearSeq()}${E}?2004l${E}?25h`);
    try { inp.setRawMode(false); } catch { /* fine */ }
  }

  function onKey(str, key = {}) {
    if (key.name === 'paste-start') { pasting = true; return; }
    if (key.name === 'paste-end') { pasting = false; schedule(); return; }
    if (pasting) { if (str) insert(str.replace(/\r\n|\r|\n/g, ' ')); return schedule(); }

    if (key.ctrl && key.name === 'c') {
      if (chars.length) { chars = []; cur = 0; }
      else if (Date.now() - lastCtrlC < 1500) return exit();
      else { lastCtrlC = Date.now(); flash(rgb(255, 179, 71)('Press Ctrl+C again to exit'), 1500); }
      return schedule();
    }
    if (key.ctrl && key.name === 'd') { if (!chars.length) return exit(); }

    switch (key.name) {
      case 'return': case 'enter': return submit();
      case 'backspace':
        if (key.ctrl || key.meta) { const end = cur; while (cur > 0 && chars[cur - 1] === ' ') cur--; while (cur > 0 && chars[cur - 1] !== ' ') cur--; chars.splice(cur, end - cur); }
        else if (cur > 0) { chars.splice(cur - 1, 1); cur--; }
        break;
      case 'delete': chars.splice(cur, 1); break;
      case 'left':
        if (key.ctrl || key.meta) { while (cur > 0 && chars[cur - 1] === ' ') cur--; while (cur > 0 && chars[cur - 1] !== ' ') cur--; }
        else cur = Math.max(0, cur - 1);
        break;
      case 'right':
        if (key.ctrl || key.meta) { while (cur < chars.length && chars[cur] === ' ') cur++; while (cur < chars.length && chars[cur] !== ' ') cur++; }
        else cur = Math.min(chars.length, cur + 1);
        break;
      case 'home': cur = 0; break;
      case 'end': cur = chars.length; break;
      case 'up':
        if (!history.length) break;
        if (hi === -1) { draft = chars.join(''); hi = history.length; }
        hi = Math.max(0, hi - 1); setText(history[hi]);
        break;
      case 'down':
        if (hi === -1) break;
        hi++;
        if (hi >= history.length) { hi = -1; setText(draft || ''); } else setText(history[hi]);
        break;
      case 'tab': complete(); break;
      case 'escape': chars = []; cur = 0; break;
      default:
        if (key.ctrl) {
          if (key.name === 'a') cur = 0;
          else if (key.name === 'e') cur = chars.length;
          else if (key.name === 'u') { chars.splice(0, cur); cur = 0; }
          else if (key.name === 'k') chars.splice(cur);
          else if (key.name === 'w') { const end = cur; while (cur > 0 && chars[cur - 1] === ' ') cur--; while (cur > 0 && chars[cur - 1] !== ' ') cur--; chars.splice(cur, end - cur); }
          else if (key.name === 'l') { out.write(`${E}2J${E}3J${E}H`); drawn = 0; }
        } else if (str && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) insert(str);
    }
    schedule();
  }

  return {
    interactive,
    log(s) { pending.push(s); schedule(); },
    start() {
      readline.emitKeypressEvents(inp);
      inp.setRawMode(true);
      inp.resume();
      inp.on('keypress', onKey);
      out.write(`${E}?2004h`); // bracketed paste: a pasted block arrives as text, not as many Enters
      out.on('resize', () => { out.write(`\r${E}0J`); drawn = 0; schedule(); });
      setInterval(() => { if (opts.busy()) { frame++; schedule(); } }, 110).unref();
      started = true;
      schedule();
    },
    restore,
  };
}
