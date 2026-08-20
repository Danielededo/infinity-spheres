#!/usr/bin/env node
/**
 * Deterministic benchmark + non-regression harness for index.html.
 *
 * Design constraints:
 *  - index.html is NEVER modified for measurement. Every hook is injected by
 *    this harness into the copy of three.js it serves, or via addInitScript.
 *  - Everything that could vary run to run is pinned: Math.random is seeded,
 *    the camera is placed by hand, auto-rotation and damping are off, and the
 *    simulation is advanced by an exact number of fixed-size steps rather than
 *    by wall-clock delta.
 *
 * Environment note: this sandbox has no GPU, so Chromium rasterises on the CPU
 * through SwiftShader, which is why the default viewport is only 320x200: at
 * 480x300 the scene runs at 0.89 fps and a full run would take over an hour.
 * At 320x200 it runs at ~12.5 fps and a full run takes about seven minutes.
 * The viewport is recorded in metrics.json; every revision is compared at the
 * same one, so the ratios the goals are expressed in stay meaningful. TRIS / DRAWCALLS / PROGRAMS / GEOMETRIES / TEXTURES,
 * the allocation counters and the physics gates are hardware independent.
 * FRAME_P95 and PHYS_MS are CPU numbers: valid for comparing one revision
 * against another on this machine, not predictive of absolute GPU frame times.
 *
 * Usage:
 *   node bench/bench.mjs                        # full run, writes bench/metrics.json
 *   node bench/bench.mjs --out bench/baseline.json --write-ref
 *   node bench/bench.mjs --frames 300 --growth-frames 500   # quick run
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE = path.join(ROOT, 'index.html');

/* ------------------------------------------------------------------ *
 * Config — recorded into metrics.json so a run is reproducible
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes('--' + name);

const CFG = {
  width: +arg('width', 320),   // small on purpose: see the note above,
  height: +arg('height', 200),  // this machine rasterises on the CPU
  dpr: +arg('dpr', 1),
  // Sample sizes are smaller than one would pick on real hardware. Measured
  // here: this scene renders at 0.9 fps at 320x200 under SwiftShader, so the
  // 1200-frame / 200-2200-frame windows originally specified come to ~70
  // minutes per run, and an iteration loop over them is not affordable. 200
  // frames still gives a stable p95, and a 400-frame heap window still catches
  // per-frame accumulation, at ~4x less sensitivity than a 2000-frame one.
  frames: +arg('frames', 200),           // FRAME_P95 sample size
  warmupFrames: +arg('warmup', 40),      // discarded: shader compile, PMREM, first paints
  growthFrom: +arg('growth-from', 60),   // HEAP_GROWTH window
  growthTo: +arg('growth-to', 460),
  physIters: +arg('phys-iters', 2000),   // step() calls timed for PHYS_MS
  shotFrame: +arg('shot-frame', 300),    // simulation steps before each screenshot
  gateSeconds: +arg('gate-seconds', 90), // simulated seconds for the physics gates
  seed: +arg('seed', 20260819),
  browser: 'chromium/swiftshader',
};

// Three fixed camera poses. Pose 0 is also the pose used for FRAME_P95.
const POSES = [
  { name: 'front', pos: [6, 12, 48] },
  { name: 'oblique', pos: [34, 20, 30] },
  { name: 'close', pos: [1, 5, 15] },
];

const OUT = arg('out', path.join(HERE, 'metrics.json'));
// Which phases to run. The SSIM-guided searches (how far the transmission
// resolution or the tube tessellation can be cut before the picture changes)
// only need phase 4, which takes about two minutes against twelve for a full
// run, so the search is affordable.
const PHASES = new Set(arg('phases', '1,2,3,4').split(',').map(Number));
const REF_DIR = path.join(HERE, 'ref');
const WRITE_REF = flag('write-ref');

/* ------------------------------------------------------------------ *
 * Serve an instrumented three.js
 *
 * The version comes from index.html's importmap, so the harness follows the
 * page instead of pinning its own copy. The CDN is unreachable from this
 * sandbox and would add network variance anyway, so requests are fulfilled
 * from node_modules with three small source patches:
 *   1. count every Vector3 construction   -> ALLOC_FRAME
 *   2. expose renderer/scene/camera        -> renderer.info, camera posing
 *   3. expose the OrbitControls instance   -> disable auto-rotation/damping
 * ------------------------------------------------------------------ */
