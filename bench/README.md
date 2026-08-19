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
| `SSIM` | per-pose SSIM against `bench/ref/*.png` |

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

## Reference images

`bench/ref/*.png` are the baseline screenshots for the SSIM gate, at three fixed
camera poses, taken after exactly 300 fixed-size simulation steps with the HUD
hidden. Regenerate them only when a change to the render is intended:

```bash
node bench/bench.mjs --write-ref
```
