//
// The shard budget as something that fails. The reports here are shaped as
// Playwright's JSON reporter writes them: `stats.duration` in milliseconds, and
// the walks that ran as `expected` (passed), `unexpected` (failed) and `flaky`.
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOAD_MARGIN, budgetIn, checkShardBudget } from './e2e-budget.mjs';

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