const html = fs.readFileSync(PAGE, 'utf8');
const verMatch = html.match(/three@([0-9.]+)\/build\/three\.module\.js/);
if (!verMatch) throw new Error('could not find the pinned three version in index.html');
const THREE_VERSION = verMatch[1];

const candidates = [
  path.join(ROOT, 'node_modules', 'three'),
  path.join(HERE, 'node_modules', 'three'),
  process.env.THREE_DIR || '',
].filter(Boolean);
const THREE_DIR = candidates.find((d) => fs.existsSync(path.join(d, 'build', 'three.module.js')));
if (!THREE_DIR) {
  console.error(`No local three found. Install the pinned version first:\n  npm i three@${THREE_VERSION}`);
  process.exit(2);
}
const localVersion = JSON.parse(fs.readFileSync(path.join(THREE_DIR, 'package.json'), 'utf8')).version;
if (localVersion !== THREE_VERSION) {
  console.error(`three version mismatch: index.html pins ${THREE_VERSION}, node_modules has ${localVersion}.`);
  console.error(`  npm i three@${THREE_VERSION}`);
  process.exit(2);
}

/**
 * Patch whichever build file actually contains each anchor. Newer three
 * releases split three.module.js into a thin re-export plus three.core.js, so
 * the anchors move between files; discovering them by content keeps the harness
 * working across versions instead of hard-coding a filename.
 */
const V3_ANCHOR = '\t\tVector3.prototype.isVector3 = true;';
const RENDER_ANCHOR = '\t\tthis.render = function ( scene, camera ) {';

function patchSource(src) {
  let hits = { v3: 0, render: 0 };
  if (src.includes(V3_ANCHOR)) {
    hits.v3 = src.split(V3_ANCHOR).length - 1;
    src = src.split(V3_ANCHOR).join('\t\tglobalThis.__v3c = ( globalThis.__v3c || 0 ) + 1;\n' + V3_ANCHOR);
  }
  if (src.includes(RENDER_ANCHOR)) {
    hits.render = src.split(RENDER_ANCHOR).length - 1;
    src = src.split(RENDER_ANCHOR).join(RENDER_ANCHOR +
      '\n\t\t\tif ( globalThis.__benchRender ) globalThis.__benchRender( this, scene, camera );');
  }
  return { src, hits };
}

/* Serve exactly the files the entry point pulls in, found by walking the
 * relative-import graph. 0.169 ships a self-contained three.module.js; newer
 * releases split it into three.module.js + three.core.js. Both build files
 * exist in every version's build/ directory, so picking them by name would
 * double-count the anchors. */
const BUILD = {};
{
  const total = { v3: 0, render: 0 };
  const queue = ['build/three.module.js'];
  const seen = new Set();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const raw = fs.readFileSync(path.join(THREE_DIR, rel), 'utf8');
    const { src, hits } = patchSource(raw);
    BUILD[rel] = src;
    total.v3 += hits.v3; total.render += hits.render;
    const dir = path.posix.dirname(rel);
    for (const m of raw.matchAll(/from\s+'(\.\/[^']+)'/g)) {
      queue.push(path.posix.normalize(path.posix.join(dir, m[1])));
    }
  }
  if (total.v3 !== 1) throw new Error(`Vector3 anchor found ${total.v3}x in [${[...seen]}], expected 1`);
  if (total.render !== 1) throw new Error(`render anchor found ${total.render}x in [${[...seen]}], expected 1`);
  console.log(`instrumented three ${THREE_VERSION}: ${[...seen].join(', ')}`);
}

