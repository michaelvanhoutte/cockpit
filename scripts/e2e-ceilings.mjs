#!/usr/bin/env node
//
// The browser tier's budget, run before the tier itself (the `E2E (F3)` job in
// .github/workflows/ci.yml). Asks Playwright what it would run, counts the
// walks per product area, and holds each area to the ceiling beside it in
// tools/test-explorer/concepts.json.
//
// Before the suite rather than after, and before the browser is even
// downloaded: a breach is a decision to take, not a failure to diagnose, and
// finding out in half a minute beats finding out in thirteen.
//
// The arithmetic is in scripts/lib/e2e-ceilings.mjs and tested there with no
// browser; everything here is running the listing and printing.
//

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { THE_REGISTRY, asReport, reviewTheTier } from './lib/e2e-ceilings.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The areas that carry a ceiling, read off the one registry the areas already live in. */
function ceilings() {
  const { concepts } = JSON.parse(readFileSync(join(root, THE_REGISTRY), 'utf8'));
  return Object.fromEntries(
    concepts.filter((area) => typeof area.browserWalks === 'number').map((area) => [area.key, area.browserWalks]),
  );
}

let listing;
try {
  // `--list` starts no stack and needs no browser: it loads the specs and
  // reports what it would run. stderr is inherited so a spec that fails to
  // load says so here rather than arriving as unparseable output.
  const printed = execFileSync('pnpm', ['exec', 'playwright', 'test', '--list', '--reporter=json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });
  listing = JSON.parse(printed);
} catch (failure) {
  console.error(`Could not list the browser tier: ${failure.message}`);
  process.exit(1);
}

const review = reviewTheTier(listing, ceilings());
const { lines, problems } = asReport(review);
for (const line of lines) console.log(line);

if (problems.length === 0) process.exit(0);

console.error('');
for (const problem of problems) console.error(problem);
process.exit(1);
