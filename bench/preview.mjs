/* Renders docs/preview.png — the hero image in README.md and the og:image the
 * social-preview tags point at.
 *
 * It is here rather than in bench.mjs because it is not a measurement: nothing
 * it produces is gated. It shares the harness's two habits, though, because
 * both matter for a picture that has to be regenerated and recognised as the
 * same shot months later:
 *
 *  - Math.random is replaced with the same seeded mulberry32 before page
 *    scripts run, so the marbles get the same radii, colours and start
 *    velocities every time.
 *  - The simulation is advanced by an exact number of fixed-size step() calls
 *    rather than by wall-clock delta, so the arrangement is the same too.
 *
 * It adds one thing the harness does not, and needs it: the page is loaded with
 * `#s=0`, which sets the time scale to zero, so the page's own animation loop
 * cannot advance the simulation at all while the module loads and the first
 * frames go by. The scale is restored here and the 300 steps are driven from a
 * state that is exactly as built. Without that, the shot depends on how many
 * real frames fitted into the load — two runs of identical code then differ,
 * which is how a rendering change becomes impossible to see in the diff.
 *
 *   node bench/preview.mjs                    # writes docs/preview.png
 *   node bench/preview.mjs /tmp/try.png       # somewhere else
 *   CAM='[4,10,40]' node bench/preview.mjs    # move the camera
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || path.join(ROOT, 'docs/preview.png');

const CFG = {
  width: 1400,                 // matches og:image:width / og:image:height
  height: 700,
  seed: 20260819,              // the harness's seed, so this is the reference scene
  steps: 300,                  // same settling point the reference screenshots use
  // Far enough out to leave a margin around the lobes, close enough that the
  // marbles read as marbles. Slightly above the plane, so the figure is seen
  // as a solid rather than as a flat outline.
  cam: JSON.parse(process.env.CAM || '[4, 10, 40]'),
};

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const THREE_VERSION = html.match(/three@([\d.]+)/)[1];
const THREE_DIR = process.env.THREE_DIR || path.join(ROOT, 'node_modules/three');

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
const page = await browser.newPage({
  viewport: { width: CFG.width, height: CFG.height },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

// Serve three from node_modules and the page from a local origin, so this runs
// with no network.
await page.route(`https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/**`, (route) => {
  const p = new URL(route.request().url()).pathname.replace(`/npm/three@${THREE_VERSION}/`, '');
  try {
    route.fulfill({ status: 200, contentType: 'text/javascript',
                    body: fs.readFileSync(path.join(THREE_DIR, p), 'utf8') });
  } catch (e) {
    route.fulfill({ status: 404, body: String(e) });
  }
});
await page.route('https://preview.local/**', (route) => {
  const p = new URL(route.request().url()).pathname;
  if (p === '/index.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  route.fulfill({ status: 404, body: 'not found' });
});

await page.addInitScript(seedScript(CFG.seed));
await page.goto(`https://preview.local/index.html#s=0&seed=${CFG.seed}`,
                { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__scene && window.__scene.marbles.length > 0', { timeout: 120000 });

/* Everything happens inside one evaluate, ending with the render and the
 * readback, because anything left to the page's own animation loop between two
 * evaluates is a source of drift. Two in particular:
 *
 *  - The loop calls controls.update() every frame, and damping means each call
 *    moves the camera a little further toward its target. Park the camera in one
 *    evaluate and read the canvas in the next and the view has slid between them
 *    by however many frames fitted in the gap.
 *  - Reading the canvas is only valid immediately after a render: without
 *    preserveDrawingBuffer the buffer is cleared, and screenshotting the
 *    compositor instead can catch a half-composited frame.
 *
 * Both make identical code produce different bytes, which is exactly what this
 * script exists to avoid. */
const out = await page.evaluate(({ steps, cam }) => {
  const S = window.__scene;
  S.renderer.setAnimationLoop(null);       // first: nothing else may touch the scene

  // The idle orbit and the panel are both wrong for a still: one makes the
  // camera depend on when the shot was taken, the other is UI.
  S.state.spin = false;
  S.controls.autoRotate = false;
  S.controls.enableDamping = false;        // so update() lands exactly, not gradually
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('note').style.display = 'none';
  S.camera.position.set(cam[0], cam[1], cam[2]);
  S.controls.target.set(0, 0, 0);
  S.controls.update();

  // step() scales by state.timeScale, which the #s=0 in the URL set to zero to
  // keep the page's loop from touching the simulation. Restore it, then advance
  // by hand.
  S.state.timeScale = 1;
  for (let i = 0; i < steps; i++) S.step(1 / 60);

  /* Rendered twice, and the second one is the shot.
   *
   * transmission: 1 makes three render the scene into a target that the glass
   * then refracts. That target is filled during the render, so the first render
   * after the camera moves refracts a backdrop drawn from wherever the camera
   * used to be — and the page's idle orbit has been moving it throughout the
   * load. The result is a faint, figure-wide difference between runs that scales
   * with how long the load took: 6.9% of pixels, mean delta 1.5, before this
   * second render. */
  S.renderer.render(S.scene, S.camera);
  S.renderer.render(S.scene, S.camera);
  return { dataUrl: S.renderer.domElement.toDataURL('image/png'),
           curve: S.state.curve, marbles: S.marbles.length, quality: S.state.quality };
}, { steps: CFG.steps, cam: CFG.cam });

const info = out;
const png = Buffer.from(out.dataUrl.slice(out.dataUrl.indexOf(',') + 1), 'base64');
fs.writeFileSync(OUT, png);

console.log(`wrote ${path.relative(ROOT, OUT)} — ${CFG.width}x${CFG.height}, `
  + `${(png.length / 1024).toFixed(0)} kB, ${info.marbles} marbles on the ${info.curve}, `
  + `quality ${info.quality}, camera [${CFG.cam.join(', ')}], step ${CFG.steps}`);
if (errors.length) {
  console.error('page errors:\n  ' + errors.join('\n  '));
  process.exitCode = 1;
}
await browser.close();
