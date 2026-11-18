// Remote mode helpers: the LAN address, an access token, and a QR code drawn with half-blocks.
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const newToken = () => crypto.randomBytes(16).toString('hex');

/** Best guess at this machine's address on the local network (Wi-Fi / Ethernet). */
export function lanAddress() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^169\.254\./.test(a.address)) continue; // link-local, not reachable
      const virtual = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|docker|br-|veth|utun|tailscale/i.test(name)
        || /^192\.168\.56\./.test(a.address); // VirtualBox host-only network
      const wifi = /wi-?fi|wireless|wlan|^en0$|^eth0$/i.test(name);
      const score = (wifi ? 4 : 0)
        + (/^192\.168\./.test(a.address) ? 3 : /^10\./.test(a.address) ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 1 : 0)
        - (virtual ? 6 : 0);
      found.push({ address: a.address, score });
    }
  }
  found.sort((a, b) => b.score - a.score);
  return found[0]?.address || '127.0.0.1';
}

/** The QR code of `text` as rows of booleans (true = dark), for drawing in the browser. */
export function qrMatrix(text) {
  let QRCode, Level;
  try {
    QRCode = require('qrcode-terminal/vendor/QRCode');
    Level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
  } catch { return null; }
  const qr = new QRCode(-1, Level.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** Terminal rows for a QR code of `text` (two modules per character row, with a quiet zone). */
export function qrLines(text) {
  let QRCode, Level;
  try {
    QRCode = require('qrcode-terminal/vendor/QRCode');
    Level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
  } catch { return null; }
  const qr = new QRCode(-1, Level.L);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), q = 2;
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -q; r < n + q; r += 2) {
    let s = '\x1b[38;2;255;255;255m\x1b[48;2;0;0;0m';
    for (let c = -q; c < n + q; c++) {
      const top = !dark(r, c), bottom = !dark(r + 1, c); // light modules are drawn white
      s += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(s + '\x1b[0m');
  }
  return lines;
}
