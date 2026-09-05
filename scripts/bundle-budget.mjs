#!/usr/bin/env node
//
// The bundle gate, run after `pnpm build` (the Build job in
// .github/workflows/ci.yml). Reads what the web build actually emitted,
// compresses each JavaScript file, and holds the two lines in
// docs/architecture.md's "Performance budgets" table.
//
// The arithmetic is in scripts/lib/bundle-budget.mjs and tested there without a
// build; everything here is reading files and printing.
//

import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUDGET_BYTES, asALine, referencedByTheDocument, whatTheBundleCosts } from './lib/bundle-budget.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'dist');

let html;
try {
  html = readFileSync(join(dist, 'index.html'), 'utf8');
} catch {
  console.error(`No build to measure at ${dist}. Run \`pnpm build\` first.`);
  process.exit(1);
}

const assetsDir = join(dist, 'assets');
let built;
try {
  built = readdirSync(assetsDir);
} catch {
  console.error(`No ${assetsDir}. That is a build that failed quietly, not a small one.`);
  process.exit(1);
}

const assets = built
  .filter((file) => file.endsWith('.js'))
  // Level 9 rather than the default, because it is what a CDN serves and the
  // budget is about what the browser downloads.
  .map((file) => ({ file, bytes: gzipSync(readFileSync(join(assetsDir, file)), { level: 9 }).length }));

if (assets.length === 0) {
  console.error(`No JavaScript in ${assetsDir}. That is a build that failed quietly, not a small one.`);
  process.exit(1);
}

const report = whatTheBundleCosts(assets, referencedByTheDocument(html), BUDGET_BYTES);
const cap = `${(report.budget / 1024).toFixed(0)}KB`;

console.log(`Initial bundle, compressed: ${(report.initialBytes / 1024).toFixed(1)}KB of ${cap}`);
for (const chunk of report.initial.sort((a, b) => b.bytes - a.bytes)) console.log(`  ${asALine(chunk)}`);
if (report.lazy.length > 0) {
  console.log(`\nFetched later, each charged on its own against ${cap}:`);
  for (const chunk of report.lazy.sort((a, b) => b.bytes - a.bytes)) console.log(`  ${asALine(chunk)}`);
}

if (report.over.length === 0) process.exit(0);

console.error('\nOver budget:');
for (const { what, bytes, budget } of report.over) {
  console.error(`  ${what}: ${(bytes / 1024).toFixed(1)}KB, over ${(budget / 1024).toFixed(0)}KB`);
}
process.exit(1);
