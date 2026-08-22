# How it works

The engineering behind [Infinity Spheres](../README.md), and the measurements behind the engineering.

It lives in its own file because a README should get someone to the demo and the controls, and this is
the other thing: derivations, convergence tables, the four failure modes that disqualify a candidate
curve, and a running record of which theories turned out to be wrong. Nothing here is required reading
to use the page.

- [The spine](#the-spine) — the curve, and why it has to self-intersect
- [The solid](#the-solid) — sweeping the tube, and cutting the junction open
- [The physics](#the-physics) — impulses, the wall, and the index that made the marble count possible
- [What was verified](#what-was-verified) — and how
- [How many fit](#how-many-fit) — what actually capped the count at 40
- [Other spines](#other-spines) — three that work, four reasons the rest do not
- [Rendering](#rendering) — the palette, the instancing, the quality switch
- [Sound](#sound) — derived from the impulses, and the rate problem that shaped it
- [Riding a marble](#riding-a-marble)
- [On a phone](#on-a-phone)
- [The energy readout](#the-energy-readout) — including the one place the physics is knowingly wrong
- [If the CDN is unreachable](#if-the-cdn-is-unreachable)
- [What the visual gate does and does not see](#what-the-visual-gate-does-and-does-not-see)
- [Reproducible figures](#reproducible-figures) — two ways a screenshot of this page lies

---

## The spine

The tube is a circle of radius `R = 2.4` swept along a closed curve in the XY plane. By default that
curve is a Bernoulli lemniscate:

```
x(t) = a·cos t / (1 + sin²t)
y(t) = a·sin t·cos t / (1 + sin²t)
z(t) = 0
```

with `t ∈ [0, 2π)` and `a = 20`. Every spine is a `THREE.Curve` subclass with
`arcLengthDivisions = 4000`, so `getPointAt(u)` is arc-length based — the same parametrisation
`TubeGeometry` uses internally, which keeps the mesh and the collision surface in agreement. This
one is **104.88 units** long; the others are 155.0 and 170.2.

The curve genuinely self-intersects — the lemniscate at the origin, at `t = π/2` and `t = 3π/2` —
and that is the point: the branches merge into an open junction the marbles fly through. Everything
downstream is resampled when the spine changes, so nothing below is specific to the lemniscate
except the numbers, which are quoted for it.

## The solid

`TubeGeometry(curve, 125, R, 56, true)` gives the closed tube, 14 000 triangles. Its material is glass —
`MeshPhysicalMaterial` with `transmission: 1`, low `roughness`, `ior: 1.5`, `attenuationColor` and
`side: THREE.DoubleSide` — so you can see the marbles inside, refracted through the wall.

**Opening the junction.** Where two branches overlap, each one's wall runs straight through the
inside of the other, which would leave a pane of glass across the marbles' path. Those faces have to
go, and the boundary of what goes matters: it is the curve where the two tubes intersect.

A triangle wholly inside the other branch is dropped. A triangle that *straddles* the boundary is
**clipped** — a signed distance field is evaluated at its three vertices, and where the sign changes
the triangle is split along that surface, keeping the outside part with position, normal and uv
interpolated. The crossing point starts from the linear guess and is then bisected eight times
against the real field, because linear interpolation across an edge this long is only first-order and
left the aperture 3.1% short. On the lemniscate: 588 triangles dropped, 480 clipped.

Clipping rather than dropping matters because the alternative was visible. Deciding per whole
triangle means the cut can only follow triangle edges, and neighbouring triangles land either side
of the true curve — a sawtooth about one ring deep, and the rings are `104.88 / 125 = 0.84` units
apart on the lemniscate. It was plainly visible at the junction.

Correctness is checked by convergence of the removed area rather than against a single figure:

| tubular segments | removed area | vs converged |
| --- | --- | --- |
| 125 | 91.568 | −0.6% |
| 250 | 91.845 | −0.3% |
| 500 | 91.997 | −0.15% |
| 1000 | 92.089 | −0.03% |
| 2000 | 92.111 | — |

It converges to 92.11. The lemniscate's tangents at the node are at ±45°, so the branches cross at
exactly 90°, and for two perpendicular cylinders of equal radius the wall area of each lying inside
the other is the Steinmetz result `8R²` — `16R² = 92.16` for both branches, a 0.05% match.

Worth recording: the drop-whole-triangle method scored *better* on total removed area — 92.31 at 125
segments, +0.2% against the converged value — while looking worse. Dropping whole triangles put the
boundary up to a full triangle either side of the true curve and the errors cancelled in the
aggregate. An area check cannot see this defect; only looking at the picture could.

Only spine samples close enough to a distant part of the curve for the tubes to overlap at all are
considered, so the trim touches a few thousand faces rather than scanning all 14 000 against every
sample. That share rises with the number of junctions — 23% of samples on the lemniscate, about 45%
on the three-junction spines — so switching spine costs a visible moment on a slow machine.

## The physics

Each marble is a free body with a position and a 3D velocity — no constraint to the curve, it just
happens to be trapped in a tube.

**Marble against marble** is an elastic impulse along the line of centres, with mass proportional to
volume (`m ∝ r³`):

```
j = −(1 + e)·(v_rel · n) / (1/m₁ + 1/m₂)
v₁ −= (j/m₁)·n        v₂ += (j/m₂)·n
```

applied only when the pair is actually closing in, followed by a positional split weighted inversely
by mass.

**Marble against the wall.** The tube is the set of all points within `R` of the spine, so a marble
of radius `r` is inside exactly while its centre is within `R − r` of the spine. Each step finds the
nearest point `q` on the spine; if `d = |centre − q| > R − r`, the velocity is mirrored about the
radial normal `n = (centre − q)/d` and the centre is placed back exactly on the limit surface:

```
v −= (1 + e)·(v · n)·n
centre = q + n·(R − r)
```

Taking the minimum distance over the **whole** curve is what makes the junction work: the tube is a
*union* of disks, so a point counts as inside when it is close to any part of the spine. At a
crossing that union is an X-shaped chamber, and the same wall code that keeps marbles in the tube
lets them pass between branches with no special case. This is also why a new spine needs no new
physics — nothing here knows which curve it is.

The nearest point comes from a polyline of evenly spaced samples — 300 on the lemniscate, 443 and 487
on the longer spines — then a projection onto the two chords touching the winning sample, which turns
the sampling error from `O(step)` into `O(step²·curvature)`.

Finding the closest sample is the innermost loop in the whole simulation: once per marble per solve
pass, four passes per sub-step. It used to scan every sample. It now goes through a **uniform grid**
over them — compressed rows, two `Int32Array`s, built once per curve, nothing allocated per query —
and looks at the 27 cells around the query, which holds about 40 samples away from the junction and
about 70 inside it. On its own that change took the step from **0.1605 ms to 0.0643 ms** at the
default 30 marbles; the current figure is 0.073, the difference being the shared pair-resolution
helper the two collision paths below now go through.

The cell size is the whole correctness argument. A sample more than one cell away in any axis is at
least `G_CELL` from the query, so a winner found closer than `G_CELL` cannot be beaten from outside
the neighbourhood. `G_CELL` has to exceed the farthest the true nearest sample can be for a point
the simulation asks about: a marble centre is within `R` of the spine and the nearest *sample* can
sit half a sample step beyond that, so 2.575. It is 3.0, and a query it cannot answer within that
bound — well outside the solid, which the physics never asks for but an external caller might —
falls back to the full scan. So this is an index, not an approximation.

Verified as exact rather than assumed: **300,000 queries per curve** against an independent
brute-force implementation of the same search, across five classes of query — inside the bore,
straddling the wall, inside the junction where two branches compete, anywhere in the bounding box,
and far outside it to exercise the fallback. Worst difference in both the distance and the returned
point, on all three curves: exactly **0**.

The scan it replaced had a quirk worth keeping on the record, because it is the kind of thing that
comes back. Making the spine switchable turned the sample count from a `const` into a binding, and
with a variable trip count V8 could no longer unroll the loop: 0.727 µs/call became 1.113 and the
step went 0.103 ms to 0.153. Hoisting the bindings into locals changed nothing, nor did preallocating
one buffer for the largest curve, nor rewriting the wrap arithmetic. The grid makes it moot — and
lands below the 0.103 the unrolled version managed.

**Sub-steps.** Elastic impacts between unequal masses hand a lot of speed to the light marbles — they
pass 39 units/s. Each frame is split so that no marble moves more than `0.45·rMin` per sub-step,
otherwise a fast pair would swap places instead of colliding.

## What was verified

The page exposes `window.__scene` (the curve, the marbles, `nearestOnSpine`, `step`, `totalEnergy`,
the renderer and camera, and the spine-derived values as getters) so the simulation can be audited
from the outside without waiting on the renderer. Driving its own `step()` for 90 simulated seconds,
checking after every frame:

| Check | Result |
| --- | --- |
| Marble outside the glass | worst excursion `1.8e-15` — never |
| Marbles crossing between branches | 154, exactly, every run |
| Total energy, `restitution = 1` | drift 0.000000% |
| Allocation per step | 0 |
| Physics cost, 30 marbles | 0.073 ms/step |

Containment is re-checked **per spine**, not only on the default one — see
[Other spines](#other-spines) for all three.

That crossing count used to be the one figure here that moved between runs — five runs of identical
code gave 155, 159, 170, 179 and 188 — and it is worth recording why, because the cause was in the
harness rather than in the page. The gate loop started from wherever two things had left the
simulation: the page's own animation loop, which advances it on wall-clock deltas for however long the
module takes to load, and the 2020 steps the `PHYS_MS` measurement drives just before. The first is not
reproducible and the second amplifies it.

The fix was one keystroke. Phase 4 already pressed **R** before capturing — a rebuild from the seeded
stream — which is why the screenshots were exactly reproducible while this was not. The gate loop does
the same now, so its 90 seconds start from a scene that is always identical, and the count is **154 on
the lemniscate, three runs out of three**. It also matches, to the digit, an independent measurement of
the same 90 seconds taken a different way — which is the sort of agreement that makes a number worth
trusting.

So the floor moved from 120 to 150. It stays a floor rather than an equality, because a deliberate
physics change should not have to edit a magic number, and higher is never the failure being guarded
against — the rosettes score 289 and 286. But a junction quietly sealing, or marbles wedging in one,
now fails on a drop of five rather than having to lose a third of the traffic first.

One known approximation, measured: `TubeGeometry` is a 56-gon inscribed in the true cylinder, so its
flat faces sit at `2.3962` instead of `2.4`. A marble pressed against the analytic wall can therefore
poke through the drawn wall by up to `0.0038` units — 0.7% of the smallest marble radius.

There used to be a second entry here, claiming the trimmed junction rim was stepped at the scale of
one face but "reads clean at normal viewing distance". It did not. The steps were obvious, someone
looking at the scene said so, and the junction is clipped rather than dropped now. Documenting a
defect as acceptable is a good way to stop looking at it.

## How many fit

The count went from 40 to a thousand, and it is worth writing down what was actually in the way,
because two of the three answers were not what they looked like.

**It was never the renderer.** Draw calls stay at **9** from 30 marbles to 998 — they are one
`InstancedMesh`, so the count barely touches the draw side at all.

**It was the seeding.** Marbles started single file on the centreline at `u = i/n`, which needs
`2·rMax` of arc each and runs out at `LENGTH / (2·rMax)` — 45 on the lemniscate. The bore is 2.4 wide
against marbles of at most 1.15, so a cross-section holds two of the largest or a handful of the
smallest, and none of that width was being used. Above the single-file cap the marbles are placed in
the bore instead, by rejection sampling: pick a station on the spine, pick a transverse offset,
keep it if it clears everything already placed. Below the cap the original scheme still runs, which
is what keeps the default 30-marble scene bit-for-bit what it was.

There is no containment test in that loop, and its absence is deliberate: the offset is at most
`R - r` from a point that lies *on* the spine, so the distance to the nearest point of the whole curve
is at most `R - r` as well — a competing branch can only be closer, never further. The marble is
inside by construction, and the test that used to be there was re-deriving a guarantee the arithmetic
already gives.

**And it was the collision loop.** All-pairs is O(n²): fine at 30 marbles and 435 tests, and the
reason the count could not go much past that. Above 64 marbles the pairs go through a grid of their
own instead. 64 is measured, not chosen — all-pairs genuinely wins below it:

| marbles | all pairs | grid | winner |
| --- | --- | --- | --- |
| 30 | 0.074 ms | 0.087 ms | pairs, 1.18× |
| 48 | 0.136 ms | 0.146 ms | pairs, 1.08× |
| 64 | 0.194 ms | 0.189 ms | grid, 1.03× |
| 128 | 0.662 ms | 0.479 ms | grid, 1.38× |
| 256 | 2.128 ms | 1.077 ms | grid, 1.98× |

Any index has to be built before it can be asked anything, and below 64 marbles the build alone costs
more than testing every pair.

**What it costs now.** Measured over 30 simulated seconds per row, containment re-checked every
frame:

| asked | size | placed | ms/step | share of a 60fps frame | fill | escapes | drift | top speed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 30 | 1.0× | 30 | 0.073 | 0.4% | 4.3% | 0 | 0.000000% | 34.4 |
| 128 | 1.0× | 122 | 0.543 | 3.3% | 19.0% | 0 | 0.000000% | 45.5 |
| 300 | 1.0× | 209 | 0.930 | 5.6% | 26.3% | 0 | 0.000000% | 46.8 |
| 600 | 0.55× | 600 | 3.968 | 23.8% | 15.1% | 0 | 0.000000% | 51.9 |
| 1000 | 0.5× | 998 | 6.357 | 38.1% | 18.8% | 0 | 0.000000% | 52.8 |

Not one marble ever left the tube and energy held exactly, at every count. The contact model did not
need loosening to get here.

**The ceiling is the packing, not the clock.** At full size the tube takes somewhere around 210 to 290
marbles — it is a random process, so the figure moves between builds — before rejection sampling stops
finding room, at roughly a quarter of the bore volume. At half size a thousand go in with room to
spare, and cost 38% of a frame. Asking for more than fits is not an error: the build grants what fits,
snaps the request down to it and says so in the readout.

Getting the build quick enough to sit on a slider drag took four goes, and two of the four theories
were wrong:

| change | build at a 1000-marble request |
| --- | --- |
| starting point | 2740 ms |
| grid-accelerate the clash test against placed marbles | *no change* |
| use the sampled spine instead of `curve.getPointAt` | 1454 ms |
| replace the cell `Map` with linked lists in flat arrays | 1040 ms |
| cut the per-marble attempt budget from 4000 to 400 | **84 ms** |

`getPointAt` binary searches a 4000-entry arc-length table and `getTangentAt` does it three times over
for the finite difference, once per attempt. And the attempt budget turned out to buy latency and
almost no marbles: near saturation whether a marble finds room is luck rather than persistence, so 400
attempts grant 251 and 4000 grant 264, for seven times the wait.

**Trails are capped at 40 marbles**, whatever the count. Their line buffer is rebuilt on the CPU every
frame — 47 segments per marble, two vertices each, position and colour — and one draw call does not
make that free: timed in isolation at 998 marbles, 1.256 ms per frame for all of them against 0.076 ms
for 40. That is 7.5% of a frame budget spent on something nobody can see, because past a few dozen the
lines overlap into one bright tangle.

**What is still cheap** is the drawing. At 998 marbles `renderer.render` takes 1.1 ms against 1.3 ms
at 30 — 2.98 million triangles versus 129 thousand, and 9 draw calls either way. The frame at the
ceiling is roughly 7.5 ms, and 6.4 of that is physics.

One thing more marbles is not: more of the same. The top-speed column above tells that story — 34
units at the default, 53 once the tube is full — and the scene becomes a churn rather than marbles
flying freely down a mostly empty tube. **Packed** and **Shoal** under **more** are the two settings
worth starting from.

## Other spines

Under **more → spine** the tube can be swept along a different closed curve. The physics does not care
which: containment is "the marble's centre stays within `R - r` of the nearest point on the spine", and
the junction trim finds crossings by searching the spine for branches that come within `2R` of each
other at distant arc positions. Both are curve-agnostic, so a new spine needs no new physics.

| spine | crossings | angle | length | tightest bend | capacity |
| --- | --- | --- | --- | --- | --- |
| Lemniscate | 1 | 90° | 104.9 | 2.78 R | 45 |
| Trefoil | 3 | 75.6° | 170.2 | 2.78 R | 74 |
| Clover | 3 | 86.6° | 155.0 | 1.90 R | 67 |

All three are scaled to the same bounding radius, so the camera framing does not change between them.
Measured with the harness's own gate loop — 90 simulated seconds, three runs per spine, containment
re-checked every frame:

| spine | crossings | escapes | worst excursion | energy drift |
| --- | --- | --- | --- | --- |
| Lemniscate | 154 | 0 | `1.78e-15` | 0.000000% |
| Trefoil | 289 | 0 | `1.78e-15` | 0.000000% |
| Clover | 286 | 0 | `2.00e-15` | 0.000000% |

Three runs per spine, and every column repeated exactly — the page is loaded with `#s=0` so its own
animation loop cannot advance the simulation before the measurement starts, which is what makes the
crossing count reproducible here and not in the harness. The excursions are floating-point noise at the
scale of the coordinates, not near-misses. Crossings run about 1.9 times higher on the three-junction
spines, which is the number that matters: marbles really do pass through the new junctions rather than
getting wedged in them, and a junction that had silently sealed would show up here as a collapse, not a
wobble.

Most candidate curves fail, and it is worth knowing why:

- **A 3D trefoil knot never self-intersects.** Its closest approach between distant arc positions is
  8.10 against `2R = 4.8`, so the trim finds nothing to open and you get a sealed glass knot.
- **The glass and the marbles need different depths.** The trim cuts a hole once branches are within
  `2R = 4.8`; a marble only fits through once they are within `2(R - r)`, which is 2.50 for the largest.
  In between you get a visible aperture with an invisible wall behind it.
- **The tightest bend must stay wider than the bore.** Every Lissajous curve tried failed here (bend
  radius 1.33, 0.83, 0.21 against `R = 2.4`) — the tube pinches shut at the bend. So did the 3-petal
  rose, at 2.00.
- **Branches must cross, not merge.** The 4-petal rose has pairs meeting at 0° — collinear through the
  origin, staying within `2R` for about 20 units of arc — so the trim would delete a long slot rather
  than cut an X.

`#c=trefoil` or `#c=clover` in the URL selects one.

## Rendering

- Equirectangular environment **generated at runtime** on a `<canvas>` (gradient plus soft light
  blobs) and prefiltered with `PMREMGenerator`: glass and polished marbles get something to reflect
  and refract without downloading an HDRI.
- **Six hues, not the whole wheel.** The hues used to be `i/n`, an even sweep of the colour circle.
  Thirty marbles spaced evenly around it read as a test pattern: every hue present, none chosen, and
  the muddy yellow-greens between the good colours getting equal billing. There are six now — coral,
  amber, jade, cyan, deep blue, violet — unevenly spaced, each with its own saturation and lightness
  window, because what looks right varies with hue: the amber has to be brighter and more saturated
  than the deep blue to read as the same weight against a dark ground. Each is jittered slightly so
  two marbles of one hue are not identical.
- The swatch is **hashed from the marble index**, not cycled. Marbles are seeded evenly along the
  spine by index, so `i % 6` would put the same colour at the same spacing all the way round — six
  colours in strict rotation, which looks mechanical and breaks when the count is not a multiple of
  six. The hash costs no random draw, so the arrangement and the velocities are bit-for-bit what they
  were and only the colours moved.
- `metalness`, `roughness`, `clearcoat` and `clearcoatRoughness` are varied per marble as well.
- **All the marbles are one `InstancedMesh`.** Thirty separate meshes cost thirty draw calls in the
  colour pass, thirty more filling the shadow map, and thirty more again in the extra pass the
  glass's transmission forces — which is where nearly all of the frame's draw calls were going. An
  `InstancedMesh` carries one material, though, and these marbles differ in finish as well as in
  colour: colour rides along per-instance for free (`instanceColor`), and the other four values go in
  as an instanced `vec4` patched into the standard physical shader with `onBeforeCompile`. So it is
  still the picture that was there before, not forty identically polished balls — and the SSIM gate
  is what keeps that claim honest. Measured: 67 draw calls down to **9**, and the frame time on the
  CPU rasteriser the harness runs on down by 65%.
- Key light with `PCFSoft` shadows, rim light, two coloured point lights, exponential fog,
  `ACESFilmicToneMapping`, pixel ratio capped at 2.
- A **quality switch** (**Quality** / <kbd>Q</kbd>) trades the two things that cost the most on a
  weak GPU: *fast* drops the pixel ratio to 1 and turns the shadow map off, *high* restores both.
  It defaults to *fast* on a coarse pointer — a phone — and to *high* elsewhere, and it is the one
  setting always written into the URL hash, because a link that left it out would not reproduce on
  another machine.
- `OrbitControls` with damping and a slow auto-orbit.

## Sound

Every click is derived from the collision that caused it. `solveMarbles` already computes the impulse
`−(1+e)·v_n / (1/m₁ + 1/m₂)` for each pair that closes, and `solveWall` applies `m·(1+e)·v_n` at the
glass; those are the numbers that set loudness. Radius sets pitch, because a sphere's ringing modes go
as `1/r` — so over the 0.55–1.15 radius range the small marbles tick and the large ones knock, about an
octave apart. Everything is synthesised: samples would mean asset files, and this page is one file with
no build step.

### The rate problem

The interesting constraint is how many impacts there are, which was measured rather than guessed —
per simulated second, after letting each scene settle:

| configuration | marble | wall | total |
| --- | --- | --- | --- |
| 30, zero g | 37 | 90 | **127** |
| 30, gravity | 97 | 179 | **276** |
| 168 (Packed) | 2 046 | 1 321 | **3 367** |
| 168, gravity | 3 476 | 2 033 | **5 509** |
| 998 small | 15 614 | 5 029 | **20 643** |
| 998 small, gravity | 30 565 | 8 719 | **39 284** |

A voice per impact is therefore out at *any* count: even the default would create 127 oscillators a
second, and the top of the range is three hundred times that. So each frame keeps only the three
hardest impacts and drops the rest. At 30 marbles that is about two per frame and almost nothing is
lost; at 998 it is a 200-to-1 decimation, and selecting by impulse means what survives is what a
listener would have picked out anyway.

The bias is worth naming rather than hiding: always taking the loudest makes the quiet texture of a
dense scene disappear rather than thin out. A random survivor among the loud ones would keep more of
that texture, at the cost of a rule nobody could predict from the code.

Loudness is normalised against a reference impulse derived from the current mass and speed scale, not
against a constant, because the impulse distribution moves by 6× between presets — median 7.9 at 30
marbles against 0.94 at 998 small ones, since mass goes as `r³`. A fixed mapping would have left Shoal
inaudible.

The queue the solvers write into is three fixed-size typed arrays with an insertion sort over three
slots. It has to be: it runs inside the physics loop, where `ALLOC_PER_STEP` is gated at zero. Web
Audio is never touched from in there — the queue is drained once per frame from the animation loop.

### Making sure it does not clip

Two attempts, and the first was wrong in an instructive way.

A `DynamicsCompressor` as a limiter **did not hold**: rendered peaks reached 1.0131 on Shoal and 0.9943
with gravity. A compressor has an attack time, and every event here *is* a transient, so 2 ms of attack
against clicks arriving 180 times a second is no defence at all.

A `WaveShaper` has no time constant. Below the knee it is a straight line, so ordinary impacts pass
through untouched; above it the curve bends, and since a waveshaper clamps its input to `[-1, 1]` the
output cannot pass the curve's endpoint. That endpoint is `0.6 + 0.4·tanh(1) = 0.9046`.

The second correction: `oversample` has to be `'none'`. With `'4x'` the resampling filters ring and
overshoot the endpoint, so the bound stops being one:

| simultaneous voices | `oversample: '4x'` | `oversample: 'none'` |
| --- | --- | --- |
| 20 | 0.9078 | 0.9046 |
| 60 | **1.0568** | 0.9046 |
| 200 | **1.2711** | 0.9046 |

Oversampling exists to stop a nonlinearity aliasing, and it costs nothing here because below the knee
this curve is not a nonlinearity at all — it is exactly linear, which is where every ordinary signal
lives. The bend only ever sees a pile-up.

### What was verified

The synth is not tested by a reimplementation of itself. `audioGraph` and `audioVoice` take the audio
context as a parameter precisely so the shipping code can be rendered into an `OfflineAudioContext` and
measured — a test that rebuilt an equivalent graph would only ever prove the copy behaves, and would go
on passing after the original changed.

| check | result |
| --- | --- |
| Pitch follows `1/r` | expected 1391 / 900 / 665 Hz at r = 0.55 / 0.85 / 1.15, measured 1375 / 889 / 657 |
| One voice | peak 0.267 (−11.5 dBFS) |
| Three at once, the frame cap's worst case | 0.561 |
| Three every frame for a second | 0.551 |
| 20, 60, 200 voices at once | 0.9046 in all three — the bound holds |
| Click decays | −70 dB by the stated decay time, silent at twice it |
| Queue keeps the loudest | five cases including ties and under-fill, all correct |

The measured pitches sit about 1.2% below the target because of the deliberate downward pitch drift a
struck object has as it rings, which pulls the spectral peak down.

Whole runs are also rendered to WAV through the real simulation and the real selection rule, which is
how the level and density were judged by ear rather than by argument: peaks 0.58 (default), 0.77
(gravity), 0.71 (Packed), 0.83 (Shoal).

## Riding a marble

Click any marble to select it — the raycast only tests the marbles, so the glass does not shield them
and you can pick one you can see *through* the tube. The panel then shows its radius, mass and current
speed, and a soft ring marks it in the scene.

**Ride a marble** puts the camera behind the selected one and points it down the tube. It follows a
smoothed heading rather than anchoring to the spine: anchoring means reading the nearest point on the
curve, and at the crossing the nearest branch flips, which would throw the view sideways at exactly the
interesting moment. The spine is still used, but only as a clamp — if the smoothing would push the eye
through the glass it gets pulled back toward whichever branch is nearest, and nearest is always inward.
Measured over a settled run: the eye stays 0.66 to 1.69 units from the spine, inside the 1.90 the clamp
allows, against a bore radius of 2.4.

`#f=1` in the URL arrives already riding.

## On a phone

The panel is a bottom bar within thumb reach and it **starts folded**, so opening the page gives you
the scene rather than a screen of controls. Tapping **▼** unfolds it; it scrolls internally when the
window is too short for every control, and buttons and sliders get 40px touch targets. The same fold
button appears on a desktop, where the panel starts open.

The camera also re-frames itself on a portrait window. Held upright, a phone's *horizontal* field of
view is the tight one and the lobes fall outside it — so the camera pulls back to fit the figure
vertically with margin, 66 units on a 390×844 phone against 50 in landscape. It does not pull back far
enough to fit the lobes horizontally: that needs 111 units, and `FogExp2` at that depth has taken 59%
of the image. Rotating the device re-frames, unless you have moved the camera yourself.

A reduced-motion preference (`prefers-reduced-motion`) starts with **Spin** off — the idle orbit is the
only thing here that moves without being asked — and drops the panel transitions. It is deliberately
not part of the URL hash, so a shared link cannot override the setting you chose in your own OS.

## The energy readout

The panel shows total energy, kinetic plus gravitational. It is the number worth watching: at the
default settings it does not move at all, however many thousands of impacts have accumulated, because
the collisions are exactly elastic. Two things make it fall, and it reports both rather than hiding
them:

- **Elastic below 1** — by construction. That is what restitution means.
- **Gravity on** — about 22% over 90 simulated seconds, and *not* because of the integrator. The
  contact model puts a marble back exactly on the limit surface, and that projection is energetically
  free only when there is no potential; with gravity it quietly changes `mgh` on every one of thousands
  of wall contacts. Accounting for the work that projection does needs a considerably more elaborate
  solver than a toggle justifies, so the drift is measured and displayed instead. At zero g the same
  code holds total energy to **0.000000%** over the same 90 seconds.

## If the CDN is unreachable

The page is one file that fetches `three@0.169.0` at runtime, so a blocked CDN used to mean a black
screen with nothing to explain it. There is now a loading card from the first paint, and after 12
seconds without the module it says what failed and what it was trying to fetch.

## What the visual gate does and does not see

`SSIM_MIN` compares *structure*, and it turns out that is not enough for a scene whose most variable
feature is the colour of a few hundred spheres. Measured by running the harness against deliberately
altered pages:

| change | SSIM_MIN | | CHROMA_MAX | |
| --- | --- | --- | --- | --- |
| nothing changed | 1 | pass | **0** | pass |
| every hue +0.02 | 0.99793 | pass | 0.9008 | **FAIL** |
| every hue +0.08 | 0.9845 | pass | 3.1793 | **FAIL** |
| roughness +0.05 | 0.99929 | pass | 0.1163 | **FAIL** |

Three real changes to how the marbles look, all three waved through by SSIM — the most extreme of them
clearing the 0.98 threshold by 0.0045 — because the marbles stay in the same places with the same
shading and simply wear different colours, which is precisely what SSIM forgives.

`CHROMA_MAX` closes that. It is the mean of `|Δ(R−G)|` and `|Δ(B−G)|` over the frame: a shading change
moves all three channels together and cancels in both differences, while a colour change does not.
Unmodified code scores exactly zero rather than nearly zero, which is what lets the threshold be as
tight as 0.05.

What it still does not do: both metrics average over the whole frame, and the marbles occupy 8% to 19%
of it depending on the pose — measured by hiding them and counting the pixels that move, with
`junction` densest and `oblique` sparsest. Hiding the glass makes that *worse* rather than better,
because refraction spreads each marble's influence well beyond its own silhouette, which is why there
is no glass-free pose. So a change to one marble in one place is still diluted; what is now covered is
a change to how the marbles look in general.

## Reproducible figures

Every image in `docs/` comes from `npm run figures`, and three consecutive runs produce byte-identical
files. That is worth having — it means a diff in `docs/` is a real rendering change rather than noise —
and getting there turned up three separate ways a screenshot of this page can lie about itself. All
three apply to anything that photographs a Three.js scene, so they are worth writing down.

**Park the camera and render in the same evaluation.** `OrbitControls` damping moves the view a little
on every `update()`, and the page's idle orbit is on by default. Setting the camera in one step and
reading the canvas in another lets the view slide by however many frames fitted in the gap. Measured
cost of getting this wrong, on a revision that was in fact pixel-identical: SSIM 0.774.

**Read the canvas, not the compositor.** Without `preserveDrawingBuffer` the drawing buffer is only
valid immediately after a render, so `toDataURL` in the same task is the only reliable read.
`page.screenshot` goes through the compositor, which — with the render loop stopped — is in no hurry to
produce a frame, and the workarounds for that are all guesses about someone else's scheduler.

**Stop the page from drawing at all.** This one took the longest. `transmission: 1` makes the glass
refract a render target that carries over between frames, so what the glass shows depends on what was
rendered before it. Three.js drives its loop from `requestAnimationFrame`, so a frame or two slips in
between the module loading and the script taking over — and *how many* depends on how busy the machine
is. The symptom was output that flipped between two states, and rendering two, three or four times
before reading the canvas did not settle it, because the input was varying rather than the convergence.
Swallowing every `requestAnimationFrame` callback removes the variable entirely: the page never draws a
frame of its own, and the figure script sets the camera and renders by hand.

Before that last fix, two runs of identical code differed across 2.4% of pixels with a mean channel
difference of 1.4 — invisible to look at, and exactly the kind of noise that makes a diff useless.

The same three apply to the harness's own screenshots, which is why `bench.mjs` does the first two.
It gets away without the third because it presses **R** before capturing, rebuilding the scene from the
seeded stream, which happens to wash out the difference.
