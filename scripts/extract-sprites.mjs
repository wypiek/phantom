#!/usr/bin/env node
/**
 * Noli sprite extractor.
 *
 * Source: assets-src/noli-sheet.webp (1536×1024, true alpha). The sheet is a
 * labelled collage, so frames are found automatically: section labels are
 * erased, connected components are grouped per section (the largest N blobs
 * are bodies; floating sparkles, "?", "!", particles attach to the nearest
 * body), and every frame is bottom-anchored on its feet so animations never jump.
 *
 * Writes:
 *   public/sprites/noli-sheet.png         – the source sheet (lossless copy)
 *   public/sprites/noli-animations.json   – "noli-companion-atlas-v1": exact source
 *                                           rects + fps/loop/anchor per animation
 *   public/sprites/phantom-atlas.png/json – runtime atlas (uniform cells, faces, sections)
 *   public/sprites/ui-atlas.png/json      – extras (stars, particles, heart, ?, !, bubble)
 *   public/sprites/portrait.png           – large still used by onboarding/settings/icon
 *
 * Usage: node scripts/extract-sprites.mjs [--preview out.png]
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'assets-src/noli-sheet.webp');
const OUT = path.join(ROOT, 'public/sprites');
const previewArg = process.argv.indexOf('--preview');
const PREVIEW = previewArg > 0 ? process.argv[previewArg + 1] : null;

/**
 * Sections in sheet order. rect = [x0, y0, x1, y1] (a blob's centre must fall inside),
 * count = number of figures. fps/loop are defaults for the animation JSON.
 */
const SECTIONS = [
  { name: 'idle', rect: [0, 25, 680, 150], count: 8, fps: 4, loop: true, description: 'Full-body front-facing idle variants; subtle pose loop.' },
  { name: 'blink_eyes_overlay', rect: [680, 25, 1070, 150], count: 5, fps: 8, loop: false, anchor: 'center', renderAs: 'head_overlay', description: 'Head-only eye variants. Overlays, not full-body frames.' },
  { name: 'look_directions', rect: [1070, 25, 1536, 150], count: 6, fps: 3, loop: false, description: 'Looking left/right/up/down.' },
  { name: 'movement', rect: [0, 172, 700, 300], count: 9, fps: 9, loop: true, description: 'Walk cycle, facing right.' },
  { name: 'idle_actions', rect: [700, 172, 1115, 300], count: 5, fps: 3, loop: true, description: 'Weight shifts and small idle movements.' },
  { name: 'gestures', rect: [1115, 172, 1536, 300], count: 6, fps: 5, loop: false, description: 'Waves and hand gestures.' },
  { name: 'speaking', rect: [0, 328, 560, 470], count: 7, fps: 6, loop: true, description: 'Talking poses with speech marks.' },
  { name: 'thinking_confused', rect: [560, 328, 1025, 470], count: 5, fps: 2, loop: true, description: 'Thinking; frames 2–3 carry a question mark.' },
  { name: 'emotions', rect: [1025, 328, 1536, 470], count: 7, fps: 2, loop: false, description: 'Excited, annoyed, happy, content, surprised, shocked, wide-eyed.' },
  { name: 'interactions', rect: [0, 498, 630, 630], count: 7, fps: 5, loop: false, description: 'Reaching, waving, crouching, lying down.' },
  { name: 'reacting', rect: [630, 498, 1085, 630], count: 5, fps: 4, loop: false, description: 'Alert "!" reaction and recoveries.' },
  { name: 'hurt_sad', rect: [1085, 498, 1536, 630], count: 5, fps: 2, loop: false, description: 'Sad, slumping, lying under rain lines.' },
  { name: 'states', rect: [0, 660, 630, 785], count: 7, fps: 3, loop: false, description: 'Misc states (sheet label "EXECIAL STATES"): poses, lying, standing.' },
  { name: 'teleport', rect: [630, 660, 1110, 785], count: 5, fps: 6, loop: false, description: 'Teleport/vanish A: sparks, then a ghostly fade.' },
  { name: 'extra_sad', rect: [1110, 660, 1536, 785], count: 5, fps: 2, loop: false, description: 'Deeper sadness, curling up, sleeping "z".' },
  { name: 'special_states', rect: [0, 805, 640, 915], count: 5, fps: 8, loop: true, description: 'Normal, pixel glitch ×2, dark aura, purple flame.' },
  { name: 'teleport_pixels', rect: [640, 805, 1060, 915], count: 5, fps: 7, loop: false, description: 'Teleport/vanish B: body breaks into pixels and fades.' },
  { name: 'follow_idle_sits', rect: [1060, 805, 1536, 915], count: 6, fps: 3, loop: false, description: 'Stand → sit → doze → lie down.' },
  { name: 'facing_variants', rect: [580, 935, 1536, 1024], count: 6, fps: 3, loop: false, description: 'Full-body facing variants (left/right/back).' },
];
const EXTRAS_RECT = [0, 935, 580, 1024];
const EXTRA_NAMES = ['sparkle_big', 'sparkle', 'particles', 'heart', 'question', 'exclaim', 'bubble'];
const SOFT = new Set(['teleport', 'teleport_pixels', 'special_states']); // keep semi-transparent pixels

