#!/usr/bin/env node
/**
 * Cheap consistency checks, meant for CI and for `npm run check`.
 *
 * 1. index.html pins a three.js version in its importmap and package.json
 *    pins one for the harness. If they drift, the benchmark measures a
 *    different library than the page ships, so the harness refuses to run and
 *    this catches it before that happens.
 * 2. index.html has balanced structural tags. It is a single hand-edited file
 *    with no build step, so nothing else would notice an unclosed block.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
};

// 1. pinned versions agree
const pageVersions = [...html.matchAll(/three@([0-9]+\.[0-9]+\.[0-9]+)/g)].map((m) => m[1]);
const unique = [...new Set(pageVersions)];
check(unique.length === 1, 'index.html pins one three version', unique.join(', ') || 'none found');
const pinned = pkg.devDependencies?.three?.replace(/^[^0-9]*/, '');
check(unique[0] === pinned, 'index.html and package.json agree on three',
  `page ${unique[0]}, package.json ${pinned}`);

// 2. structural tags balance
for (const tag of ['html', 'head', 'body', 'script', 'style']) {
  const open = (html.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  check(open === close, `<${tag}> balanced`, `${open} open, ${close} close`);
}

// 3. the things the page promises about itself
check(/transmission:\s*1/.test(html), 'glass keeps transmission: 1');
check(/closed|true \)/.test(html) && /TubeGeometry\(/.test(html), 'tube geometry present');
check(html.includes('openCrossing'), 'crossing trim present');

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
