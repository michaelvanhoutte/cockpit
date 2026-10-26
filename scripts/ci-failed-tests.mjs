#!/usr/bin/env node
//
// The step after `pnpm test` (or a contract suite) in the workflows that do not
// run scripts/ci-test.mjs - Deploy staging, Promote to production and Contract:
// gathers the files the Vitest reporter left in COCKPIT_FAILED_TESTS_DIR
// (scripts/lib/vitest-session-reporter.mjs) into the one record the job uploads
// as `failed-tests-record`. A job whose tests all passed left no file, so this
// writes no record and there is nothing to upload.
//
// Usage: node scripts/ci-failed-tests.mjs
// with COCKPIT_FAILED_TESTS_DIR (default `failed-tests`) and optionally
// FAILED_TESTS_RECORD_DIR (default `failed-tests-record`). Never fails the job:
// what the tests made it is what it stays.
//

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { mergeFailedTests } from './lib/failed-tests.mjs';

const inDir = process.env.COCKPIT_FAILED_TESTS_DIR ?? 'failed-tests';
const outDir = process.env.FAILED_TESTS_RECORD_DIR ?? 'failed-tests-record';

try {
  const parts = existsSync(inDir) ? readdirSync(inDir).sort().filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(inDir, name), 'utf8'))) : [];
  const record = mergeFailedTests(parts);
  if (record.failedTests.length === 0) {
    console.log('No test failed, so there is no failed-tests record to upload.');
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Recorded ${record.failedTests.length} failed test${record.failedTests.length === 1 ? '' : 's'}${record.failedTestsMore > 0 ? ` and ${record.failedTestsMore} more` : ''}.`);
  }
} catch (error) {
  console.log(`::warning::The failed-tests record could not be written: ${error.message}`);
}
