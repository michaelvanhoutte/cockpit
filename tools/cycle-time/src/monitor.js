/**
 * The Harness Monitor, and nothing else: where the next send starts reading,
 * and the send itself. The rows are model.js's (`monitorRows`); this file only
 * asks and posts. `fetchImpl` is a parameter, as in github.js, so the tests can
 * stand in for the Monitor.
 *
 * A send is a series of requests, each one batch the Monitor stores whole or
 * refuses whole. A send cut short leaves the batches before it stored, and the
 * next run's overlap sends the rest again: pull requests are replaced by their
 * number, so nothing is ever doubled. The backfill can send timelines alone,
 * which the Monitor stores beside the pull requests it holds without replacing them.
 */

const DAY_MS = 86_400_000;

/** How far before the newest stored merge the next send starts: a fluke found since lands within it. */
export const OVERLAP_DAYS = 2;
/**
 * The Monitor's own caps on one send: 50 pull requests, and a body under 1,000,000 characters. The
 * body is kept well clear of it: the Monitor flattens failing steps and files into one JSON string
 * each, which can run to three times the body and must stay under D1's 2 MB a string. Each pull
 * request's timeline is counted in its size, and the Monitor binds a batch's timelines as one value
 * of about their own size, so it stays under that cap too.
 */
export const BATCH_PULLS = 50;
export const BATCH_CHARS = 400_000;
/** Longest a request to the Monitor may take before the send gives up on it. */
const REQUEST_MS = 60_000;

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
    res = await fetchImpl(address(url, '/v1/cycle-time'), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_MS) });
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
 * The pull requests, or their timelines, cut into batches of at most `maxPulls`
 * rows and `maxChars` characters of body. A row too large for a batch on its
 * own is refused here, naming its pull request, since the Monitor would refuse it anyway.
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
export function sendPulls({ url, key, pulls, fetchImpl = globalThis.fetch, maxPulls, maxChars }) {
  return sendBatches({ url, key, path: '/v1/cycle-time', field: 'pulls', rows: pulls, rest: "the next send's overlap sends the rest again", fetchImpl, maxPulls, maxChars });
}

/**
 * Sends each pull request's timeline alone, `{ number, timeline }`, beside the pull requests the
 * Monitor already holds: the backfill, which never replaces a pull request. Batches as `sendPulls` does,
 * except that a batch the Monitor refuses for what it holds is sent again one timeline at a time and
 * the send goes on: a timeline that does not fit is refused on every run, and would otherwise keep
 * every other timeline of its batch, and every batch after it, from ever being stored. The send then
 * fails, naming each timeline refused.
 *
 * @returns {Promise<{ batches: number, pulls: number }>}
 */
export async function sendTimelines({ url, key, timelines, fetchImpl = globalThis.fetch, maxPulls, maxChars }) {
  const refused = [];
  const result = await sendBatches({
    url,
    key,
    path: '/v1/cycle-time/timelines',
    field: 'timelines',
    rows: timelines,
    rest: 'the same backfill run again sends the rest, and stores each timeline once',
    fetchImpl,
    maxPulls,
    maxChars,
    refused,
  });
  if (refused.length > 0) {
    throw new MonitorError(
      `The Harness Monitor refused ${refused.length} timeline${refused.length === 1 ? '' : 's'} and stored the other ${result.pulls}. ` +
        `Running the window again refuses ${refused.length === 1 ? 'it' : 'them'} again: a pull request the Monitor does not hold needs sending first, and one whose rounds differ from the stored ones keeps no timeline.\n` +
        refused.map((reason) => `  ${reason}`).join('\n'),
    );
  }
  return result;
}

/** The error the Monitor gave for a refused request, or null when it gave none. */
const reasonOf = (res) =>
  res
    .json()
    .then((body) => body?.error ?? null)
    .catch(() => null);

/**
 * Sends `rows` in batches, stopping at the first the Monitor does not store. Given `refused`, a batch
 * refused as the wrong shape for what the Monitor holds (400) is sent again one row at a time instead,
 * each row refused alone is added to `refused`, and the send goes on.
 */
async function sendBatches({ url, key, path, field, rows, rest, fetchImpl, maxPulls, maxChars, refused = null }) {
  const batches = cutBatches(rows, { maxPulls, maxChars });
  let sent = 0;
  for (const [index, batch] of batches.entries()) {
    const stored = () => `${index} batch${index === 1 ? '' : 'es'} of ${batches.length} ${index === 1 ? 'was' : 'were'} stored (${sent} pull requests); ${rest}.`;
    const post = async (body) => {
      try {
        return await fetchImpl(address(url, path), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ [field]: body }),
          signal: AbortSignal.timeout(REQUEST_MS),
        });
      } catch (error) {
        throw new MonitorError(`Could not reach the Harness Monitor with batch ${index + 1} of ${batches.length}: ${error.message}. ${stored()}`);
      }
    };
    const refusal = async (res) => {
      const reason = await reasonOf(res);
      return new MonitorError(`The Harness Monitor refused batch ${index + 1} of ${batches.length} (${res.status}${reason ? `: ${reason}` : ''}). ${stored()}`);
    };

    const res = await post(batch);
    if (res.ok) {
      sent += batch.length;
      continue;
    }
    if (!refused || res.status !== 400) throw await refusal(res);
    for (const row of batch) {
      const alone = batch.length === 1 ? res : await post([row]);
      if (alone.ok) sent += 1;
      else if (alone.status === 400) refused.push((await reasonOf(alone)) ?? `#${row.number}: refused.`);
      else throw await refusal(alone);
    }
  }
  return { batches: batches.length, pulls: sent };
}
