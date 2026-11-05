// Génère les icônes PNG de l'appli (dégradé violet → cyan + ballon blanc), sans dépendance.
// Usage : node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // suréchantillonnage 4x4 pour des bords lisses
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const p = pixel((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size);
        r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3];
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0; raw[o + 3] = a / 16;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const lerp = (a, b, t) => a + (b - a) * t;
const VIOLET = [139, 92, 246], INDIGO = [99, 102, 241], CYAN = [34, 211, 238], DARK = [20, 24, 51];
function gradient(x, y) {
  const t = Math.min(1, Math.max(0, (x * 0.6 + y * 0.4)));
  const [c1, c2, u] = t < 0.45 ? [VIOLET, INDIGO, t / 0.45] : [INDIGO, CYAN, (t - 0.45) / 0.55];
  return c1.map((v, i) => lerp(v, c2[i], u));
}
function insidePolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const pentagon = (cx, cy, r, rot = -Math.PI / 2) => Array.from({ length: 5 }, (_, i) => [cx + r * Math.cos(rot + (i * 2 * Math.PI) / 5), cy + r * Math.sin(rot + (i * 2 * Math.PI) / 5)]);

// ballon : disque blanc, pentagone central + 5 pentagones coupés au bord
function ball(x, y, cx, cy, R) {
  const d = Math.hypot(x - cx, y - cy);
  if (d > R) return null;
  if (insidePolygon(x, y, pentagon(cx, cy, R * 0.34))) return DARK;
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5 + Math.PI / 5;
    if (insidePolygon(x, y, pentagon(cx + Math.cos(a) * R * 0.86, cy + Math.sin(a) * R * 0.86, R * 0.3, a + Math.PI))) return DARK;
  }
  if (d > R * 0.95) return [225, 228, 245];
  return [255, 255, 255];
}

// maskable = fond plein (zone de sécurité 80 %) ; any = carré arrondi
function icon(maskable) {
  return (x, y) => {
    if (!maskable) {
      const r = 0.22, qx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0), qy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
      if (Math.hypot(qx, qy) > r) return [0, 0, 0, 0];
    }
    const b = ball(x, y, 0.5, 0.5, maskable ? 0.27 : 0.33);
    return [...(b || gradient(x, y)), 255];
  };
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true], ['favicon-32.png', 32, false]]) {
  fs.writeFileSync(path.join(out, name), png(size, icon(maskable)));
  console.log('✔', name);
}
