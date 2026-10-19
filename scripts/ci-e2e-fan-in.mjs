#!/usr/bin/env node
//
// The fan-in job's own step (.github/workflows/ci.yml, the job named `E2E (F3)`
// that `needs` the four shards): merges the shards' records into the one record
// the selection report and the cycle-time report read, writes it and its step
// summary, and answers for the shards, so the required check passes only where
// they did. Everything that decides anything is in scripts/lib/e2e-record.mjs;
// this reads the records and the shard results and sets the exit code.
//
// Usage, on a runner after `actions/download-artifact` has fetched
// `e2e-selection-record-*` into E2E_SHARD_RECORDS (default `e2e-shard-records`):
//   node scripts/ci-e2e-fan-in.mjs
// with GITHUB_TOKEN, GITHUB_REPOSITORY and GITHUB_RUN_ID to read the shards' own
// results, and E2E_SHARDS_RESULT (`needs.e2e.result`), the matrix's own verdict,
// which is what answers where those cannot be read.
//
// The merged record goes to e2e-record/record.json, uploaded under the name it
// has always had. Writing it can only add: a record that cannot be written is a
// warning, and the exit code is the shards' verdict alone.
//

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { E2E_SHARDS, e2eVerdict, mergeE2eRecords, renderE2eSummary, shardResults } from './lib/e2e-record.mjs';

const recordsDir = process.env.E2E_SHARD_RECORDS ?? 'e2e-shard-records';
const outDir = process.env.E2E_RECORD_DIR ?? 'e2e-record';

/** Each shard's own record under `recordsDir/<artefact name>/record.json`; one that cannot be read is left out, which the merge reports as that shard's. */
function readRecords() {
  if (!existsSync(recordsDir)) return [];
  return readdirSync(recordsDir).flatMap((name) => {
    try {
      return [JSON.parse(readFileSync(join(recordsDir, name, 'record.json'), 'utf8'))];
    } catch (error) {
      console.log(`::warning::${name} could not be read (${error.message}).`);
      return [];
    }
  });
}

/** The shards' own results off the run's jobs, or `null` where the API could not be read, which the matrix's verdict then answers for. */
async function readResults() {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run, GITHUB_API_URL: api = 'https://api.github.com' } = process.env;
  if (!token || !repo || !run) return null;
  try {
    const response = await fetch(`${api}/repos/${repo}/actions/runs/${run}/jobs?filter=latest&per_page=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return shardResults((await response.json()).jobs ?? []);
  } catch (error) {
    console.log(`::warning::The shards' own results could not be read (${error.message}); the matrix's verdict stands for them.`);
    return null;
  }
}

function writeMerged() {
  try {
    const merged = mergeE2eRecords(readRecords(), E2E_SHARDS);
    if (!merged) {
      console.log('No shard left a record: a documentation-only diff runs none, so there is nothing to merge.');
      return;
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'record.json'), `${JSON.stringify(merged, null, 2)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${renderE2eSummary(merged)}\n`);
  } catch (error) {
    console.log(`::warning::The merged E2E selection record is missing from this run: ${error.message}`);
  }
}

const verdict = e2eVerdict({ results: await readResults(), aggregate: process.env.E2E_SHARDS_RESULT || null });
writeMerged();

console.log(verdict.ok ? verdict.message : `::error::${verdict.message}`);
if (process.env.GITHUB_STEP_SUMMARY && !verdict.ok) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `**${verdict.message}**\n`);
// process.exitCode rather than process.exit(): stdout is a pipe on CI, where a write is asynchronous.
process.exitCode = verdict.ok ? 0 : 1;