const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const px = Buffer.from(data);
const A = (i) => px[i * 4 + 3];

// ---- components -----------------------------------------------------------
function components(threshold, R) {
  const fg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) fg[i] = A(i) > threshold ? 1 : 0;
  const dil = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (fg[y * W + x])
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) dil[yy * W + xx] = 1;
    }
  const label = new Int32Array(W * H).fill(-1);
  const comps = [];
  for (let i = 0; i < W * H; i++) {
    if (!dil[i] || label[i] >= 0) continue;
    const id = comps.length, stack = [i];
    label[i] = id;
    let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p / W) | 0;
      if (fg[p]) { n++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W])
        if (q >= 0 && q < W * H && dil[q] && label[q] < 0) { label[q] = id; stack.push(q); }
    }
    comps.push(n ? { id, x0, y0, x1, y1, n, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null);
  }
  return { fg, label, comps: comps.filter(Boolean) };
}

// 1) erase section labels (wide, ~16px tall pills) found at a strict threshold
{
  const { comps } = components(80, 2);
  for (const c of comps) {
    if (c.h <= 19 && c.w >= 30) {
      for (let y = Math.max(0, c.y0 - 2); y <= Math.min(H - 1, c.y1 + 2); y++)
        for (let x = Math.max(0, c.x0 - 2); x <= Math.min(W - 1, c.x1 + 2); x++) px[(y * W + x) * 4 + 3] = 0;
    }
  }
}

// 2) real components at a soft threshold so faded ghosts are kept whole
const { label, comps } = components(14, 1);
const centre = (c) => [(c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2];
const inside = (c, [a, b, cc, d]) => { const [x, y] = centre(c); return x >= a && x < cc && y >= b && y < d; };

function groupSection(sec) {
  const mine = comps.filter((c) => inside(c, sec.rect) && c.n > 12);
  const bodies = [...mine].sort((a, b) => b.n - a.n).slice(0, sec.count);
  if (bodies.length !== sec.count) throw new Error(`${sec.name}: expected ${sec.count} figures, found ${bodies.length}`);
  const groups = bodies.map((b) => ({ body: b, parts: [b] }));
  for (const e of mine) {
    if (bodies.includes(e)) continue;
    const [ex, ey] = centre(e);
    let best = null, bestD = Infinity;
    for (const g of groups) {
      const b = g.body;
      const dx = ex < b.x0 ? b.x0 - ex : ex > b.x1 ? ex - b.x1 : 0;
      const dy = ey < b.y0 ? b.y0 - ey : ey > b.y1 ? ey - b.y1 : 0;
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = g; }
    }
    if (best && bestD < 60) best.parts.push(e);
  }
  return groups.sort((a, b) => a.body.x0 - b.body.x0);
}

