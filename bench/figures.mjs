/* Renders every image the documentation uses, into docs/.
 *
 *   node bench/figures.mjs                 # all of them
 *   node bench/figures.mjs preview spines  # just these
 *
 * This is not a measurement, so it is not part of bench.mjs and nothing it
 * produces is gated. It borrows the harness's two habits anyway, because a
 * figure that has to be regenerated in a year should come back the same:
 *
 *  - Math.random is replaced with the same seeded mulberry32 before page scripts
 *    run, so marble radii, colours and start velocities are fixed.
 *  - The simulation advances by an exact number of fixed-size step() calls
 *    rather than by wall-clock delta.
 *
 * And it adds two the harness does not need, because without them two runs of
 * identical code produce different files — which is how a rendering change
 * becomes impossible to see in a diff:
 *
 *  - `#s=0` in the URL, so the time scale starts at zero and the page's own loop
 *    cannot advance the simulation while the module loads.
 *  - requestAnimationFrame is swallowed, so the page cannot draw a frame either.
 *    That one took some finding: see freezeRaf below.
 *
 * Verified: three consecutive runs produce byte-identical files.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const SEED = 20260819;          // the harness's seed, so these are the reference scene
const STEPS = 300;              // the settling point the reference screenshots use

/* Each figure is a list of panels rendered side by side into one image, so a
 * comparison is one file in the docs rather than three the reader has to line
 * up themselves. `hash` is appended to the page URL; `cam` and `target` place
 * the camera; `label` is drawn in the corner of the panel. */
const FIGURES = {
  // The hero, and the og:image the social tags point at.
  preview: {
    w: 1400, h: 700,
    panels: [{ cam: [4, 10, 40] }],
  },
  /* What "open junction" means — the one thing a wide shot cannot show.
   *
   * The distance was chosen by rendering candidates and looking: closer than
   * this and the camera is inside the bore, where the picture is an abstract
   * mush of glass and highlights with no readable shape. At radius 21 the X
   * fills the frame and both branches are visible. The x-ray panel is the same
   * camera with the glass in wireframe, which is the only way to see that the
   * wall really is cut away rather than merely transparent. */
  junction: {
    w: 1200, h: 500,
    panels: [
      { cam: [0, 12, 17], label: 'the crossing' },
      { cam: [0, 12, 17], hash: 'x=1', label: 'x-ray: the wall is gone' },
    ],
  },
  /* The three spines. One camera for all of them, which is the honest
   * comparison: they are scaled to the same bounding radius, so what differs in
   * the picture is shape rather than size. Far enough out that the two tall
   * rosettes are not cropped. */
  spines: {
    w: 1500, h: 420,
    panels: [
      { cam: [4, 16, 54], hash: 'c=lemniscate', label: 'lemniscate · 1 crossing' },
      { cam: [4, 16, 54], hash: 'c=trefoil', label: 'trefoil · 3 crossings' },
      { cam: [4, 16, 54], hash: 'c=clover', label: 'clover · 3 crossings' },
    ],
  },
  // What the count actually does, which a number in a table does not convey.
  counts: {
    w: 1500, h: 420,
    panels: [
      { cam: [4, 14, 46], label: '30 · default' },
      { cam: [4, 14, 46], hash: 'n=200', label: 'Packed' },
      { cam: [4, 14, 46], hash: 'n=600&z=0.55', label: 'Shoal' },
    ],
  },
};

const WANT = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const NAMES = WANT.length ? WANT : Object.keys(FIGURES);
for (const n of NAMES) if (!FIGURES[n]) throw new Error(`unknown figure: ${n}`);

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const THREE_VERSION = html.match(/three@([\d.]+)/)[1];
const THREE_DIR = process.env.THREE_DIR || path.join(ROOT, 'node_modules/three');

/* Nothing may render before the figure does.
 *
 * `#s=0` stops the *simulation* from advancing during the load. This stops the
 * *rendering*, which turned out to matter just as much: three.js drives its
 * animation loop from requestAnimationFrame, so a frame or two slips in between
 * the module loading and this script taking over, and how many depends on how
 * busy the machine is. With transmission: 1 the glass refracts a render target
 * that carries over between frames, and the result was output that flipped
 * between two states depending on the parity of that frame count — rendering
 * two, three or four times before reading the canvas did not settle it, because
 * the input differed rather than the convergence.
 *
 * Swallowing every callback removes the variable. The page never draws a frame
 * on its own; this script sets the camera and renders by hand. */
const freezeRaf = `(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
})()`;

/* The same mulberry32 the harness installs, inlined so this file stands alone. */
const seedScript = (seed) => `(() => {
  let a = ${seed} >>> 0;
  Math.random = () => { a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
})()`;