function serveExample(rel) {
  const file = path.join(THREE_DIR, 'examples', 'jsm', rel);
  let src = fs.readFileSync(file, 'utf8');
  if (rel.endsWith('controls/OrbitControls.js')) {
    src += `
// --- bench harness: expose the live controls instance ---
const __benchUpdate = OrbitControls.prototype.update;
OrbitControls.prototype.update = function ( ...a ) {
  globalThis.__benchControls = this;
  return __benchUpdate.apply( this, a );
};
`;
  }
  return src;
}

/* ------------------------------------------------------------------ *
 * Page-side setup: seeded RNG, frame timing, allocation sampling
 * ------------------------------------------------------------------ */
function initScript(seed) {
  return `(() => {
  // Deterministic RNG (mulberry32): identical marble radii, colours, speeds
  // and start velocities on every run, which is what makes SSIM meaningful.
  let s = ${seed} >>> 0;
  Math.random = function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  globalThis.__v3c = 0;
  const B = globalThis.__bench = {
    frames: 0, times: [], gaps: [], alloc: [], prevT: 0,
    renderer: null, scene: null, camera: null,
  };
  globalThis.__benchRender = (renderer, scene, camera) => {
    B.renderer = renderer; B.scene = scene; B.camera = camera;
  };

  // Wrap rAF so each animation-loop callback is timed end to end: physics,
  // controls and the draw calls of that frame. Under SwiftShader rasterisation
  // is on the CPU, so this captures essentially the whole cost of the frame.
  // Two different numbers, both needed:
  //   gaps  = frame-to-frame interval, i.e. what the frame rate actually is.
  //           SwiftShader rasterises outside the JS callback, so this is the
  //           only one that sees the cost of the transmission and shadow passes.
  //   times = time spent inside the callback (physics + controls + GL command
  //           submission). Useful to separate JS-side from raster-side cost.
  const raf = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = (cb) => raf((t) => {
    const v0 = globalThis.__v3c;
    const t0 = performance.now();
    if (B.prevT) B.gaps.push(t0 - B.prevT);
    else B.gaps.push(0);
    B.prevT = t0;
    cb(t);
    B.frames++;
    B.times.push(performance.now() - t0);
    B.alloc.push(globalThis.__v3c - v0);
  });
})();`;
}

/* ------------------------------------------------------------------ *
 * PNG decode + SSIM (no dependencies: node:zlib does the inflate)
 * ------------------------------------------------------------------ */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new Error(`unsupported PNG: depth ${bitDepth} colorType ${colorType}`);
      }
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8Array(w * h * channels);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad PNG filter ' + filter);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, channels, data: out };
}

const toGray = (img) => {
  const g = new Float64Array(img.w * img.h);
  const c = img.channels;
  for (let i = 0, p = 0; i < g.length; i++, p += c) {
    g[i] = 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
  }
  return g;
};

/** Mean SSIM over 8x8 windows, the standard C1/C2 stabilisers. */
function ssim(aBuf, bBuf) {
  const A = decodePNG(aBuf), Bi = decodePNG(bBuf);
  if (A.w !== Bi.w || A.h !== Bi.h) throw new Error(`size mismatch ${A.w}x${A.h} vs ${Bi.w}x${Bi.h}`);
  const a = toGray(A), b = toGray(Bi);
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const win = 8;
  let sum = 0, n = 0;
  for (let y = 0; y + win <= A.h; y += win) {
    for (let x = 0; x + win <= A.w; x += win) {
      let ma = 0, mb = 0;
      for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) {
        const k = (y + j) * A.w + (x + i); ma += a[k]; mb += b[k];
      }
      const N = win * win;
      ma /= N; mb /= N;
      let va = 0, vb = 0, cov = 0;
      for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) {
        const k = (y + j) * A.w + (x + i);
        const da = a[k] - ma, db = b[k] - mb;
        va += da * da; vb += db * db; cov += da * db;
      }
      va /= N - 1; vb /= N - 1; cov /= N - 1;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      n++;
    }
  }
  return sum / n;
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */
const log = (...a) => console.log(...a);
const pct = (arr, p) => {
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
};