function crop(parts, soft) {
  const ids = new Set(parts.map((p) => p.id));
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (const p of parts) { x0 = Math.min(x0, p.x0); y0 = Math.min(y0, p.y0); x1 = Math.max(x1, p.x1); y1 = Math.max(y1, p.y1); }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y + y0) * W + (x + x0);
    if (!ids.has(label[si])) continue;
    let a = px[si * 4 + 3];
    if (!soft) a = a < 40 ? 0 : a > 170 ? 255 : a; // crisp pixel-art edges
    if (!a) continue;
    const o = (y * w + x) * 4;
    buf[o] = px[si * 4]; buf[o + 1] = px[si * 4 + 1]; buf[o + 2] = px[si * 4 + 2]; buf[o + 3] = a;
  }
  return { buf, w, h, x0, y0 };
}

function footAnchor(c, body) {
  // horizontal centroid of opaque pixels in the lowest 20% of the body
  const top = Math.round(body.y1 - body.h * 0.2) - c.y0;
  let sx = 0, n = 0;
  for (let y = Math.max(0, top); y <= body.y1 - c.y0; y++) for (let x = body.x0 - c.x0; x <= body.x1 - c.x0; x++)
    if (c.buf[(y * c.w + x) * 4 + 3] > 60) { sx += x; n++; }
  return { ax: n ? sx / n : c.w / 2, ay: body.y1 - c.y0 + 1 };
}

/** Eyes = bright pixels in the top 42% of the body itself (excludes the floating star). */
function eyes(c, body) {
  const pts = [];
  const limit = body.y0 + body.h * 0.3; // eyes only — the chest ✦ sits lower
  for (let y = body.y0; y < limit; y++) for (let x = body.x0; x <= body.x1; x++) {
    const si = y * W + x;
    if (label[si] !== body.id) continue;
    const r = px[si * 4], g = px[si * 4 + 1], b = px[si * 4 + 2], a = px[si * 4 + 3];
    // eyes sit inside the dark head: dark opaque pixels 5px above and below
    const dark = (yy) => { const j = (yy * W + x) * 4; return px[j + 3] > 180 && px[j] + px[j + 1] + px[j + 2] < 300; };
    if (a > 150 && r > 170 && g > 150 && b > 190 && dark(y - 5) && dark(y + 5)) pts.push([x, y]);
  }
  // cluster by x; the floating ✦ (always to the right on this sheet) is its own cluster
  const xs = [...new Set(pts.map((p) => p[0]))].sort((a, b) => a - b);
  let clusters = [];
  for (const x of xs) {
    const last = clusters[clusters.length - 1];
    if (last && x - last[1] <= 3) last[1] = x;
    else clusters.push([x, x]);
  }
  while (clusters.length > 2 || (clusters.length === 2 && clusters[1][1] - clusters[0][0] > 30)) clusters.pop();
  const keep = pts.filter(([x]) => clusters.some(([a, b]) => x >= a && x <= b));
  if (keep.length < 4) return null;
  const x0 = Math.min(...keep.map((p) => p[0])), x1 = Math.max(...keep.map((p) => p[0]));
  const y0 = Math.min(...keep.map((p) => p[1])), y1 = Math.max(...keep.map((p) => p[1]));
  if (x1 - x0 > 30 || y1 - y0 > 14) return null;
  return { x: x0 - c.x0, y: y0 - c.y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---- extract all sections --------------------------------------------------
const sections = {};
for (const sec of SECTIONS) {
  sections[sec.name] = groupSection(sec).map((g) => {
    const c = crop(g.parts, SOFT.has(sec.name));
    return { ...c, ...footAnchor(c, g.body), face: eyes(c, g.body), src: { x: c.x0, y: c.y0, w: c.w, h: c.h }, group: g };
  });
}
console.log('frames per section:', Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length])));

