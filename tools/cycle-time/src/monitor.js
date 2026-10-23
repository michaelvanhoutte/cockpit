/**
 * The Harness Monitor, and nothing else: where the next send starts reading,
 * and the send itself. The rows are model.js's (`monitorRows`); this file only
 * asks and posts. `fetchImpl` is a parameter, as in github.js, so the tests can
 * stand in for the Monitor.
 *
 * A send is a series of requests, each one batch the Monitor stores whole or
 * refuses whole. A send cut short leaves the batches before it stored, and the
 * next run's overlap sends the rest again: pull requests are replaced by their
 * number, so nothing is ever doubled.
 */

const DAY_MS = 86_400_000;

/** How far before the newest stored merge the next send starts: a fluke found since lands within it. */
export const OVERLAP_DAYS = 2;
/** The Monitor's own caps on one send: 50 pull requests, and a body under 1,000,000 characters, kept clear of. */
export const BATCH_PULLS = 50;
export const BATCH_CHARS = 900_000;

export class MonitorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MonitorError';
  }
}

/**
 * Which pull requests to read for a send: the window given by hand (the
 * backfill) whatever is stored; else from the newest stored merge less the
 * overlap; else, with nothing stored, the tool's own default window.
 *
 * @param {{ newest: Date|null, now: Date, days: number, from?: Date|null, to?: Date|null }} input
 * @returns {{ since: Date, until: Date|null }}
 */
export function sendWindow({ newest, now, days, from = null, to = null }) {
  if (from) return { since: from, until: to };
  if (newest) return { since: new Date(newest.getTime() - OVERLAP_DAYS * DAY_MS), until: null };
  return { since: new Date(now.getTime() - days * DAY_MS), until: null };
}

const address = (url, path) => `${url.replace(/\/+$/, '')}${path}`;

/**
 * The newest merge the Monitor holds, or null when it holds none. Any answer that
 * is not one is a MonitorError, which costs the send and never the page: a
 * login page answering 200, or a time that does not parse, would otherwise
 * crash the run or compare false against every pull request and send none.
 */
export async function newestStored({ url, fetchImpl = globalThis.fetch }) {
  let res;
  try {
    res = await fetchImpl(address(url, '/v1/cycle-time'), { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new MonitorError(`Could not reach the Harness Monitor at ${url}: ${error.message}`);
  }
  if (!res.ok) throw new MonitorError(`The Harness Monitor answered ${res.status} when asked its newest merge.`);
  let newestMerge;
  try {
    ({ newestMerge } = await res.json());
  } catch {
    throw new MonitorError(`The Harness Monitor at ${url} did not answer JSON when asked its newest merge.`);
  }
  if (newestMerge === null || newestMerge === undefined) return null;
  const newest = new Date(newestMerge);
  if (Number.isNaN(newest.getTime())) {
    throw new MonitorError(`The Harness Monitor answered ${JSON.stringify(newestMerge)} as its newest merge, which is not a time.`);
  }
  return newest;
}

/**
 * The pull requests cut into batches of at most `maxPulls` pull requests and
 * `maxChars` characters of body. A pull request too large for a batch on its
 * own is refused here, since the Monitor would refuse it anyway.
 */
export function cutBatches(pulls, { maxPulls = BATCH_PULLS, maxChars = BATCH_CHARS } = {}) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const pull of pulls) {
    const size = JSON.stringify(pull).length + 1;
    if (size + 20 > maxChars) throw new MonitorError(`Pull request ${pull.number} is ${size} characters, more than one send takes (${maxChars}).`);
    if (current.length === maxPulls || chars + size + 20 > maxChars) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(pull);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Sends every pull request, one batch after another, and stops at the first
 * the Monitor does not store, saying how many went before it.
 *
 * @returns {Promise<{ batches: number, pulls: number }>}
 */
export async function sendPulls({ url, key, pulls, fetchImpl = globalThis.fetch, maxPulls, maxChars }) {
  const batches = cutBatches(pulls, { maxPulls, maxChars });
  let sent = 0;
  for (const [index, batch] of batches.entries()) {
    const stored = `${index} batch${index === 1 ? '' : 'es'} of ${batches.length} ${index === 1 ? 'was' : 'were'} stored (${sent} pull requests); the next send's overlap sends the rest again.`;
    let res;
    try {
      res = await fetchImpl(address(url, '/v1/cycle-time'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ pulls: batch }),
      });
    } catch (error) {
      throw new MonitorError(`Could not reach the Harness Monitor with batch ${index + 1} of ${batches.length}: ${error.message}. ${stored}`);
    }
    if (!res.ok) {
      const reason = await res
        .json()
        .then((body) => body?.error)
        .catch(() => null);
      throw new MonitorError(`The Harness Monitor refused batch ${index + 1} of ${batches.length} (${res.status}${reason ? `: ${reason}` : ''}). ${stored}`);
    }
    sent += batch.length;
  }
  return { batches: batches.length, pulls: sent };
}
