//
// The time one E2E (F3) shard's walks may take, held as one number for the tier
// ("Hold each E2E shard's walks under a tier-wide time budget", issue 1280).
//
// The per-area ceilings (scripts/lib/e2e-ceilings.mjs) cap how many walks the
// tier holds; this caps what a shard's share of them costs, so the tier growing
// is a red check rather than a slow run nobody notices. The number lives beside
// the ceilings, in tools/test-explorer/concepts.json under `e2eShardBudget`,
// with the measurements it was set from.
//
// **Read off Playwright's own report, never the job's wall clock**: the report's
// `stats.duration` is the run as Playwright measured it, stack boot included and
// the Chromium install excluded, where a job's clock carries install and runner
// start-up noise that is not the walks'.
//
// Pure, so tested by `node --test` with no browser; scripts/e2e-budget.mjs is
// the reading and the exit code around it.
//

import { THE_REGISTRY } from './e2e-ceilings.mjs';

/** What runner load swings a shard's duration by; the budget sits above the slowest typical by at least this. */
export const LOAD_MARGIN = 1.3;

/**
 * The budget as the registry holds it, checked for shape: the number, the
 * slowest shard's typical it was set from, and the reason in words.
 *
 * @param {unknown} registry `tools/test-explorer/concepts.json`, parsed
 * @returns {{ seconds: number, typicalSeconds: number, reason: string }}
 */
export function budgetIn(registry) {
  const held = registry?.e2eShardBudget;
  const { seconds, typicalSeconds, reason } = held ?? {};
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(typicalSeconds) || typicalSeconds <= 0 || typeof reason !== 'string' || reason.trim() === '') {
    throw new Error(`${THE_REGISTRY} has no usable "e2eShardBudget": it needs "seconds", "typicalSeconds" (the slowest shard's typical, which "seconds" was set above) and a "reason".`);
  }
  return { seconds, typicalSeconds, reason };
}

/** `362` as `6.0 min (362 s)`. */
function asDuration(seconds) {
  return `${(seconds / 60).toFixed(1)} min (${Math.round(seconds)} s)`;
}

/**
 * Whether one shard's walks finished within the budget.
 *
 * A shard that ran no walk passes: Playwright reports a duration for the stack
 * it booted, which is no measure of a tier that was dealt nothing, and a
 * selected run can hand a shard none. Likewise no report, where the walks step
 * started no Playwright (`reportExpected` false, the default). Where it did
 * start one (`reportExpected`, which the selection record says) a missing
 * report, or one without `stats`, fails: the budget cannot be read, and passing
 * would let a shard grow unchecked. A walks step that failed never reaches this
 * check (the workflow gates it on that step's success), so one failure is one
 * red.
 *
 * @param {{ report: { stats?: { duration?: number, expected?: number, unexpected?: number, flaky?: number } } | null, budgetSeconds: number, shard: { index: number, total: number } | null, reportExpected?: boolean }} input
 * @returns {{ ok: boolean, message: string }}
 */
export function checkShardBudget({ report, budgetSeconds, shard, reportExpected = false }) {
  const who = shard ? `Shard ${shard.index} of ${shard.total}` : 'This run';
  const stats = report?.stats;
  if ((!report && reportExpected) || (report && !stats)) {
    return { ok: false, message: `${who} started its walks and Playwright's report ${report ? 'holds no stats' : 'is missing'}, so the budget of ${asDuration(budgetSeconds)} cannot be checked.` };
  }
  const ran = stats ? (stats.expected ?? 0) + (stats.unexpected ?? 0) + (stats.flaky ?? 0) : 0;
  if (ran === 0) return { ok: true, message: `${who} ran no walk, so it has no duration to hold to the budget of ${asDuration(budgetSeconds)}.` };

  if (!Number.isFinite(stats.duration)) {
    return { ok: false, message: `${who} ran ${ran} walks and Playwright's report holds no duration for them, so the budget of ${asDuration(budgetSeconds)} cannot be checked.` };
  }

  const seconds = stats.duration / 1000;
  if (seconds > budgetSeconds) {
    return {
      ok: false,
      message: `${who} ran its ${ran} walks for ${asDuration(seconds)}, ${asDuration(seconds - budgetSeconds)} past the tier's budget of ${asDuration(budgetSeconds)} per shard. Cut walks whose behaviour a lower tier already proves, or raise "e2eShardBudget" in ${THE_REGISTRY} in this same pull request, saying in its reason what the tier measured.`,
    };
  }
  return { ok: true, message: `${who} ran its ${ran} walks for ${asDuration(seconds)}, ${asDuration(budgetSeconds - seconds)} within the tier's budget of ${asDuration(budgetSeconds)} per shard.` };
}
