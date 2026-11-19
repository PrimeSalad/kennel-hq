// The office's pixel dogs, drawn in the terminal with half-block characters (two pixels per cell).
// Same art as drawSit() in public/index.html.
const LOOKS = {
  chou: { fur: '#e8893a', fur2: '#c46e27', light: '#fff3df', ear: 'pointy', earIn: '#f4a3a3', mask: 'blaze', tail: 'stub', paws: '#fff3df' },
  harley: { fur: '#26212b', fur2: '#16121a', light: '#fbf8f2', face: '#fbf8f2', patch: '#26212b', ear: 'long', bow: true, beard: true, tail: 'plume', tailC: '#26212b' },
  bacon: { fur: '#f8f5ef', fur2: '#e4ddd0', light: '#ffffff', patch: '#efe8dc', ear: 'long', spots: '#a0673a', beard: true, tail: 'plume', tailC: '#f8f5ef' },
  pitchie: { fur: '#f7f4ee', fur2: '#e2dccf', light: '#ffffff', ear: 'small', mane: true, tail: 'plume', tailC: '#ffffff' },
  tiger: { fur: '#b36a32', fur2: '#2b2228', light: '#fff8ee', patch: '#8a4f26', ear: 'long', mask: 'blaze', saddle: true, tail: 'thin', paws: '#fff8ee' },
  asky: { fur: '#9a6338', fur2: '#7a4a28', light: '#c98e5c', patch: '#7a4a28', ear: 'long', topknot: true, topknotC: '#b0784a', bow: true, bowC: '#e879f9', beard: true, tail: 'plume', tailC: '#b97c4c' },
  biscuit: { fur: '#e0a84f', fur2: '#c48a35', light: '#f6d595', ear: 'floppy', tail: 'plume', tailC: '#e0a84f', pencil: true },
  lucifur: { fur: '#2a2430', fur2: '#17131c', light: '#b5653a', ear: 'tall', earIn: '#4a3a52', chest: false, brows: true, evil: true, horns: true, spikes: true, tail: 'devil', paws: '#b5653a' },
};
const OUTLINE = '#24191f';

