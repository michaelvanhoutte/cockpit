/**
 * The Harness Monitor, and nothing else: where the next send starts reading,
 * and the send itself. The rows are model.js's (`monitorRows`, `attemptRows`); this
 * file only asks and posts. `fetchImpl` is a parameter, as in github.js, so the tests
 * can stand in for the Monitor.
 *
 * A send is a series of requests, each one batch the Monitor stores whole or
 * refuses whole. A send cut short leaves the batches before it stored, and the
 * next run's overlap sends the rest again: runs and attempts are replaced by their
 * id, so nothing is ever doubled.
 */

const DAY_MS = 86_400_000;

/** How far before the newest stored run the next send starts: a re-run's later verdict lands within it. */
export const OVERLAP_DAYS = 2;
/** The Monitor's own caps on one send: 50 runs (or attempts), and a body under 1,000,000 characters, kept clear of. */
export const BATCH_RUNS = 50;
export const BATCH_CHARS = 900_000;

export class MonitorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MonitorError';
  }
}

/**
 * Which runs to read for a send: the window given by hand (the backfill)
 * whatever is stored; else from the newest stored run less the overlap; else,
 * with nothing stored, the tool's own default window.
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
 * The newest thing the Monitor holds at `path`, under `field`, or null when it holds none. Any
 * answer that is not one is a MonitorError, which costs the send and never the page: a login
 * page answering 200, or a time that does not parse, would otherwise crash the run or compare
 * false against every run and send none.
 */
async function newestAt({ url, path, field, what, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(address(url, path), { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new MonitorError(`Could not reach the Harness Monitor at ${url}: ${error.message}`);
  }
  if (!res.ok) throw new MonitorError(`The Harness Monitor answered ${res.status} when asked its newest ${what}.`);
  let newest;
  try {
    newest = (await res.json())[field];
  } catch {
    throw new MonitorError(`The Harness Monitor at ${url} did not answer JSON when asked its newest ${what}.`);
  }
  if (newest === null || newest === undefined) return null;
  const time = new Date(newest);
  if (Number.isNaN(time.getTime())) {
    throw new MonitorError(`The Harness Monitor answered ${JSON.stringify(newest)} as its newest ${what}, which is not a time.`);
  }
  return time;
}

/** The newest run the Monitor holds, or null when it holds none. */
export function newestStored({ url, fetchImpl = globalThis.fetch }) {
  return newestAt({ url, path: '/v1/stability', field: 'newestRun', what: 'run', fetchImpl });
}

/** When the newest attempt of `main` (`on: 'main'`) or of every other branch (`'branches'`) started, or null when the Monitor holds none. */
export function newestStoredAttempt({ url, on = 'main', fetchImpl = globalThis.fetch }) {
  return newestAt({ url, path: `/v1/ci-attempts?on=${on}`, field: 'newestAttempt', what: 'attempt', fetchImpl });
}

/**
 * The items cut into batches of at most `maxRuns` of them and `maxChars` characters
 * of body. One too large for a batch on its own is refused here, since the Monitor
 * would refuse it anyway.
 */
export function cutBatches(items, { maxRuns = BATCH_RUNS, maxChars = BATCH_CHARS, label = (item) => `Run ${item.id}` } = {}) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const size = JSON.stringify(item).length + 1;
    if (size + 20 > maxChars) throw new MonitorError(`${label(item)} is ${size} characters, more than one send takes (${maxChars}).`);
    if (current.length === maxRuns || chars + size + 20 > maxChars) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Posts `items` to `path` as `{ [field]: batch }`, one batch after another, stopping at the first the Monitor does not store. */
async function postBatches({ url, key, path, field, noun, items, fetchImpl, maxRuns, maxChars, label }) {
  const batches = cutBatches(items, { maxRuns, maxChars, label });
  let sent = 0;
  for (const [index, batch] of batches.entries()) {
    const stored = `${index} batch${index === 1 ? '' : 'es'} of ${batches.length} ${index === 1 ? 'was' : 'were'} stored (${sent} ${noun}); the next send's overlap sends the rest again.`;
    let res;
    try {
      res = await fetchImpl(address(url, path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ [field]: batch }),
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
  return { batches: batches.length, sent };
}

/**
 * Sends every run, one batch after another, and stops at the first the Monitor
 * does not store, saying how many went before it.
 *
 * @returns {Promise<{ batches: number, runs: number }>}
 */
export async function sendRuns({ url, key, runs, fetchImpl = globalThis.fetch, maxRuns, maxChars }) {
  const { batches, sent } = await postBatches({ url, key, path: '/v1/stability', field: 'runs', noun: 'runs', items: runs, fetchImpl, maxRuns, maxChars });
  return { batches, runs: sent };
}

/**
 * Sends every attempt the same way. The Monitor's refusal names the attempt by its place in the
 * batch and its run, which the failure carries.
 *
 * @returns {Promise<{ batches: number, attempts: number }>}
 */
export async function sendAttempts({ url, key, attempts, fetchImpl = globalThis.fetch, maxRuns, maxChars }) {
  const { batches, sent } = await postBatches({
    url,
    key,
    path: '/v1/ci-attempts',
    field: 'attempts',
    noun: 'attempts',
    items: attempts,
    fetchImpl,
    maxRuns,
    maxChars,
    label: (attempt) => `Attempt ${attempt.attempt} of run ${attempt.runId}`,
  });
  return { batches, attempts: sent };
}
