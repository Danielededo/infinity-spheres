# Infinity Spheres ∞

A [Three.js](https://threejs.org/) scene in a **single `index.html`**: a closed **glass tube swept
along a Bernoulli lemniscate**, with 30 marbles of different colours and shades loose inside it. The
marbles fly freely in 3D, bounce elastically off each other and off the inner wall of the tube, and
pass through the open crossing at the centre of the ∞ to swap lobes.

**Demo:** https://danielededo.github.io/infinity-spheres/

No build step and nothing to install — Three.js is loaded from a CDN through an `importmap`.

---

## How it works

### The spine

The tube is a circle of radius `R = 2.4` swept along a Bernoulli lemniscate lying in the XY plane:

```
x(t) = a·cos t / (1 + sin²t)
y(t) = a·sin t·cos t / (1 + sin²t)
z(t) = 0
```

with `t ∈ [0, 2π)` and `a = 20`. The spine is a `THREE.Curve` subclass with
`arcLengthDivisions = 4000`, so `getPointAt(u)` is arc-length based — the same parametrisation
`TubeGeometry` uses internally, which keeps the mesh and the collision surface in agreement. The
spine is **104.88 units** long.

The curve genuinely self-intersects at the origin (at `t = π/2` and `t = 3π/2`), and that is the
point: the two branches merge into an open junction the marbles fly through.

### The solid

`TubeGeometry(curve, 1000, R, 56, true)` gives the closed tube. Its material is glass —
`MeshPhysicalMaterial` with `transmission: 1`, low `roughness`, `ior: 1.5`, `attenuationColor` and
`side: THREE.DoubleSide` — so you can see the marbles inside, refracted through the wall.

**Opening the crossing.** Where the two branches overlap, each one's wall runs straight through the
inside of the other, which would leave a pane of glass across the marbles' path. Those faces are
removed: a triangle is dropped when its centroid lies within `R` of a part of the spine that is more
than `0.08` (in normalised arc length) away from its own — a triangle-level stand-in for a CSG union.
6516 of the 112 000 faces get dropped.

That count is easy to check against theory. The lemniscate's tangents at the node are at ±45°, so the
two branches cross at exactly 90°, and for two perpendicular cylinders of equal radius the wall area
of each one lying inside the other is the Steinmetz result `8R²`. For both branches that predicts
`16R² = 92.2` units of area; the 6516 removed faces account for **92.0** — a 0.16% match.

Only spine samples close enough to a distant part of the curve for the tubes to overlap at all are
considered, so the trim touches a few thousand faces instead of scanning all 112 000 against every
sample.

### The physics

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
*union* of disks, so a point counts as inside when it is close to any part of the spine. Near the
origin that union is the X-shaped chamber, and the same wall code that keeps marbles in the tube lets
them cross between lobes with no special case.

The nearest point comes from a polyline of ~300 evenly spaced samples, then a projection onto the two
chords touching the winning sample, which turns the sampling error from `O(step)` into
`O(step²·curvature)`. Brute force over 300 samples for 30 marbles costs about 0.12 ms per frame, so
there is no spatial index.

**Sub-steps.** Elastic impacts between unequal masses hand a lot of speed to the light marbles — they
pass 39 units/s. Each frame is split so that no marble moves more than `0.45·rMin` per sub-step,
otherwise a fast pair would swap places instead of colliding.

### What was verified

The page exposes `window.__scene` (curve, marbles, `nearestOnSpine`, `step`) so the simulation can be
audited from the outside without waiting on the renderer. Driving its own `step()` for 90 simulated
seconds, checking after every frame:

| Check | Result |
| --- | --- |
| Marble outside the glass (162 000 centre-vs-wall checks) | worst excursion `1.8e-15` — never |
| Marbles crossing between lobes | 144 lobe changes |
| Kinetic energy, `restitution = 1` | drift 0.0000% |
| Physics cost | 0.12 ms/frame (0.76 ms at the 3× speed setting) |

Two known approximations, both measured:

- `TubeGeometry` is a 56-gon inscribed in the true cylinder, so its flat faces sit at `2.3962`
  instead of `2.4`. A marble pressed against the analytic wall can therefore poke through the drawn
  wall by up to `0.0038` units — 0.7% of the smallest marble radius.
- The junction seam is trimmed per triangle, so at extreme close-up its rim is visibly stepped at the
  scale of one face (~0.27 units around the circumference). At normal viewing distance it reads clean.

### Rendering

- Equirectangular environment **generated at runtime** on a `<canvas>` (gradient plus soft light
  blobs) and prefiltered with `PMREMGenerator`: glass and polished marbles get something to reflect
  and refract without downloading an HDRI.
- Hues spread over the whole colour wheel (`hue = i/n`), with saturation, lightness, `metalness`,
  `roughness` and `clearcoat` all varied per marble.
- Key light with `PCFSoft` shadows, rim light, two coloured point lights, exponential fog,
  `ACESFilmicToneMapping`, pixel ratio capped at 2.
- `OrbitControls` with damping and a slow auto-orbit.

## Controls

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Orbit | drag | — |
| Zoom | scroll / pinch | — |
| Pan | right-drag / two fingers | — |
| Pause | **Pause** | <kbd>space</kbd> |
| Show/hide the glass | **Glass** | <kbd>G</kbd> |
| Auto-orbit | **Spin** | <kbd>A</kbd> |
| Reset (new colours and velocities) | **Reset** | <kbd>R</kbd> |
| Show/hide the HUD | — | <kbd>H</kbd> |

The **Speed** slider scales time from 0 to 3×.

## Running it locally

The file uses ES modules, so it has to be served over HTTP — opening it as `file://` breaks the
module imports:

```bash
git clone https://github.com/danielededo/infinity-spheres.git
cd infinity-spheres
python3 -m http.server 8000
# then open http://localhost:8000
```

An internet connection is needed for the CDN. To run fully offline, install Three.js
(`npm i three@0.169.0`) and point the `importmap` in `index.html` at the local copy.

## Tuning

Everything lives in the `CONF` object at the top of the script:

```js
const CONF = {
  marbles: 30,        // how many spheres live inside the tube
  a: 20,              // lemniscate half-width
  tubeRadius: 2.4,    // R — inner radius of the glass tube
  rMin: 0.55,         // smallest marble radius
  rMax: 1.15,         // largest marble radius
  speedMin: 5.0,      // initial speed range, world units per second
  speedMax: 12.0,
  swirl: 0.35,        // transverse share of the initial velocity
  restitution: 1.0,   // 1 = perfectly elastic, for marbles and for the wall
  tubularSegments: 1000,
  radialSegments: 56,
};
```

Constraints worth respecting:

- **`rMax < tubeRadius`**, obviously — and keeping `rMax` near half of `R` leaves the marbles room to
  move across the bore instead of being wedged in a queue.
- **`marbles · 2·rMax < spine length`** (`≈ 5.24 · a`), or the marbles will not fit on the spine at
  startup and will begin overlapping. With the defaults, 30 marbles need at most 69 of the 104.88
  available.
- Dropping `restitution` below 1 makes the impacts lossy: the marbles bleed energy and settle.

## Deploying to GitHub Pages

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) publishes the repository to GitHub
Pages on every push to the default branch, and can also be run by hand from
**Actions → Deploy to GitHub Pages → Run workflow**.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Licence

[MIT](LICENSE).
