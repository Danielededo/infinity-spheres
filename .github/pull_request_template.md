## What this changes

<!-- One or two sentences. -->

## Why

<!-- What problem this solves, or what measurement motivated it. -->

## Checks

- [ ] `npm run check` passes
- [ ] `npm run bench:gates` passes (no marble escapes, no energy drift, marbles still change lobe)
- [ ] For a change that touches the render: `npm run bench` and the SSIM gate still holds at >= 0.98,
      or the reference images were regenerated deliberately with `npm run bench:ref`
- [ ] For a performance claim: the metric, the before and the after are in the commit message

<!-- Frame time on a CPU rasteriser carries ~27% run-to-run variance; prefer
     exact counters (triangles, draw calls, allocations) for any claim. -->
