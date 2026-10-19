//
// The shard budget as something that fails. The reports here are shaped as
// Playwright's JSON reporter writes them: `stats.duration` in milliseconds, and
// the walks that ran as `expected` (passed), `unexpected` (failed) and `flaky`.
//

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOAD_MARGIN, budgetIn, checkShardBudget } from './e2e-budget.mjs';
import { buildE2eRecord } from './e2e-record.mjs';

const BUDGET = 720;
const SHARD = { index: 2, total: 4 };

/** A report of a run that took `seconds` and ran `expected` walks. */
const report = (seconds, expected = 70) => ({ stats: { duration: seconds * 1000, expected, unexpected: 0, flaky: 0, skipped: 4 } });

describe('a shard\'s walks finish within the tier\'s budget', () => {
  it('passes within the budget, printing the margin', () => {
    const { ok, message } = checkShardBudget({ report: report(362), budgetSeconds: BUDGET, shard: SHARD });

    assert.equal(ok, true);
    assert.match(message, /Shard 2 of 4/);
    assert.match(message, /6\.0 min \(362 s\)/);
    assert.match(message, /6\.0 min \(358 s\) within the tier's budget of 12\.0 min \(720 s\)/);
  });

  it('passes at the budget exactly, since the budget is the most a shard may take', () => {
    assert.equal(checkShardBudget({ report: report(720), budgetSeconds: BUDGET, shard: SHARD }).ok, true);
  });

  it('fails over the budget, naming the number, the shard and the duration', () => {
    const { ok, message } = checkShardBudget({ report: report(840), budgetSeconds: BUDGET, shard: SHARD });

    assert.equal(ok, false);
    assert.match(message, /Shard 2 of 4/);
    assert.match(message, /14\.0 min \(840 s\)/);
    assert.match(message, /12\.0 min \(720 s\) per shard/);
    assert.match(message, /tools\/test-explorer\/concepts\.json/, 'a failure names where the number is raised');
  });

  it('says "this run" where no shard was named, a whole tier run in one process', () => {
    assert.match(checkShardBudget({ report: report(840), budgetSeconds: BUDGET, shard: null }).message, /^This run ran its 70 walks/);
  });

  it('counts the walks that failed or were flaky among those that ran, not only the passed ones', () => {
    const slow = { stats: { duration: 840_000, expected: 60, unexpected: 2, flaky: 1, skipped: 0 } };
    assert.match(checkShardBudget({ report: slow, budgetSeconds: BUDGET, shard: SHARD }).message, /its 63 walks/);
  });

  describe('no walk ran in the shard', () => {
    const idle = [
      { situation: 'a shard dealt no walk, which still booted the stack', report: { stats: { duration: 14_000, expected: 0, unexpected: 0, flaky: 0, skipped: 0 } } },
      { situation: 'a shard whose every walk skipped itself', report: { stats: { duration: 900_000, expected: 0, unexpected: 0, flaky: 0, skipped: 20 } } },
      { situation: 'a run that left no report, a selection that owns no walk', report: null },
    ];
    for (const { situation, report: left } of idle) {
      it(`passes for ${situation}`, () => {
        const { ok, message } = checkShardBudget({ report: left, budgetSeconds: BUDGET, shard: SHARD });
        assert.equal(ok, true);
        assert.match(message, /ran no walk/);
      });
    }
  });

  it('fails a run that ran walks and reported no duration, since the budget cannot be read', () => {
    const { ok, message } = checkShardBudget({ report: { stats: { expected: 5, unexpected: 0, flaky: 0 } }, budgetSeconds: BUDGET, shard: SHARD });
    assert.equal(ok, false);
    assert.match(message, /no duration/);
  });

  it('fails where Playwright started and left no report, or a report without stats, rather than passing unchecked', () => {
    const gone = checkShardBudget({ report: null, budgetSeconds: BUDGET, shard: SHARD, reportExpected: true });
    const bare = checkShardBudget({ report: {}, budgetSeconds: BUDGET, shard: SHARD });

    assert.equal(gone.ok, false);
    assert.match(gone.message, /report is missing/);
    assert.equal(bare.ok, false);
    assert.match(bare.message, /holds no stats/);
  });
});

describe('the script that reads the shard\'s report', () => {
  const script = fileURLToPath(new URL('../e2e-budget.mjs', import.meta.url));

  /** Runs the script against a record directory holding `files` (name to text). */
  function run(files) {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-budget-'));
    try {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
      const { status, stdout, stderr } = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, E2E_RECORD_DIR: dir, E2E_SHARD: '2/4', GITHUB_ACTIONS: '' } });
      return { status, output: stdout + stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // The shard's real record (buildE2eRecord), not a hand-written one: the script reads the shape that builder writes.
  const everyWalk = { mode: 'full', reason: 'every walk', forced: { rule: 'every walk', path: null } };
  const noWalkSelected = { mode: 'selected', areas: [], unplaced: [], grep: '' };
  const record = (plan, written) => JSON.stringify(buildE2eRecord({ event: 'pull_request', baseCommit: null, changedFiles: [], plan, walks: [], report: written, shard: SHARD }));

  it('passes a run inside the budget and fails one past it, by exit code', () => {
    const inside = report(362);
    const over = report(840);
    assert.equal(run({ 'playwright.json': JSON.stringify(inside), 'record.json': record(everyWalk, inside) }).status, 0);
    const failed = run({ 'playwright.json': JSON.stringify(over), 'record.json': record(everyWalk, over) });
    assert.equal(failed.status, 1);
    assert.match(failed.output, /Shard 2 of 4/);
  });

  it('passes with no report where the selection started no Playwright, and fails where it started one', () => {
    assert.equal(run({ 'record.json': record(noWalkSelected, null) }).status, 0);
    assert.equal(run({}).status, 0);
    assert.equal(run({ 'record.json': record(everyWalk, null) }).status, 1);
  });

  it('fails on a report that is there and cannot be read', () => {
    const { status, output } = run({ 'playwright.json': '{"stats": {"duration": 12', 'record.json': record(everyWalk, report(362)) });
    assert.equal(status, 1);
    assert.match(output, /Could not check/);
  });
});

describe('a shard whose walks failed shows one red, not two', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)), 'utf8');
  /** The `e2e` job's steps, each as its own text, keyed by name. */
  const steps = new Map(
    workflow
      .split(/^ {2}e2e:\n/m)[1]
      .split(/^ {2}e2e-result:\n/m)[0]
      .split(/^ {6}- /m)
      .slice(1)
      .map((step) => [/name: (.*)/.exec(step)?.[1], step]),
  );

  it('runs the budget step right after the walks step, and only when that step succeeded on a diff that touches the product', () => {
    const order = [...steps.keys()];
    const budget = steps.get('Hold this shard\'s walks to the time budget');

    assert.ok(budget, 'the e2e job has no budget step');
    assert.equal(order.indexOf('Hold this shard\'s walks to the time budget'), order.indexOf('Run this shard\'s walks') + 1);
    assert.match(budget, /^ {8}if: \$\{\{ success\(\) && steps\.classify\.outputs\.product_changed != 'false' \}\}$/m);
    assert.match(budget, /run: pnpm test:e2e:budget$/m);
    assert.match(budget, /E2E_SHARD: \$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}/, 'the step names its shard as the walks step does');
  });
});

