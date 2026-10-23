//
// The one-off upload of this repository's past Claude Code logs to the Harness
// Monitor (Upload past Claude Code session logs to the Harness Monitor, issue
// 975). Pure: the logs in, rows and counts out. Discovery and
// HTTP are in `scripts/harness-upload.mjs`.
//
// **An upload's rows are the hook's rows**, built by the same `toRow`, marked
// `source: 'upload'` so the monitor prices them at upload. The monitor keeps
// the first row it stores for a request id, so re-running an upload, or
// uploading a session the hook already sent, counts nothing twice.
//

import { allRequests, MAX_BATCH, toRow } from './usage-report.mjs';

/** Every request in the logs as the monitor's rows, the hook's rows marked as an upload. */
export function uploadRows(logs, { ranWhere, marksOf }) {
  return allRequests(logs).map((request) => toRow(request, { ranWhere, marksOf, source: 'upload' }));
}

/**
 * Sends the rows in batches the monitor takes and adds up what it said.
 * `post(batch)` resolves `{ stored, ignored }` for a batch the monitor
 * accepted, `'rejected'` for one it refused as invalid (counted, and the run
 * goes on), and throws for anything worth stopping on (the run stops there and
 * says so; a re-run finishes it, since stored requests are ignored).
 */
export async function postBatches(rows, post) {
  const totals = { stored: 0, alreadyStored: 0, refused: 0, failed: null };
  for (let i = 0; i < rows.length; i += MAX_BATCH) {
    const batch = rows.slice(i, i + MAX_BATCH);
    let outcome;
    try {
      outcome = await post(batch);
    } catch (error) {
      totals.failed = error instanceof Error ? error.message : String(error);
      break;
    }
    if (outcome === 'rejected') {
      totals.refused += batch.length;
    } else {
      totals.stored += outcome.stored;
      totals.alreadyStored += outcome.ignored;
    }
  }
  return totals;
}

/**
 * The re-place step (Re-place stored Unphased requests since 21 Sep from the
 * local session logs, issue 1487): the monitor places a stored Unphased request
 * again from the same rows the upload builds, by the hook's own rule.
 *
 * The monitor's side of its failure modes (halfway, twice, interruption) is
 * answered at its route, `correct` in apps/harness-monitor/src/worker.ts. This side:
 * - **Rows that break the rule**: only the four phases below are sent, from the
 *   moment phase marks began; what the monitor leaves is counted, a refused or
 *   failed batch stops the run, is named and is not counted, and a request with
 *   no log here stays Unphased and is counted in the report.
 * - **Each environment**: run it against the local monitor first; dump the
 *   deployed database (`wrangler d1 export`) before it is touched, and run
 *   `pnpm harness:run rebuild` once done.
 */

/** The instant phase marks began (`PHASES_BEGIN` in the monitor's validator): nothing earlier is re-placed. */
export const PHASES_BEGIN_MS = Date.parse('2026-09-21T00:00:00Z');

/** The phases the monitor places a stored Unphased request into (`CORRECTABLE` in its validator). */
export const CORRECTABLE = ['scoping-planning', 'after-push', 'process-review', 'outside-process'];

/** What to send for the rows: request id and category, for each one from 21 Sep on that the rule places in one of the four. */
export function corrections(rows) {
  return rows
    .filter((row) => Date.parse(row.time) >= PHASES_BEGIN_MS && CORRECTABLE.includes(row.category))
    .map((row) => ({ requestId: row.requestId, category: row.category }));
}

/**
 * Sends the corrections in batches the monitor takes and adds up its answers.
 * `post(batch)` resolves `{ changed, left }` for a batch applied, `{ refused }`
 * (the monitor's reason) for one refused, and throws for a failure. Either
 * stops the run there, naming the batch; it is not counted as sent.
 */
export async function postCorrections(list, post) {
  const totals = { sent: 0, changed: 0, left: 0, batches: Math.ceil(list.length / MAX_BATCH), stopped: null };
  for (let i = 0; i < list.length; i += MAX_BATCH) {
    const batch = list.slice(i, i + MAX_BATCH);
    const at ={ batch: i / MAX_BATCH + 1, first: i + 1, last: i + batch.length };
    let outcome;
    try {
      outcome = await post(batch);
    } catch (error) {
      totals.stopped = { ...at, refused: false, reason: error instanceof Error ? error.message : String(error) };
      break;
    }
    if (outcome.refused !== undefined) {
      totals.stopped = { ...at, refused: true, reason: outcome.refused };
      break;
    }
    totals.sent += batch.length;
    totals.changed += outcome.changed;
    totals.left += outcome.left;
  }
  return totals;
}

/**
 * The lines the re-place step prints at the end of a run. `unphased` is the
 * monitor's count once every batch went, else null; `unphasedUnread` is why it
 * could not be read, when it was asked for and not answered.
 */
export function summarizeRePlace({ sent, changed, left, batches, stopped, unphased, unphasedUnread = null, unreadable, unreadableFiles = 0 }) {
  const lines = [`Sent ${sent} corrections: ${changed} placed again, ${left} left as they were (already in a phase, dated before 21 Sep, from a cloud session, or not stored).`];
  if (stopped) {
    const what = `batch ${stopped.batch} of ${batches} (corrections ${stopped.first}-${stopped.last})`;
    lines.push(
      stopped.refused
        ? `Stopped: the monitor refused ${what}: ${stopped.reason}. Nothing from it was applied, and nothing after it was sent.`
        : `Stopped at ${what}: ${stopped.reason}. Re-run to finish; rows already placed are left.`,
    );
  }
  if (unphased !== null && unphased !== undefined) {
    lines.push(`${unphased} local requests from 21 Sep on are still Unphased: no log on this machine places them in one of the four phases.`);
  } else if (unphasedUnread) {
    lines.push(`Could not read how many local requests from 21 Sep on are still Unphased: ${unphasedUnread}.`);
  }
  lines.push(`Could not read ${unreadable} log lines${unreadableFiles ? ` and ${unreadableFiles} whole log files` : ''}.`);
  lines.push('Run `pnpm harness:run rebuild` once done, so the costs page shows the new split.');
  return lines;
}

/** The lines the command prints at the end of a run. */
export function summarizeUpload({ stored, alreadyStored, refused, failed, unreadable, unreadableFiles = 0 }) {
  const lines = [`Sent ${stored + alreadyStored} requests: ${stored} new, ${alreadyStored} already stored.`];
  if (refused) lines.push(`The monitor refused ${refused} requests as invalid; they were not stored.`);
  if (failed) lines.push(`Stopped early: ${failed}. Re-run to finish; requests already stored are ignored.`);
  lines.push(`Could not read ${unreadable} log lines${unreadableFiles ? ` and ${unreadableFiles} whole log files` : ''}.`);
  return lines;
}