const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  ...(fs.existsSync(CHROME) ? { executablePath: CHROME } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

/** Render one panel and return its pixels as a data URL. */
async function panel(p, w, h) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.route(`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/**`, (route) => {
    const f = new URL(route.request().url()).pathname.replace(`/npm/three@${THREE_VERSION}/`, '');
    try {
      route.fulfill({ status: 200, contentType: 'text/javascript',
                      body: fs.readFileSync(path.join(THREE_DIR, f), 'utf8') });
    } catch (e) { route.fulfill({ status: 404, body: String(e) }); }
  });
  await page.route('https://figures.local/**', (route) => {
    const f = new URL(route.request().url()).pathname;
    if (f === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    route.fulfill({ status: 404, body: 'not found' });
  });
  await page.addInitScript(freezeRaf);
  await page.addInitScript(seedScript(SEED));
  const hash = `#s=0&seed=${SEED}` + (p.hash ? '&' + p.hash : '');
  await page.goto('https://figures.local/index.html' + hash,
                  { waitUntil: 'load', timeout: 240000 });
  await page.waitForFunction('window.__scene && window.__scene.marbles.length > 0', { timeout: 240000 });

  /* One evaluate, ending with the render and the readback. Anything left to the
   * page's own animation loop between two evaluates is a source of drift: the
   * loop calls controls.update() every frame and damping moves the camera a
   * little each time, so parking it in one evaluate and reading the canvas in
   * the next slides the view by however many frames fitted in the gap. */
  const out = await page.evaluate(({ cam, target, steps }) => {
    const S = window.__scene;
    S.renderer.setAnimationLoop(null);          // first: nothing else touches the scene
    S.state.spin = false;
    S.controls.autoRotate = false;
    S.controls.enableDamping = false;           // so update() lands exactly
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('note').style.display = 'none';
    S.camera.position.set(cam[0], cam[1], cam[2]);
    S.controls.target.set(...(target || [0, 0, 0]));
    S.controls.update();

    // step() scales by state.timeScale, which the #s=0 set to zero to keep the
    // page's loop away from the simulation. Restore it, then advance by hand.
    S.state.timeScale = 1;
    for (let i = 0; i < steps; i++) S.step(1 / 60);

    /* Rendered twice, and the second one is the picture. transmission: 1
     * refracts a render target that is filled during a render, so the first
     * render has nothing but the clear colour behind the glass. */
    S.renderer.render(S.scene, S.camera);
    S.renderer.render(S.scene, S.camera);
    return { dataUrl: S.renderer.domElement.toDataURL('image/png'),
             marbles: S.marbles.length, curve: S.state.curve };
  }, { cam: p.cam, target: p.target, steps: STEPS });

  await page.close();
  return { ...out, errors };
}

/** Lay panels out side by side, with their labels, in one image. */
async function compose(name, fig) {
  const n = fig.panels.length;
  const pw = Math.floor(fig.w / n);
  const shots = [];
  for (const p of fig.panels) {
    const r = await panel(p, pw, fig.h);
    if (r.errors.length) console.error(`  ${name}: ${r.errors[0]}`);
    shots.push({ ...r, label: p.label });
  }

  // Compositing needs a canvas, and the simplest one to hand is a blank page.
  const page = await browser.newPage({ viewport: { width: 8, height: 8 } });
  const dataUrl = await page.evaluate(async ({ shots, w, h, pw }) => {
    const load = (src) => new Promise((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
    });
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d');
    g.fillStyle = '#05070c';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < shots.length; i++) {
      const img = await load(shots[i].dataUrl);
      g.drawImage(img, i * pw, 0);
      if (shots[i].label) {
        // Same family and weight as the page's own HUD, so the figures look
        // like they belong to it.
        g.font = '500 15px ui-sans-serif, system-ui, sans-serif';
        g.textBaseline = 'bottom';
        g.fillStyle = 'rgba(5, 7, 12, 0.55)';
        const tw = g.measureText(shots[i].label).width;
        g.fillRect(i * pw + 10, h - 32, tw + 16, 24);
        g.fillStyle = '#cfe0ff';
        g.fillText(shots[i].label, i * pw + 18, h - 13);
      }
      if (i) {                                  // hairline between panels
        g.fillStyle = 'rgba(140, 180, 255, 0.18)';
        g.fillRect(i * pw, 0, 1, h);
      }
    }
    return cv.toDataURL('image/png');
  }, { shots: shots.map((s) => ({ dataUrl: s.dataUrl, label: s.label })), w: pw * n, h: fig.h, pw });
  await page.close();

  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const file = path.join(DOCS, `${name}.png`);
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(file, png);
  console.log(`wrote ${path.relative(ROOT, file)} — ${pw * n}x${fig.h}, `
    + `${(png.length / 1024).toFixed(0)} kB, ${n} panel${n > 1 ? 's' : ''}`
    + ` (${shots.map((s) => `${s.marbles} on the ${s.curve}`).join('; ')})`);
}

for (const name of NAMES) await compose(name, FIGURES[name]);
await browser.close();