// ---- runtime atlas: uniform cells, bottom-centre anchored ---------------------
// ---- generated loops: breathing idle + nodding talk, built from the base pose ----
// The sheet's idle/speaking strips are different poses, which flicker when looped.
// These loops keep one pose and move only the chest, head and floating sparkle.
const PAD_TOP = 3;
function layer(parts, ref) {
  const c = crop(parts, false);
  return { ...c, dx: c.x0 - ref.x0, dy: c.y0 - ref.y0 };
}
function blitRows(dst, dw, src, y0, y1, ox, oy) {
  for (let y = y0; y < y1; y++) for (let x = 0; x < src.w; x++) {
    const si = (y * src.w + x) * 4;
    if (!src.buf[si + 3]) continue;
    const tx = ox + x, ty = oy + y;
    if (tx < 0 || ty < 0 || tx >= dw) continue;
    src.buf.copy(dst, (ty * dw + tx) * 4, si, si + 4);
  }
}
/** headLift: rows above the neck move up by k (neck row stretches); breath: chest rows move down. */
function synthFrame(base, { headLift = 0, breath = 0, sparkleDy = 0 }) {
  const g = base.group;
  const body = layer([g.body], base);
  const extras = g.parts.filter((p) => p !== g.body);
  const spark = extras.length ? layer(extras, base) : null;
  const w = base.w, h = base.h + PAD_TOP;
  const buf = Buffer.alloc(w * h * 4);
  const neck = Math.round(body.h * 0.4);
  const chest = Math.round(body.h * 0.62);
  const oy = PAD_TOP + body.dy;
  // legs/lower body
  blitRows(buf, w, body, chest, body.h, body.dx, oy);
  // torso (moves down with breath), neck filler, then head (lifted when talking)
  blitRows(buf, w, body, neck, chest, body.dx, oy + breath);
  for (let k = 0; k < headLift; k++) blitRows(buf, w, body, neck, neck + 1, body.dx, oy + breath - k - 1);
  blitRows(buf, w, body, 0, neck, body.dx, oy + breath - headLift);
  if (spark) blitRows(buf, w, spark, 0, spark.h, spark.dx, PAD_TOP + spark.dy + sparkleDy);
  const face = base.face ? { ...base.face, y: base.face.y + PAD_TOP + breath - headLift } : null;
  return { buf, w, h, ax: base.ax, ay: base.ay + PAD_TOP, face, src: null };
}
const basePose = sections.idle[0];
const bob = [0, -1, -1, -2, -2, -2, -1, 0, 1, 1, 1, 0];
sections.idle_loop = bob.map((dy, i) => synthFrame(basePose, { breath: i >= 4 && i <= 8 ? 1 : 0, sparkleDy: dy }));
sections.talk_loop = [0, 1, 2, 1, 0, 1].map((k, i) => synthFrame(basePose, { headLift: k, sparkleDy: [0, -1, -2, -1, 0, -1][i] }));

const all = Object.values(sections).flat();
let half = 0, up = 0;
for (const f of all) { half = Math.max(half, f.ax, f.w - f.ax); up = Math.max(up, f.ay); }
const PAD = 4;
const cellW = Math.ceil(half * 2) + PAD * 2;
const cellH = Math.ceil(up) + PAD;
const COLS = 12;
const rows = Math.ceil(all.length / COLS);
const composites = [], frameRects = [], faces = [], sectionIndex = {};
let idx = 0;
for (const [name, list] of Object.entries(sections)) {
  sectionIndex[name] = [];
  for (const f of list) {
    const col = idx % COLS, row = (idx / COLS) | 0;
    const left = Math.round(col * cellW + cellW / 2 - f.ax);
    const top = Math.round(row * cellH + cellH - f.ay);
    composites.push({ input: f.buf, raw: { width: f.w, height: f.h, channels: 4 }, left, top });
    frameRects.push({ x: col * cellW, y: row * cellH, w: cellW, h: cellH });
    faces.push(f.face ? { x: f.face.x + (left - col * cellW), y: f.face.y + (top - row * cellH), w: f.face.w, h: f.face.h } : null);
    sectionIndex[name].push(idx++);
  }
}
fs.mkdirSync(OUT, { recursive: true });
await sharp({ create: { width: COLS * cellW, height: rows * cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(composites).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'phantom-atlas.png'));
fs.writeFileSync(path.join(OUT, 'phantom-atlas.json'), JSON.stringify({
  version: 3,
  character: 'noli',
  faceStyle: 'eyes',
  image: 'phantom-atlas.png',
  cell: { w: cellW, h: cellH },
  frames: frameRects,
  faces,
  sections: sectionIndex,
}, null, 2));

// ---- animation JSON in the noli-companion-atlas-v1 format ------------------------
await sharp(SRC).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'noli-sheet.png'));
const animations = {
  idle_loop: { description: 'Generated from idle[0]: breathing chest and bobbing sparkle. Frames are in phantom-atlas.png.', fps: 6, loop: true, anchor: 'bottom-center', generated: true, atlasFrames: sectionIndex.idle_loop },
  talk_loop: { description: 'Generated from idle[0]: nodding head while speaking. Frames are in phantom-atlas.png.', fps: 8, loop: true, anchor: 'bottom-center', generated: true, atlasFrames: sectionIndex.talk_loop },
};
for (const sec of SECTIONS) {
  animations[sec.name] = {
    description: sec.description,
    fps: sec.fps,
    loop: sec.loop,
    anchor: sec.anchor ?? 'bottom-center',
    ...(sec.renderAs ? { renderAs: sec.renderAs } : {}),
    frames: sections[sec.name].map((f) => f.src),
  };
}
fs.writeFileSync(path.join(OUT, 'noli-animations.json'), JSON.stringify({
  meta: {
    format: 'noli-companion-atlas-v1',
    image: 'noli-sheet.png',
    imageWidth: W,
    imageHeight: H,
    coordinateSystem: 'pixels, origin at top-left',
    frameRectFormat: { x: 'left', y: 'top', w: 'width', h: 'height' },
    anchorDefault: 'bottom-center',
    notes: [
      'Generated by scripts/extract-sprites.mjs: rects are exact bounding boxes of each figure, including its floating sparkle and baked-in marks (?, !, particles).',
      'The sheet has true transparency; section labels are not part of any frame.',
      'Some strips are pose variations rather than timed animations; PHANTOM picks frames per state in src/companion/clips.ts.',
      'blink_eyes_overlay contains head-only artwork; do not draw it as a full-body frame.',
    ],
  },
  animations,
}, null, 2));