function sitGrid(id) {
  const d = LOOKS[id];
  const W = 24, H = 26;
  const g = Array.from({ length: H }, () => Array(W).fill(null));
  const P = (c, x, y, w = 1, h = 1) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const X = xx + 1, Y = yy + 1;
      if (X >= 0 && X < W && Y >= 0 && Y < H) g[Y][X] = c;
    }
  };
  const S = (c, x, y, w = 1, h = 1) => P(c, x, y + 2, w, h);
  const M = (c, x, y, w = 1, h = 1) => { S(c, x, y, w, h); S(c, 22 - x - w, y, w, h); };
  const f = d.fur, f2 = d.fur2, l = d.light, dk = '#2b1e24', pk = '#f39aa8';
  if (d.tail === 'plume') { S(d.tailC || l, 16, 11, 4, 4); S(d.tailC || l, 17, 10, 3, 1); }
  if (d.tail === 'curl') { S(f, 16, 11, 3, 3); S(l, 17, 12, 1, 1); }
  if (d.tail === 'devil') { S(f, 16, 12, 2, 3); S(f, 17, 10, 1, 2); S('#d32f2f', 16, 8, 3, 2); S('#d32f2f', 17, 7, 1, 1); }
  if (d.topknot) { const tk = d.topknotC || d.light; S(tk, 7, -1, 8, 4); S(tk, 8, -2, 6, 1); S(d.fur2, 8, 1, 6, 1); }
  if (d.ear === 'tall') {
    M(f, 5, -3, 2, 1); M(f, 4, -2, 3, 1); M(f, 4, -1, 4, 1); M(f, 4, 0, 4, 1); M(f, 4, 1, 5, 1); M(f, 5, 2, 4, 1);
    M(d.earIn, 5, -1, 1, 2); M(d.earIn, 6, 1, 1, 1);
  }
  if (d.mane) { S(f2, 3, 3, 16, 13); S(f2, 4, 2, 14, 1); S(f2, 4, 16, 14, 1); M(f2, 2, 5, 1, 3); M(f2, 2, 10, 1, 3); M(l, 4, 12, 2, 3); }
  if (d.ear === 'pointy') {
    M(f, 4, -2, 2, 1); M(f, 4, -1, 3, 1); M(f, 4, 0, 4, 1); M(f, 4, 1, 5, 1); M(f, 5, 2, 4, 1);
    M(d.earIn, 5, -1, 1, 1); M(d.earIn, 5, 0, 2, 1); M(d.earIn, 6, 1, 2, 1);
  }
  if (d.ear === 'small') { M(f, 5, 0, 2, 1); M(f, 5, 1, 3, 1); M(f, 5, 2, 4, 1); M(f2, 6, 1, 1, 1); }
  S(f, 6, 12, 10, 1); S(f, 5, 13, 12, 7); S(f, 6, 20, 10, 1); M(f2, 5, 15, 1, 5);
  if (d.chest !== false) { S(l, 8, 13, 6, 6); S(l, 9, 19, 4, 1); }
  const pc = d.paws || f; S(pc, 7, 20, 3, 2); S(pc, 12, 20, 3, 2);
  const hf = d.face || f; S(hf, 6, 3, 10, 1); S(hf, 5, 4, 12, 7); S(hf, 6, 11, 10, 1); S(hf, 7, 12, 8, 1);
  if (d.ear === 'floppy') { M(f2, 3, 4, 3, 6); M(f2, 2, 6, 1, 4); M(f2, 4, 10, 2, 1); }
  if (d.ear === 'long') { M(d.patch, 3, 3, 3, 9); M(d.patch, 2, 5, 1, 7); M(d.patch, 4, 12, 2, 1); }
  if (d.mask === 'blaze') S(l, 10, 3, 2, 5);
  if (d.mask === 'husky') { S(l, 6, 8, 10, 3); S(l, 7, 11, 8, 2); M(l, 7, 5, 2, 1); }
  if (d.mask === 'eyepatch') { M(d.patch, 6, 5, 4, 3); S(l, 10, 3, 2, 5); }
  S(l, 8, 8, 6, 3); S(l, 9, 11, 4, 1);
  if (d.beard) { S(l, 7, 10, 8, 3); S(l, 8, 13, 6, 2); }
  if (d.brows) { M(l, 6, 4, 2, 1); M(l, 8, 5, 2, 1); }
  if (d.evil) { M('#ff3030', 7, 6, 2, 2); M('#ffb4b4', 7, 6, 1, 1); M('#7a0000', 8, 7, 1, 1); }
  else { M(dk, 7, 6, 2, 2); if (d.eye) M(d.eye, 7, 7, 2, 1); S('#ffffff', 7, 6); S('#ffffff', 13, 6); }
  if (d.glasses) { const gl = "#c026d3"; M(gl, 6, 5, 4, 1); M(gl, 6, 8, 4, 1); M(gl, 6, 6, 1, 2); M(gl, 9, 6, 1, 2); S(gl, 10, 6, 2, 1); }
  S(dk, 10, 8, 2, 2); if (d.longNose) S(dk, 9, 8, 4, 1);
  if (d.evil) { S(dk, 9, 10, 4, 1); S('#ffffff', 9, 11, 1, 1); S('#ffffff', 12, 11, 1, 1); }
  else { S(pk, 10, 10, 2, 2); S('#e0677c', 10, 11, 2, 1); M(pk, 6, 9, 1, 1); }
  if (d.horns) { M('#b71c1c', 8, 1, 2, 2); M('#ef5350', 8, 0, 1, 1); }
  if (d.spikes) { S('#3a3340', 6, 12, 10, 1); for (const x of [7, 10, 13]) { S('#d7d3e0', x, 12, 1, 1); S('#d7d3e0', x, 13, 1, 1); } }
  if (d.spots) { for (const [x, y] of [[6, 14], [14, 15], [9, 18], [15, 19], [6, 19]]) S(d.spots, x, y, 2, 1); S(d.spots, 14, 4, 2, 2); }
  if (d.saddle) { S(f2, 5, 14, 2, 5); S(f2, 15, 14, 2, 5); }
  if (d.pencil) { S('#facc15', 16, 1, 1, 4); S('#f39aa8', 16, 0, 1, 1); S('#2b1e24', 16, 5, 1, 1); }
  if (d.bow) { S(d.patch, 9, 2, 4, 2); S(d.bowC || '#e23d5a', 8, 0, 2, 2); S(d.bowC || '#e23d5a', 12, 0, 2, 2); S('#a51f3a', 10, 1, 2, 1); }
  // 1px outline around the shape
  const filled = g.map(r => r.map(Boolean));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (filled[y][x]) continue;
    if ((x > 0 && filled[y][x - 1]) || (x < W - 1 && filled[y][x + 1]) || (y > 0 && filled[y - 1][x]) || (y < H - 1 && filled[y + 1][x])) g[y][x] = OUTLINE;
  }
  return g;
}

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const fg = h => `\x1b[38;2;${hex(h).join(';')}m`;
const bg = h => `\x1b[48;2;${hex(h).join(';')}m`;

