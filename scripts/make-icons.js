#!/usr/bin/env node
// Draws Critique's icons as PNGs into desktop/assets, so there are no binary design files to maintain:
//   trayTemplate.png / @2x  menu bar icon (black + alpha; macOS tints it for light/dark menu bars)
//   icon.png                1024px app icon (electron-builder turns it into the .icns)
//   dot-{red,yellow,green}[-seen].png / @2x  status dots for menu items (filled = unseen activity)
// The glyph is a check mark in a circle: a green tile with a white circle and green check for the app,
// and a solid circle with the check cut out for the menu bar.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const outDir = join(import.meta.dirname, '..', 'desktop', 'assets');

// --- Minimal PNG encoder (RGBA, no interlace) ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Drawing: layers of shapes in unit coordinates (0..1), 4x4 supersampled ---

const SAMPLES = 4;
function render(size, layers) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (const { inside, color } of layers) {
        let hits = 0;
        for (let sy = 0; sy < SAMPLES; sy++) {
          for (let sx = 0; sx < SAMPLES; sx++) {
            if (inside((x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size)) hits++;
          }
        }
        const cov = (hits / SAMPLES ** 2) * (color[3] / 255);
        // "over" compositing
        const outA = cov + a * (1 - cov);
        if (outA > 0) {
          r = (color[0] * cov + r * a * (1 - cov)) / outA;
          g = (color[1] * cov + g * a * (1 - cov)) / outA;
          b = (color[2] * cov + b * a * (1 - cov)) / outA;
        }
        a = outA;
      }
      px.set([Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)], (y * size + x) * 4);
    }
  }
  return encodePng(size, px);
}

const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);
const ring = (cx, cy, r, w) => (x, y) => Math.abs(dist(x, y, cx, cy) - r) <= w / 2;
const disc = (cx, cy, r) => (x, y) => dist(x, y, cx, cy) <= r;
const roundedSquare = (inset, radius) => (x, y) => {
  const lo = inset + radius;
  const hi = 1 - inset - radius;
  const dx = Math.max(lo - x, 0, x - hi);
  const dy = Math.max(lo - y, 0, y - hi);
  return x >= inset && x <= 1 - inset && y >= inset && y <= 1 - inset && Math.hypot(dx, dy) <= radius;
};

// A thick polyline with round joins: inside if within width/2 of any segment.
const stroke = (points, width) => (x, y) =>
  points.slice(1).some(([x2, y2], i) => {
    const [x1, y1] = points[i];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= width / 2;
  });
// Check mark centered on the circle, scaled by its radius.
const check = (cx, cy, r, width) =>
  stroke(
    [
      [cx - 0.5 * r, cy + 0.02 * r],
      [cx - 0.15 * r, cy + 0.38 * r],
      [cx + 0.52 * r, cy - 0.35 * r],
    ],
    width,
  );

const BLACK = [0, 0, 0, 255];
const GREEN = [30, 142, 62, 255];
const WHITE = [255, 255, 255, 255];
const trayCircle = disc(0.5, 0.5, 0.44);
const trayCheck = check(0.5, 0.5, 0.44, 0.13);
const tray = [{ inside: (x, y) => trayCircle(x, y) && !trayCheck(x, y), color: BLACK }];
const app = [
  { inside: roundedSquare(0.1, 0.18), color: GREEN },
  { inside: disc(0.5, 0.5, 0.27), color: WHITE },
  { inside: check(0.5, 0.5, 0.27, 0.075), color: GREEN },
];

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'trayTemplate.png'), render(16, tray));
writeFileSync(join(outDir, 'trayTemplate@2x.png'), render(32, tray));
writeFileSync(join(outDir, 'icon.png'), render(1024, app));

// Mid-tone colors that read on both light and dark menus.
const DOTS = { red: [229, 83, 75, 255], yellow: [212, 160, 23, 255], green: [45, 164, 78, 255] };
for (const [name, color] of Object.entries(DOTS)) {
  const filled = [{ inside: disc(0.5, 0.5, 0.3), color }];
  const seen = [{ inside: ring(0.5, 0.5, 0.25, 0.1), color }];
  for (const [suffix, size] of [['', 16], ['@2x', 32]]) {
    writeFileSync(join(outDir, `dot-${name}${suffix}.png`), render(size, filled));
    writeFileSync(join(outDir, `dot-${name}-seen${suffix}.png`), render(size, seen));
  }
}
console.log(`Wrote icons to ${outDir}`);