// Use a specific binary when one is present (this sandbox ships Chromium at a
// fixed path and forbids re-downloading it); otherwise let playwright resolve
// its own, which is what happens on CI.
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}),
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--js-flags=--expose-gc', '--enable-precise-memory-info',
    '--disable-frame-rate-limit', '--disable-gpu-vsync',
  ],
});

async function newPage() {
  const page = await browser.newPage({
    viewport: { width: CFG.width, height: CFG.height },
    deviceScaleFactor: CFG.dpr,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.route(`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/**`, (route) => {
    const p = new URL(route.request().url()).pathname.replace(`/npm/three@${THREE_VERSION}/`, '');
    try {
      const body = BUILD[p] !== undefined
        ? BUILD[p]
        : serveExample(p.replace(/^examples\/jsm\//, ''));
      route.fulfill({ status: 200, contentType: 'text/javascript', body });
    } catch (e) {
      route.fulfill({ status: 404, body: String(e) });
    }
  });
  await page.route('https://bench.local/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    route.fulfill({ status: 404, body: 'not found' });
  });
  await page.addInitScript(initScript(CFG.seed));
  await page.goto(`https://bench.local/index.html#seed=${CFG.seed}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__scene && window.__scene.marbles.length > 0', { timeout: 120000 });
  await page.waitForFunction('window.__bench.renderer && window.__benchControls', { timeout: 120000 });
  return { page, errors };
}

/**
 * Put the simulation into a state that depends on nothing but the seed.
 *
 * The page starts its own loop as soon as it loads and advances the physics by
 * wall-clock delta, so by the time the harness gets control an arbitrary amount
 * of simulated time has already passed. Pausing first freezes that, pressing R
 * rebuilds the marbles from the seeded RNG, and the fixed-size steps after that
 * are reproducible. Order matters: pause before reset, or the loop keeps
 * stepping the fresh state by wall-clock delta.
 */
async function freezeAt(page, steps) {
  await page.keyboard.press('Space');            // pause physics
  await page.waitForTimeout(150);
  await page.keyboard.press('KeyR');             // rebuild marbles, seeded
  await page.waitForTimeout(150);
  await page.evaluate((n) => { for (let i = 0; i < n; i++) window.__scene.step(1 / 60); }, steps);
}

/** Pin the camera and stop anything that moves on its own. */
async function pose(page, p) {
  await page.evaluate(({ pos }) => {
    const c = globalThis.__benchControls;
    c.autoRotate = false;
    c.enableDamping = false;
    c.enabled = false;
    const cam = globalThis.__bench.camera;
    cam.position.set(pos[0], pos[1], pos[2]);
    c.target.set(0, 0, 0);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    c.update();
  }, p);
}

/** Wait until the page has rendered `n` frames, reporting progress so a long
 *  run does not look like a hang. */
async function waitFrames(page, n, timeout = 3600000) {
  const t0 = Date.now();
  let last = -1;
  for (;;) {
    const f = await page.evaluate(() => window.__bench.frames);
    if (f >= n) return f;
    if (Date.now() - t0 > timeout) throw new Error(`waitFrames timeout at ${f}/${n}`);
    if (f - last >= 100 || last < 0) {
      const el = (Date.now() - t0) / 1000;
      process.stdout.write(`      ... ${f}/${n} frames, ${el.toFixed(0)}s elapsed, ${(f / el).toFixed(1)} fps\n`);
      last = f;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const results = { config: { ...CFG, three: THREE_VERSION, poses: POSES.map((p) => p.name) } };

/* ---- phase 1: render metrics, fixed pose 0, physics live -------- */
if (PHASES.has(1)) {
  log(`\n[1/4] render metrics @ ${CFG.width}x${CFG.height}, ${CFG.frames} frames after ${CFG.warmupFrames} warmup`);
  const { page, errors } = await newPage();
  await pose(page, POSES[0]);
  await freezeAt(page, CFG.shotFrame);
  await waitFrames(page, CFG.warmupFrames);
  const mark = await page.evaluate(() => window.__bench.frames);
  await waitFrames(page, mark + CFG.frames);

  const r = await page.evaluate((from) => {
    const B = window.__bench;
    const info = B.renderer.info;
    return {
      times: B.times.slice(from),
      gaps: B.gaps.slice(from),
      alloc: B.alloc.slice(from),
      render: { calls: info.render.calls, triangles: info.render.triangles },
      memory: { geometries: info.memory.geometries, textures: info.memory.textures },
      programs: info.programs ? info.programs.length : null,
      frames: B.frames,
    };
  }, mark);

  results.FRAME_P95 = +pct(r.gaps, 0.95).toFixed(3);
  results.FRAME_P50 = +pct(r.gaps, 0.50).toFixed(3);
  results.FRAME_MEAN = +(r.gaps.reduce((a, b) => a + b, 0) / r.gaps.length).toFixed(3);
  results.FRAME_CPU_P95 = +pct(r.times, 0.95).toFixed(3);
  results.FPS_EFFECTIVE = +(1000 / (r.gaps.reduce((a, b) => a + b, 0) / r.gaps.length)).toFixed(2);
  results.DRAWCALLS = r.render.calls;
  results.TRIS = r.render.triangles;
  results.PROGRAMS = r.programs;
  results.GEOMETRIES = r.memory.geometries;
  results.TEXTURES = r.memory.textures;
  results.ALLOC_FRAME = +pct(r.alloc, 0.50);
  results.ALLOC_FRAME_MAX = Math.max(...r.alloc);
  results.frame_samples = r.times.length;
  log(`      FRAME_P95=${results.FRAME_P95}ms p50=${results.FRAME_P50}ms cpu_p95=${results.FRAME_CPU_P95}ms (${results.FPS_EFFECTIVE} fps)  DRAWCALLS=${results.DRAWCALLS}  TRIS=${results.TRIS}`);
  log(`      PROGRAMS=${results.PROGRAMS} GEOMETRIES=${results.GEOMETRIES} TEXTURES=${results.TEXTURES}  ALLOC_FRAME=${results.ALLOC_FRAME} (max ${results.ALLOC_FRAME_MAX})`);
  if (errors.length) { results.errors = errors; log('      page errors: ' + errors.join(' | ')); }
  await page.close();
}

/* ---- phase 2: heap ---------------------------------------------- */
if (PHASES.has(2)) {
  log(`[2/4] heap: usedJSHeapSize after forced GC, growth between frame ${CFG.growthFrom} and ${CFG.growthTo}`);
  const { page } = await newPage();
  await pose(page, POSES[0]);
  await waitFrames(page, CFG.growthFrom);
  const h0 = await page.evaluate(async () => {
    if (globalThis.gc) globalThis.gc();
    await new Promise((r) => setTimeout(r, 300));
    return performance.memory.usedJSHeapSize;
  });
  await waitFrames(page, CFG.growthTo);
  const h1 = await page.evaluate(async () => {
    if (globalThis.gc) globalThis.gc();
    await new Promise((r) => setTimeout(r, 300));
    return performance.memory.usedJSHeapSize;
  });
  results.HEAP_MB = +(h0 / 1048576).toFixed(3);
  results.HEAP_GROWTH_MB = +((h1 - h0) / 1048576).toFixed(3);
  log(`      HEAP_MB=${results.HEAP_MB}  HEAP_GROWTH_MB=${results.HEAP_GROWTH_MB}`);
  await page.close();
}

/* ---- phase 3: physics in isolation + non-regression gates ------- */
if (PHASES.has(3)) {
  log(`[3/4] physics: PHYS_MS over ${CFG.physIters} steps, gates over ${CFG.gateSeconds}s simulated`);
  const { page } = await newPage();
  await pose(page, POSES[0]);
  await page.keyboard.press('Space');          // pause the page's own stepping
  await page.waitForTimeout(200);

  const phys = await page.evaluate((iters) => {
    const { step } = window.__scene;
    for (let i = 0; i < 20; i++) step(1 / 60);  // warm up JIT
    const v0 = globalThis.__v3c;
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) step(1 / 60);
    const ms = (performance.now() - t0) / iters;
    return { ms, allocPerStep: (globalThis.__v3c - v0) / iters };
  }, CFG.physIters);
  results.PHYS_MS = +phys.ms.toFixed(4);
  results.ALLOC_PER_STEP = +phys.allocPerStep.toFixed(4);

  const gates = await page.evaluate((secs) => {
    const { marbles, nearestOnSpine, step, R, totalEnergy } = window.__scene;
    // Total energy, kinetic plus gravitational: the invariant that holds in
    // both the zero-g default and the gravity mode. Falls back to kinetic on an
    // older page that does not export it.
    const ke = totalEnergy || (() => marbles.reduce((s, m) => s + 0.5 * m.m * m.vel.lengthSq(), 0));
    const ke0 = ke();
    let escaped = 0, worst = -Infinity, lobes = 0, vmax = 0;
    let prev = marbles.map((m) => Math.sign(m.pos.x) || 1);
    const frames = Math.round(secs * 60);
    for (let f = 0; f < frames; f++) {
      step(1 / 60);
      for (const m of marbles) {
        const n = nearestOnSpine(m.pos.x, m.pos.y, m.pos.z);
        const over = n.d - (R - m.r);
        if (over > 1e-6) escaped++;
        if (over > worst) worst = over;
        const sp = m.vel.length(); if (sp > vmax) vmax = sp;
      }
      marbles.forEach((m, i) => {
        const s = Math.sign(m.pos.x) || 1;
        if (s !== prev[i]) { lobes++; prev[i] = s; }
      });
    }
    return { escaped, worst, lobes, vmax, drift: ((ke() - ke0) / ke0) * 100,
             gravity: window.__scene.state ? window.__scene.state.gravity : 0,
             restitution: window.__scene.state ? window.__scene.state.restitution : 1 };
  }, CFG.gateSeconds);

  results.ESCAPED = gates.escaped;
  results.WORST_EXCURSION = gates.worst;
  results.ENERGY_DRIFT_PCT = +Math.abs(gates.drift).toFixed(6);
  // The energy gate only means anything in the default configuration. With
  // gravity on, the contact projection does unaccounted work and energy decays
  // by design (see index.html); recording the configuration keeps that visible
  // instead of looking like a regression.
  results.GRAVITY = gates.gravity;
  results.RESTITUTION = gates.restitution;
  results.LOBE_CHANGES = gates.lobes;
  results.VMAX = +gates.vmax.toFixed(2);
  log(`      PHYS_MS=${results.PHYS_MS}  ALLOC_PER_STEP=${results.ALLOC_PER_STEP}`);
  log(`      ESCAPED=${results.ESCAPED}  ENERGY_DRIFT=${results.ENERGY_DRIFT_PCT}%  LOBE_CHANGES=${results.LOBE_CHANGES}`);
  await page.close();
}

/* ---- phase 4: screenshots + SSIM -------------------------------- */
if (PHASES.has(4)) {
  log(`[4/4] screenshots: ${POSES.length} poses at simulation step ${CFG.shotFrame}`);
  const ssims = {};
  for (const p of POSES) {
    const { page } = await newPage();
    await pose(page, p);
    await page.keyboard.press('KeyH');                  // HUD out of the frame
    await freezeAt(page, CFG.shotFrame);
    await page.evaluate(() => {
      const B = window.__bench;
      // Stop the animation loop, then draw by hand. Without this the screenshot
      // competes with an unthrottled rAF and times out. Two frames, not one:
      // a single one occasionally gets captured part-painted on a loaded
      // machine, which showed up once as an SSIM of 0.971 on a pose that reads
      // 0.998 on every other run.
      B.renderer.setAnimationLoop(null);
      B.renderer.render(B.scene, B.camera);
      B.renderer.render(B.scene, B.camera);
    });
    await page.waitForTimeout(700);
    const shot = await page.screenshot({ timeout: 120000, animations: 'disabled' });
    const refPath = path.join(REF_DIR, `${p.name}.png`);
    if (WRITE_REF) {
      fs.mkdirSync(REF_DIR, { recursive: true });
      fs.writeFileSync(refPath, shot);
      ssims[p.name] = 1;
      log(`      wrote reference ${path.relative(ROOT, refPath)}`);
    } else if (fs.existsSync(refPath)) {
      ssims[p.name] = +ssim(fs.readFileSync(refPath), shot).toFixed(5);
      log(`      SSIM ${p.name} = ${ssims[p.name]}`);
    } else {
      ssims[p.name] = null;
      log(`      no reference for ${p.name} (run once with --write-ref)`);
    }
    fs.writeFileSync(path.join(HERE, `last-${p.name}.png`), shot);
    await page.close();
  }
  results.SSIM = ssims;
  const vals = Object.values(ssims).filter((v) => typeof v === 'number');
  results.SSIM_MIN = vals.length ? Math.min(...vals) : null;
}

await browser.close();

results.git = { head: (process.env.GIT_HEAD || '').trim() || null };
results.timestamp = new Date().toISOString();

fs.writeFileSync(OUT, JSON.stringify(results, null, 2) + '\n');
log(`\nwrote ${path.relative(ROOT, OUT)}`);

/* ---- verdict against baseline ----------------------------------- */
const baselinePath = path.join(HERE, 'baseline.json');
if (fs.existsSync(baselinePath) && path.resolve(OUT) !== path.resolve(baselinePath)) {
  const b = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const rows = [
    ['FRAME_P95', b.FRAME_P95, results.FRAME_P95, (v, bb) => v <= 0.65 * bb, '<= 0.65x'],
    ['DRAWCALLS', b.DRAWCALLS, results.DRAWCALLS, (v, bb) => v <= 0.40 * bb, '<= 0.40x'],
    ['HEAP_GROWTH_MB', b.HEAP_GROWTH_MB, results.HEAP_GROWTH_MB, (v) => v < 1, '< 1 MB'],
    ['ALLOC_FRAME', b.ALLOC_FRAME, results.ALLOC_FRAME, (v) => v === 0, '== 0'],
  ];
  log('\nGOALS');
  for (const [name, before, after, ok, want] of rows) {
    if (after === undefined || after === null) {
      log(`  SKIP  ${name.padEnd(15)} ${'-'.padStart(9)}     not measured in this run`);
      continue;
    }
    const pass = ok(after, before);
    const delta = typeof before === 'number' && before !== 0
      ? ` (${(((after - before) / before) * 100).toFixed(1)}%)` : '';
    log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(15)} ${String(before).padStart(9)} -> ${String(after).padStart(9)}${delta}  want ${want}`);
  }
  const gates = [
    ['ESCAPED', results.ESCAPED, (v) => v === 0, '== 0'],
    ['ENERGY_DRIFT_PCT', results.ENERGY_DRIFT_PCT,
      (v) => v < 0.01 || results.GRAVITY > 0, results.GRAVITY > 0 ? 'n/a under gravity' : '< 0.01'],
    ['LOBE_CHANGES', results.LOBE_CHANGES, (v) => v >= 120, '>= 120'],
    ['SSIM_MIN', results.SSIM_MIN, (v) => v >= 0.98, '>= 0.98'],
  ];
  log('NON-REGRESSION GATES');
  let allGates = true;
  for (const [name, val, ok, want] of gates) {
    // A partial run (--phases) does not produce every metric. Skipping is
    // reported rather than silently counted as a pass, so a CI job that only
    // runs the physics phase cannot look greener than it is.
    if (val === undefined || val === null) {
      log(`  SKIP  ${name.padEnd(18)} ${'-'.padStart(9)}  not measured in this run`);
      continue;
    }
    const pass = ok(val);
    if (!pass) allGates = false;
    log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${String(val).padStart(9)}  want ${want}`);
  }
  log(`\nVERDICT: gates ${allGates ? 'PASS' : 'FAIL -> revert this iteration'}`);
  if (!allGates) process.exitCode = 1;
}