describe('the tier\'s budget number carries its reason', () => {
  const registry = JSON.parse(readFileSync(fileURLToPath(new URL('../../tools/test-explorer/concepts.json', import.meta.url)), 'utf8'));

  it('is held beside the ceilings, with the typical it was set above and the reason in words', () => {
    const { seconds, typicalSeconds, reason } = budgetIn(registry);

    assert.ok(reason.length > 0);
    assert.match(reason, new RegExp(`${seconds} s`), 'the reason states the number it explains');
    assert.match(reason, new RegExp(`${typicalSeconds} s`), 'the reason states the typical it was set from');
  });

  it('sits above the slowest shard\'s typical by at least what runner load swings a run, and under a doubling of it', () => {
    const { seconds, typicalSeconds } = budgetIn(registry);

    assert.ok(seconds >= typicalSeconds * LOAD_MARGIN, `${seconds} s is under ${LOAD_MARGIN} times the typical ${typicalSeconds} s, so load alone turns a run red`);
    assert.ok(seconds < typicalSeconds * 2, `${seconds} s is two times the typical ${typicalSeconds} s or more, so a doubling would pass`);
  });

  it('refuses a registry without a usable budget rather than checking against nothing', () => {
    for (const held of [undefined, {}, { seconds: 0, typicalSeconds: 420, reason: 'x' }, { seconds: 720, typicalSeconds: 420, reason: ' ' }, { seconds: '720', typicalSeconds: 420, reason: 'x' }]) {
      assert.throws(() => budgetIn({ e2eShardBudget: held }), /e2eShardBudget/);
    }
  });
});
