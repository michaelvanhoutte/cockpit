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

/** The lines the command prints at the end of a run. */
export function summarizeUpload({ stored, alreadyStored, refused, failed, unreadable, unreadableFiles = 0 }) {
  const lines = [`Sent ${stored + alreadyStored} requests: ${stored} new, ${alreadyStored} already stored.`];
  if (refused) lines.push(`The monitor refused ${refused} requests as invalid; they were not stored.`);
  if (failed) lines.push(`Stopped early: ${failed}. Re-run to finish; requests already stored are ignored.`);
  lines.push(`Could not read ${unreadable} log lines${unreadableFiles ? ` and ${unreadableFiles} whole log files` : ''}.`);
  return lines;
}
