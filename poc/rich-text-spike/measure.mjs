/**
 * The number the decision turns on: what each editor adds to the lazy chunk,
 * compressed, measured off a real Vite build rather than off Bundlephobia.
 */
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const variants = ['none', 'milkdown-commonmark', 'milkdown-gfm', 'tiptap-starter', 'tiptap-tables'];
const rows = [];

for (const variant of variants) {
  execFileSync('node', ['node_modules/vite/bin/vite.js', 'build'], {
    env: { ...process.env, VARIANT: variant },
    stdio: 'inherit',
  });
  const dir = join('dist', variant, 'assets');
  let entry = 0;
  let lazy = 0;
  let lazyBrotli = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const bytes = readFileSync(join(dir, file));
    const gzip = gzipSync(bytes, { level: 9 }).length;
    if (file.startsWith('index-')) entry += gzip;
    else {
      lazy += gzip;
      lazyBrotli += brotliCompressSync(bytes).length;
    }
  }
  rows.push({ variant, entry, lazy, lazyBrotli });
}

const baseline = rows.find((row) => row.variant === 'none');
console.log('\n| variant | entry (gzip) | lazy chunk (gzip) | lazy chunk (brotli) | editor costs |');
console.log('|---|---|---|---|---|');
for (const row of rows) {
  const cost = row.lazy - baseline.lazy;
  console.log(
    `| ${row.variant} | ${(row.entry / 1024).toFixed(1)}KB | ${(row.lazy / 1024).toFixed(1)}KB | ${(row.lazyBrotli / 1024).toFixed(1)}KB | ${row.variant === 'none' ? '—' : `${(cost / 1024).toFixed(1)}KB`} |`,
  );
}
