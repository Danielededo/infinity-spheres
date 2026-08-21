# bench

Measurement harness for `index.html`. Nothing here ships with the page; the page
is never modified to be measured.

```bash
npm i playwright three@0.169.0        # the three version index.html pins
node bench/bench.mjs                  # writes bench/metrics.json
```

If `three` is not inside the repo, point the harness at it:
`THREE_DIR=/path/to/node_modules/three node bench/bench.mjs`.

## How it avoids touching the page

Every hook is injected by the harness:

- The CDN request for three.js is intercepted and served from `node_modules`
  with two one-line source patches: a counter inside the real `Vector3`
  constructor (so three's own allocations are counted too, not just the page's),
  and a hook inside `renderer.render` that hands the harness the live renderer,
  scene and camera. The files to patch are found by walking the entry point's
  relative-import graph, because newer three releases split the bundle.
- `OrbitControls.prototype.update` is wrapped to expose the controls instance,
  so auto-rotation and damping can be switched off.
- `Math.random` is replaced with a seeded mulberry32 before page scripts run, so
  marble radii, colours, speeds and start velocities are identical every run.
- The simulation is advanced by an exact number of fixed-size `step()` calls
  rather than by wall-clock delta, which is what makes the screenshots
  reproducible enough to compare with SSIM.

## Metrics

| Key | Meaning |
| --- | --- |
| `FRAME_P95` / `FRAME_P50` | p95/p50 of the frame-to-frame interval, in ms |
| `FRAME_CPU_P95` | p95 of time spent inside the animation callback |
| `FPS_EFFECTIVE` | 1000 / mean frame interval |
| `PHYS_MS` | mean cost of one `step()`, measured in isolation with rendering paused |
| `TRIS`, `DRAWCALLS` | `renderer.info.render`, sampled at the end of a frame |
| `PROGRAMS`, `GEOMETRIES`, `TEXTURES` | `renderer.info` |
| `HEAP_MB` | `usedJSHeapSize` after a forced GC |
| `HEAP_GROWTH_MB` | heap delta between frame 200 and frame 2200, both after GC |
| `ALLOC_FRAME` | median `Vector3` constructions per frame |
| `ALLOC_PER_STEP` | `Vector3` constructions per physics step |
| `ESCAPED`, `ENERGY_DRIFT_PCT`, `LOBE_CHANGES` | physics gates over 90 simulated seconds |
| `SSIM` | per-pose SSIM against `bench/ref/*.png`, worst of four planes |
| `CHROMA` | per-pose mean colour-opponent difference against the same references |

`SSIM` is the **minimum** of four separate comparisons — luminance, R, G and B —
not a single grayscale one. Luminance alone was measured to be blind to the
change it most needed to catch: shifting every palette hue by 0.08 at constant
saturation and lightness, a plainly different set of colours, scored 0.99999 and
passed. Four planes brought the same shift to 0.9845, which *still* passes the
0.98 threshold — by 0.0045.

So SSIM does not gate colour, and `CHROMA_MAX` is there because of it. It is the
mean of |Δ(R−G)| and |Δ(B−G)| over the frame: a shading change moves all three
channels together and cancels, a colour change does not. Every row below is a
full phase-4 run against a deliberately altered page:

| change | SSIM_MIN | | CHROMA_MAX | |
| --- | --- | --- | --- | --- |
| nothing changed | 1 | pass | **0** | pass |
| every hue +0.02 | 0.99793 | pass | 0.9008 | **FAIL** |
| every hue +0.08 | 0.9845 | pass | 3.1793 | **FAIL** |
| roughness +0.05 | 0.99929 | pass | 0.1163 | **FAIL** |

Three real changes to how the marbles look, all three waved through by SSIM and
all three caught by chroma. Unmodified code scores exactly zero rather than
nearly zero, which is what lets the threshold be as tight as 0.05.

Worth being clear about what this does *not* fix: both metrics still average over
the whole frame, and the marbles occupy 8% to 19% of it depending on the pose
(`junction` is the densest, `oblique` the sparsest — measured by hiding the
marbles and counting the pixels that move). Hiding the glass makes that *worse*,
not better, because refraction spreads each marble's influence well beyond its
own silhouette. So a change to one marble in one place is still diluted; what is
now covered is a change to how the marbles look in general.

## Reading FRAME_P95

This machine has no GPU: Chromium rasterises through SwiftShader on the CPU.
Two consequences:

- `TRIS`, `DRAWCALLS`, `PROGRAMS`, `GEOMETRIES`, `TEXTURES`, the allocation
  counters and the physics gates are hardware independent.
- `FRAME_P95` and `PHYS_MS` are CPU numbers. They are valid for comparing one
  revision against another on this machine, which is what the goals are
  expressed as ratios for, but they are not predictive of absolute frame times
  on a GPU. Fill-rate-bound work (the transmission pass, shadow maps) is
  over-weighted relative to a real GPU; draw-call count and triangle count are
  under-weighted.

The default viewport is 320x200 for the same reason: at 480x300 this scene runs
at 0.89 fps here and a full run would take over an hour. Every revision is
measured at the same viewport.

## Why three.js is pinned

`three-0.185.1-rejected.json` records a measured upgrade attempt. With `index.html` bumped to 0.185.1
as well, SSIM against the references falls to 0.887 / 0.892 / 0.635 and draw calls rise 67 → 97, both
far outside the harness's noise. 0.180.0, by contrast, measured pixel-identical (0.99935 / 0.99856 /
1.000), so the regression is somewhere between those two and a future upgrade should bisect that range.
Physics is unaffected either way.

Both of those were measured before the marbles were instanced and before the `junction` pose existed,
which is why there are three SSIM values and why the draw-call figures start from 67 rather than
today's count. The conclusion still holds — a rendering regression that large is not going to have
been an artefact of the draw-call path — but the numbers are a record of that experiment, not
current readings.

A three upgrade therefore has to change `index.html`'s importmap and `package.json` together, and be
checked with `npm run bench` before the references are touched.

## Reference images

`bench/ref/*.png` are the baseline screenshots for the SSIM gate, at four fixed
camera poses, taken after exactly 300 fixed-size simulation steps with the HUD
hidden. Regenerate them only when a change to the render is intended:

```bash
node bench/bench.mjs --write-ref
```

The four poses:

| pose | camera | radius | what it is for |
| --- | --- | --- | --- |
| `front` | `6, 12, 48` | 49.8 | the whole figure, the shot the page opens on |
| `oblique` | `34, 20, 30` | 49.6 | the same figure lit from the side, so shading changes show |
| `close` | `1, 5, 15` | 15.8 | near enough for one marble's finish to matter |
| `junction` | `0, 2.7, 5.6` | 6.2 | inside the crossing, where the trim and the clip live |

`junction` is deliberately uncomfortable. An earlier version of it sat at radius 12.3, and at that
distance a genuinely broken junction rim — the sawtooth left by dropping whole triangles instead of
clipping them — still scored 0.98993 and passed the gate. Pulled in to 6.2 the same defect scores
0.95167 and fails. A pose that cannot fail is decoration.
