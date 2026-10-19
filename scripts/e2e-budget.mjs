#!/usr/bin/env node
//
// The browser tier's time budget, run after a shard's walks (the `E2E (F3)` job
// in .github/workflows/ci.yml): reads the duration Playwright reported for this
// shard, from the JSON report scripts/ci-e2e.mjs writes beside the selection
// record, and fails when it is past the number in tools/test-explorer/concepts.json.
// A report that is missing where that record says Playwright started, or that is
// there and unreadable, fails too: only a selection that started no Playwright
// passes without one.
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
const recordDir = process.env.E2E_RECORD_DIR ?? join(root, 'e2e-record');

/** The JSON in `file`, `null` where there is no such file; a file that is there and unreadable throws, so a truncated report is a failure and not a pass. */
function readJsonIfPresent(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

try {
  const { seconds } = budgetIn(JSON.parse(readFileSync(join(root, THE_REGISTRY), 'utf8')));
  const report = readJsonIfPresent(join(recordDir, 'playwright.json'));
  // The selection record says whether the walks step started Playwright, so a report that is missing then is told apart from a selection that owns no walk.
  let record = null;
  try {
    record = readJsonIfPresent(join(recordDir, 'record.json'));
  } catch {
    // An unreadable record leaves the report as the only evidence.
  }
  const reportExpected = record?.packages?.[0]?.report === 'none';
  const { ok, message } = checkShardBudget({ report, budgetSeconds: seconds, shard: parseShard(process.env.E2E_SHARD), reportExpected });
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
