#!/usr/bin/env node
//
// The browser tier's time budget, run after a shard's walks (the `E2E (F3)` job
// in .github/workflows/ci.yml): reads the duration Playwright reported for this
// shard, from the JSON report scripts/ci-e2e.mjs writes beside the selection
// record, and fails when it is past the number in tools/test-explorer/concepts.json.
//
// `E2E_SHARD` (2/4) names the shard in the message; `E2E_RECORD_DIR` moves the
// report, as it does for scripts/ci-e2e.mjs. The arithmetic is in
// scripts/lib/e2e-budget.mjs and tested there with no browser.
//

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { THE_REGISTRY } from './lib/e2e-ceilings.mjs';
import { budgetIn, checkShardBudget } from './lib/e2e-budget.mjs';
import { parseShard } from './lib/e2e-record.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportFile = join(process.env.E2E_RECORD_DIR ?? join(root, 'e2e-record'), 'playwright.json');

try {
  const { seconds } = budgetIn(JSON.parse(readFileSync(join(root, THE_REGISTRY), 'utf8')));
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch {
    // No report: the walks step ran no Playwright (a selection that owns no walk), and the check says so.
  }
  const { ok, message } = checkShardBudget({ report, budgetSeconds: seconds, shard: parseShard(process.env.E2E_SHARD) });
  if (ok) {
    console.log(message);
  } else {
    console.error(message);
    if (process.env.GITHUB_ACTIONS) console.log(`::error::${message}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Could not check the shard's budget: ${error.message}`);
  process.exitCode = 1;
}