// ---- extras (UI atlas) ----------------------------------------------------------
const extraComps = comps.filter((c) => inside(c, EXTRAS_RECT) && c.n > 12).sort((a, b) => a.x0 - b.x0);
// particles = the cluster of small squares between the small star and the heart
const heartish = extraComps.filter((c) => c.n > 400);
const groupsX = [];
for (const c of extraComps) {
  const last = groupsX[groupsX.length - 1];
  if (last && c.x0 - last.x1 < 14 && (c.n < 400 || last.small)) { last.parts.push(c); last.x1 = Math.max(last.x1, c.x1); last.small = last.small && c.n < 400; }
  else groupsX.push({ parts: [c], x1: c.x1, small: c.n < 400 });
}
if (groupsX.length !== EXTRA_NAMES.length) console.warn(`extras: expected ${EXTRA_NAMES.length} groups, found ${groupsX.length}`);
let ux = 0; const uiMap = {}; const uiComp = []; let uiH = 0;
groupsX.forEach((g, i) => {
  const c = crop(g.parts, true);
  uiComp.push({ input: c.buf, raw: { width: c.w, height: c.h, channels: 4 }, left: ux, top: 0 });
  uiMap[EXTRA_NAMES[i] ?? `extra_${i}`] = { x: ux, y: 0, w: c.w, h: c.h };
  uiH = Math.max(uiH, c.h);
  ux += c.w + 2;
});
void heartish;
await sharp({ create: { width: ux, height: uiH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite(uiComp).png().toFile(path.join(OUT, 'ui-atlas.png'));
fs.writeFileSync(path.join(OUT, 'ui-atlas.json'), JSON.stringify({ image: 'ui-atlas.png', width: ux, height: uiH, items: uiMap }, null, 2));

// ---- portrait (idle frame, 3× nearest-neighbour) ----------------------------------
const p = sections.idle[0];
await sharp(p.buf, { raw: { width: p.w, height: p.h, channels: 4 } })
  .resize(p.w * 3, p.h * 3, { kernel: 'nearest' }).png().toFile(path.join(OUT, 'portrait.png'));

console.log(`atlas: ${all.length} frames, cell ${cellW}x${cellH}; faces ${faces.filter(Boolean).length}/${faces.length}; ui: ${Object.keys(uiMap).join(', ')}`);
if (PREVIEW) await sharp(path.join(OUT, 'phantom-atlas.png')).flatten({ background: '#d8d0e4' }).png().toFile(PREVIEW);
