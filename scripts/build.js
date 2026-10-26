#!/usr/bin/env node
// Bundles the review page (client/review.js and @pierre/diffs) into public/build.
// The dashboard and server need no build; only the review page does.

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const outdir = join(root, 'public', 'build');

rmSync(outdir, { recursive: true, force: true });
await build({
  entryPoints: [join(root, 'client', 'review.js')],
  bundle: true,
  format: 'esm',
  // Syntax-highlighting grammars load on demand, one chunk per language.
  splitting: true,
  outdir,
  minify: true,
  sourcemap: true,
  target: 'es2022',
  logLevel: 'warning',
});
console.log('Built review page into public/build');