// Each dog's desk in the terminal: what sits on the left and right of the desk, and the name-card colour.
// Same props as the web office: developers get a monitor, Bacon a DB rack, Chou a whiteboard.
const MONITOR = [['#24202f', '#79c7ff', '#ff8fc0', '#24202f'], [null, '#3a3548', '#3a3548', null]];
const MUG = [[null, null, null, null], [null, '#f1e7d6', '#f1e7d6', null]];
const DESKS = {
  chou: { color: '#ffb347', left: MONITOR, right: [['#fbf8f2', '#ffb347', '#79c7ff', '#7ee0b0'], ['#9a92ad', '#5e5a72', '#5e5a72', '#9a92ad']] },
  harley: { color: '#b69cff', left: MONITOR, right: [[null, '#4fa36b', '#62bb7e', null], [null, '#c46a4a', '#c46a4a', null]] },
  asky: { color: '#e879f9', left: MUG, right: [['#e879f9', '#79c7ff', '#ffe28a', '#fff7ee'], ['#fff7ee', '#fff7ee', '#fff7ee', '#fff7ee']] },
  bacon: { color: '#ff7a5c', left: MUG, right: [['#ff9d6b', '#ff7a5c', '#ff7a5c', '#ff9d6b'], ['#2c2638', '#7ee0b0', '#ffb347', '#2c2638']] },
  pitchie: { color: '#7ee0b0', left: MUG, right: [['#f6f3ec', '#7ee0b0', '#f6f3ec', '#ff6b6b'], ['#ff6b6b', '#ff6b6b', '#ff6b6b', '#ff6b6b']] },
  tiger: { color: '#79c7ff', left: MUG, right: [['#2c2638', '#7ee0b0', '#ffb347', '#2c2638'], ['#2c2638', '#79c7ff', '#7ee0b0', '#2c2638']] },
  biscuit: { color: '#2dd4bf', left: MUG, right: [['#2dd4bf', '#ffe28a', '#79c7ff', '#ff8fc0'], ['#2dd4bf', '#ffe28a', '#79c7ff', '#ff8fc0']] },
  lucifur: { color: '#ef4444', gothic: true, left: [[null, '#ffd27a', null, null], [null, '#f1e7d6', null, null]], right: [['#7a1a2a', '#3a2a5a', '#1f4a3a', null], ['#7a1a2a', '#3a2a5a', '#1f4a3a', null]] },
};

/** Two terminal rows (four pixel rows) of desk for `id`, 11 columns wide: props, then the desk top and front. */
function deskRows(id) {
  const k = DESKS[id] || { color: '#a497b3', left: MUG, right: MUG };
  const top = k.gothic ? '#3a2a40' : '#c48a58', front = k.gothic ? '#1f1726' : '#7b4d30';
  const px = Array.from({ length: 4 }, () => Array(11).fill(null));
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) { px[r][c] = k.left[r][c]; px[r][7 + c] = k.right[r][c]; }
  px[2].fill(top); px[3].fill(front);
  for (let c = 4; c < 7; c++) px[3][c] = c === 4 ? k.color : '#e9dcb8'; // name card on the desk front
  const lines = [];
  for (let y = 0; y < 4; y += 2) {
    let s = '';
    for (let x = 0; x < 11; x++) {
      const t = px[y][x], b = px[y + 1][x];
      if (!t && !b) s += '\x1b[0m ';
      else if (t && !b) s += `\x1b[0m${fg(t)}▀`;
      else if (!t && b) s += `\x1b[0m${fg(b)}▄`;
      else s += `${fg(t)}${bg(b)}▀`;
    }
    lines.push(s + '\x1b[0m');
  }
  return lines;
}

/** A small version: half-size head, 11 columns × 5 rows, sitting behind its role desk (2 more rows) unless `desk` is false. */
export function mini(id, { desk = true } = {}) {
  return desk ? [...head(id), ...deskRows(id)] : head(id);
}

function head(id) {
  const g = sitGrid(id);
  const pick = (x, y) => {
    // keep the most important pixel of each 2×2 block: eyes and nose win, then anything not outline
    const cells = [g[y]?.[x], g[y]?.[x + 1], g[y + 1]?.[x], g[y + 1]?.[x + 1]].filter(Boolean);
    const special = cells.find(c => /^#(2b1e24|ff3030|5fb4ff|c026d3|ffffff)$/i.test(c));
    return special || cells.find(c => c !== OUTLINE) || cells[0] || null;
  };
  const small = [];
  for (let y = 0; y < 20; y += 2) { const row = []; for (let x = 1; x < 23; x += 2) row.push(pick(x, y)); small.push(row); }
  const lines = [];
  for (let y = 0; y < small.length; y += 2) {
    let s = '';
    for (let x = 0; x < small[0].length; x++) {
      const t = small[y][x], b = small[y + 1]?.[x];
      if (!t && !b) s += '\x1b[0m ';
      else if (t && !b) s += `\x1b[0m${fg(t)}▀`;
      else if (!t && b) s += `\x1b[0m${fg(b)}▄`;
      else s += `${fg(t)}${bg(b)}▀`;
    }
    lines.push(s + '\x1b[0m');
  }
  return lines;
}

/** Terminal rows for one dog's portrait (head and chest), `cols` wide. */
export function portrait(id, { x0 = 1, cols = 22, y0 = 0, rows = 20 } = {}) {
  const g = sitGrid(id);
  const lines = [];
  for (let y = y0; y < y0 + rows; y += 2) {
    let s = '';
    for (let x = x0; x < x0 + cols; x++) {
      const t = g[y]?.[x], b = g[y + 1]?.[x];
      if (!t && !b) s += '\x1b[0m ';
      else if (t && !b) s += `\x1b[0m${fg(t)}▀`;
      else if (!t && b) s += `\x1b[0m${fg(b)}▄`;
      else s += `${fg(t)}${bg(b)}▀`;
    }
    lines.push(s + '\x1b[0m');
  }
  return lines;
}
