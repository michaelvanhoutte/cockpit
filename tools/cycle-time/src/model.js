/**
 * The numbers, and nothing else. Takes the pull requests github.js fetched and
 * returns the model: no I/O, and no clock of its own — `now` is a parameter, so
 * a window boundary is something a test can put anywhere it likes.
 *
 * **A pull request is one line, cut into the parts it spent:**
 *
 *   start ─ before the first push ─ push ┬ round ┬ fixing ─ push ┬ round ┬ waiting ─ merge
 *
 * where a *push* is a commit that had checks run on it (the API records when a
 * check started, never when a push arrived, so the earliest moment any check on
 * the commit was seen is the push), a *round* runs from a push to the last check
 * that ran on it finishing, and a gap of over three hours is *away* rather than
 * fixing or waiting — a night is not a slow review.
 *
 * **Time nobody wrote down reads as not recorded, never zero.** The session's
 * start and its local reviews come from the record on the pull request body
 * (scripts/lib/session-record.mjs, which owns the format); a pull request that
 * has none starts at its first commit, and says so.
 */

import { PHASES, REVIEW_KINDS, readBlock, readRuns } from '../../../scripts/lib/session-record.mjs';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A gap longer than this is somebody away, not somebody fixing or a check waiting to be looked at. */
export const AWAY_MS = 3 * HOUR_MS;

/** Two reviews whose end marks are this close were written together, so neither one's own length is recorded. */
const TOGETHER_MS = 1000;

/** A round that took longer than this is one somebody was kept waiting on. */
export const LONG_ROUND_MS = 10 * 60_000;

/**
 * The kinds of CI check a round is held by. Every check is `checks` today, the tests
 * and the mechanical ones alike: the remote reviews ran as checks of their own until
 * "Remove the remote code and security reviews" (pull request 512), and a review is
 * now a local kind (`LOCAL_REVIEW_KINDS`), never a check.
 */
export const CHECK_KINDS = ['checks'];

/** The prefix of a feature branch: a pull request into one is read, and one from one into the trunk is a landing. */
export const FEATURE_PREFIX = 'feature/';

/**
 * A pull request from a feature branch into the trunk. Its units were each a pull request into the
 * branch and are counted there, so counting the landing as well would count the same work twice.
 */
const isLanding = (head, base, trunk) => base === trunk && typeof head === 'string' && head.startsWith(FEATURE_PREFIX);

/** The reviews a session marks, from the session record: local time, apart from CI's. */
export const LOCAL_REVIEW_KINDS = REVIEW_KINDS;

/** The local time that is not a review: test runs the runners recorded, and the browser pass the session marked. */
export const LOCAL_RUN_KINDS = ['test', 'browser'];

/**
 * Every conclusion the Actions API documents, and what it means here. `other` is
 * known-but-not-a-verdict; `unknown` is a value that did not exist when this was
 * written — both are neither a pass nor a fail, and an unknown one is named.
 */
const CONCLUSIONS = new Map([
  ['success', 'pass'],
  ['failure', 'fail'],
  ['timed_out', 'fail'],
  ['startup_failure', 'fail'],
  ['cancelled', 'cancelled'],
  ['skipped', 'skipped'],
  ['neutral', 'other'],
  ['action_required', 'other'],
  ['stale', 'other'],
]);

/** @param {{ status?: string, conclusion?: string|null }} check */
export function classify({ status, conclusion }) {
  if (status && status !== 'completed') return 'running';
  if (conclusion === null || conclusion === undefined) return 'running';
  return CONCLUSIONS.get(conclusion) ?? 'unknown';
}

/**
 * The jobs whose attempts upload a record of which test files failed, and the
 * artifact each uploads. Every other check names the step that failed and no files. For a shard
 * family the fan-in is the job of that name and uploads the merged record.
 */
const RECORD_ARTIFACTS = { Test: 'test-selection-record', 'E2E (F3)': 'e2e-selection-record' };

/** The artifact a job uploads its record as, or `null` for a check that keeps none. */
export const recordArtifactOf = (check) => (Object.hasOwn(RECORD_ARTIFACTS, check) ? RECORD_ARTIFACTS[check] : null);

/**
 * How long after a job completed an artifact it uploaded may still be stamped:
 * the upload is a step of the job, but the two clocks are read to the second and
 * the job's end can be recorded just before its last step's artifact is. Small
 * enough that a re-run, which starts later and uploads minutes after that, never
 * falls inside the earlier attempt's window.
 */
export const UPLOAD_SLACK_MS = 30_000;

/**
 * The one artifact an attempt uploaded, out of the run's artifacts of that name.
 * A re-run uploads a second one under the same name with no attempt number, so an
 * attempt owns the artifacts created during its own job. Zero is `absent`, and more
 * than one is `ambiguous` — never the first guessed — and both read as not recorded,
 * as does one that has `expired`.
 *
 * @param {{ id: number, createdAt: string, expired: boolean }[]} artifacts
 * @param {{ startedAt: string|null, completedAt: string|null }} job
 * @returns {{ artifact: { id: number } } | { why: 'absent'|'expired'|'ambiguous' }}
 */
export function matchArtifact(artifacts, { startedAt, completedAt }) {
  const from = time(startedAt);
  const to = time(completedAt);
  if (from === null || to === null) return { why: 'absent' };
  const inside = artifacts.filter((artifact) => {
    const made = time(artifact.createdAt);
    return made !== null && made >= from && made <= to + UPLOAD_SLACK_MS;
  });
  if (inside.length === 0) return { why: 'absent' };
  if (inside.length > 1) return { why: 'ambiguous' };
  return inside[0].expired ? { why: 'expired' } : { artifact: { id: inside[0].id } };
}

/**
 * The test files a `test-selection-record` or `e2e-selection-record` marks failed,
 * and the packages that wrote no report, whose files it cannot say anything about.
 */
export function failedFilesOf(record) {
  const packages = Array.isArray(record?.packages) ? record.packages : [];
  return {
    files: packages.filter((pkg) => pkg.report !== 'none').flatMap((pkg) => (pkg.files ?? []).filter((file) => file.status === 'failed').map((file) => file.path)),
    packagesNotRecorded: packages.filter((pkg) => pkg.report === 'none').map((pkg) => pkg.name),
  };
}

/**
 * Median and p95 of a set of durations, in milliseconds. Median averages the
 * middle pair on an even count; p95 is nearest-rank, so it is always a duration
 * that really happened. One value is therefore both, which is the honest answer
 * for a figure with one thing behind it. `null` for none.
 */
export function quantiles(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
  const rank = Math.max(1, Math.ceil(0.95 * sorted.length));
  return { median, p95: sorted[rank - 1], count: sorted.length };
}

/**
 * A figure over `entries` of `{ pull, value }`: its quantiles, the number of items
 * behind them, and the number of pull requests those items came from — two rounds
 * of one pull request are two items and one pull request. `null` where there is
 * nothing to say, which is not the same as zero.
 */
function figure(entries) {
  const q = quantiles(entries.map((entry) => entry.value));
  return q && { ...q, pulls: new Set(entries.map((entry) => entry.pull)).size };
}

const time = (text) => {
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
};
const iso = (ms) => new Date(ms).toISOString();
const sum = (values) => values.reduce((total, value) => total + value, 0);

/** Every attempt at one check, oldest first — a check is a name within a check suite, and a re-run adds an attempt to it. */
function attemptsByCheck(checks) {
  const groups = new Map();
  for (const check of checks) {
    const key = `${check.suiteId}|${check.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(check);
  }
  const started = (check) => time(check.startedAt) ?? time(check.completedAt) ?? 0;
  for (const attempts of groups.values()) attempts.sort((a, b) => started(a) - started(b) || a.id - b.id);
  return [...groups.values()];
}

/**
 * A shard job is named for its family and its index, `E2E (F3) (1)`: the name a matrix job
 * called `E2E (F3)` over a `shard` dimension gets on GitHub. The family is the fan-in job
 * that `needs` every shard, named exactly the family (`E2E (F3)`), so the required check and
 * today's single job keep one name. The family's name ends in something other than a number,
 * so `E2E (F3)` itself is never read as a shard.
 */
const SHARD_NAME = /^(.+) \((\d+)\)$/;

/** The family and index a job name is a shard of, or `null` for a job that is not one. */
export const shardOf = (name) => {
  const match = SHARD_NAME.exec(name);
  return match ? { family: match[1], index: Number(match[2]) } : null;
};

const startedOrder = (a, b) => (time(a.startedAt) ?? time(a.completedAt) ?? 0) - (time(b.startedAt) ?? time(b.completedAt) ?? 0) || a.id - b.id;

/** The verdict of a family whose fan-in was not read: the worst of what its shards said. */
function derivedConclusion(members) {
  const outcomes = members.map(classify);
  if (outcomes.includes('fail')) return { status: 'completed', conclusion: 'failure' };
  if (outcomes.includes('running')) return { status: 'in_progress', conclusion: null };
  if (outcomes.includes('cancelled')) return { status: 'completed', conclusion: 'cancelled' };
  if (outcomes.every((outcome) => outcome === 'skipped')) return { status: 'completed', conclusion: 'skipped' };
  if (outcomes.every((outcome) => outcome === 'pass' || outcome === 'skipped')) return { status: 'completed', conclusion: 'success' };
  return { status: 'completed', conclusion: 'neutral' };
}

/**
 * One attempt of a family: its fan-in's verdict and end, its shards' earliest start, and its
 * shards' own details gathered under its name.
 *
 * The queue is the longest wait of any shard, since the round waits for the last one to start;
 * it reads `not-recorded` where a shard's job list could not be read or the family is not whole
 * (a shard missing, or no fan-in), never the longest of the shards that happened to be read.
 */
function familyAttempt(family, members, fresh, fanIn, complete) {
  // The jobs this attempt ran, for its start and running time: each shard's own attempt in this wave, never a stand-in counted again, and the fan-in.
  const jobs = [...fresh, ...(fanIn ? [fanIn] : [])];
  const starts = jobs.map((attempt) => time(attempt.startedAt)).filter((ms) => ms !== null);
  const ended = fanIn ? fanIn.completedAt : members.every((member) => time(member.completedAt) !== null) ? iso(Math.max(...members.map((member) => time(member.completedAt)))) : null;
  const failing = members.filter((member) => classify(member) === 'fail');
  // A fan-in skipped behind a failed shard (a `needs` job without `always()`) says nothing, so the shards' verdict stands in.
  const verdict = fanIn && !(failing.length > 0 && classify(fanIn) === 'skipped') ? { status: fanIn.status, conclusion: fanIn.conclusion } : derivedConclusion(members);

  const unreadable = members.find((member) => member.queue?.state === 'not-recorded');
  const waits = fresh.map((member) => ({ member, ms: queuedMs(member) })).filter((wait) => wait.ms !== null);
  let queue;
  if (unreadable || !complete) queue = { state: 'not-recorded', why: unreadable?.queue.why ?? 'family-incomplete' };
  else if (waits.length) {
    const longest = waits.reduce((most, wait) => (wait.ms > most.ms ? wait : most));
    queue = { state: 'read', createdAt: longest.member.queue.createdAt, startedAt: longest.member.queue.startedAt };
  }

  // What a failed attempt names: the steps come from the shards that failed, the record from the fan-in, which merged them.
  const failure = {
    steps: [...new Set(failing.flatMap((member) => member.failure?.steps ?? []))],
    record: fanIn?.failure?.record,
    unreadable: [...failing, ...(fanIn ? [fanIn] : [])].some((attempt) => attempt.failure?.unreadable),
  };

  return {
    id: fanIn?.id ?? members[0].id,
    name: family,
    suiteId: (fanIn ?? members[0]).suiteId,
    app: (fanIn ?? members[0]).app,
    ...verdict,
    startedAt: starts.length ? iso(Math.min(...starts)) : null,
    completedAt: ended,
    ...(queue ? { queue } : {}),
    failure,
    family: { shards: members.length, complete },
    jobs,
  };
}

/**
 * The checks of one commit with every shard family folded into one check under the family's name,
 * for the counts: red, fluke, queue, failure and what held a round. Its attempts are the fan-in's,
 * the n-th attempt standing for the n-th of each shard (a shard that was not re-run stands in
 * with its last). The shards themselves stay in the commit's own list, which the round's start,
 * the runner minutes and the lanes read.
 */
function foldFamilies(checks) {
  const shards = checks.filter((check) => shardOf(check.name));
  if (shards.length === 0) return checks;

  const families = new Map();
  for (const shard of shards) {
    const { family, index } = shardOf(shard.name);
    const key = `${shard.suiteId}|${family}`;
    if (!families.has(key)) families.set(key, { family, suiteId: shard.suiteId, byIndex: new Map() });
    const { byIndex } = families.get(key);
    if (!byIndex.has(index)) byIndex.set(index, []);
    byIndex.get(index).push(shard);
  }

  const folded = [];
  const replaced = new Set(shards);
  for (const { family, suiteId, byIndex } of families.values()) {
    const fanIns = checks.filter((check) => check.suiteId === suiteId && check.name === family).sort(startedOrder);
    fanIns.forEach((fanIn) => replaced.add(fanIn));
    const indices = [...byIndex.keys()].sort((a, b) => a - b);
    const whole = indices.every((index, position) => index === position + 1);
    const lists = indices.map((index) => byIndex.get(index).sort(startedOrder));
    const waves = Math.max(fanIns.length, ...lists.map((list) => list.length));
    for (let wave = 0; wave < waves; wave += 1) {
      const members = lists.map((list) => list[Math.min(wave, list.length - 1)]);
      const fanIn = fanIns[wave] ?? null;
      // A shard that was not re-run stands in with its last attempt, which started and waited in an earlier wave.
      const fresh = lists.flatMap((list) => (list[wave] ? [list[wave]] : []));
      folded.push(familyAttempt(family, members, fresh, fanIn, whole && fanIn !== null));
    }
  }
  return [...checks.filter((check) => !replaced.has(check)), ...folded];
}

/**
 * The moment a push is taken to have happened: the earliest time any check on the
 * commit was seen, skipped ones included since a skipped job resolves the moment
 * it is created. A skipped check's own start can come *after* its completion, so
 * both ends are read.
 */
function pushTime(checks) {
  const seen = checks.flatMap((check) => [time(check.startedAt), time(check.completedAt)]).filter((ms) => ms !== null);
  return seen.length ? Math.min(...seen) : null;
}

/** A check that failed and was then re-run to a pass on the same commit, and how much longer the round ran for it. */
function flukesOf(groups, sha) {
  const flukes = [];
  for (const attempts of groups) {
    const failed = attempts.findIndex((attempt) => classify(attempt) === 'fail');
    if (failed === -1) continue;
    const passed = attempts.findIndex((attempt, index) => index > failed && classify(attempt) === 'pass');
    if (passed === -1) continue;
    const from = time(attempts[failed].completedAt);
    const to = time(attempts[passed].completedAt);
    if (from === null || to === null) continue;
    flukes.push({ name: attempts[failed].name, sha, ms: Math.max(0, to - from) });
  }
  return flukes;
}

/** How far before its creation a job may start and still be a job that ran: the two stamps are read to the second. */
export const COPY_TOLERANCE_MS = 5_000;

/**
 * A re-run copies the jobs that passed, and a copy is created after the start it carries.
 * Only known where the job list was read.
 */
const isCopy = (attempt) => {
  if (attempt.queue?.state !== 'read') return false;
  const created = time(attempt.queue.createdAt);
  const started = time(attempt.queue.startedAt);
  return created !== null && started !== null && started < created - COPY_TOLERANCE_MS;
};

/**
 * How long a job waited for a runner: its creation to its start. A job that waits on `needs:`
 * is created only when its dependency finishes, so that wait is never in it. `null` where
 * there is nothing to say: no job list read, a copy, a skipped job, one that never started.
 */
function queuedMs(attempt) {
  if (attempt.queue?.state !== 'read' || isCopy(attempt) || classify(attempt) === 'skipped') return null;
  const created = time(attempt.queue.createdAt);
  const started = time(attempt.queue.startedAt);
  return created === null || started === null ? null : Math.max(0, started - created);
}

/** Runner time one attempt used, start to end; a check another app posted, a copy, a skipped job and one that never started used none. */
function runnerMs(attempt) {
  const from = time(attempt.startedAt);
  const to = time(attempt.completedAt);
  if ((attempt.app != null && attempt.app !== 'github-actions') || isCopy(attempt) || classify(attempt) === 'skipped' || from === null || to === null) return 0;
  return Math.max(0, to - from);
}

/**
 * Runner time an attempt's jobs used between them, each by `runnerMs`: a folded family's every shard
 * and its fan-in, added up. Queueing is never in it, so a pull request's GitHub Actions attempts add up to its runner total.
 */
const runningMs = (attempt) => sum((attempt.jobs ?? [attempt]).map(runnerMs));

/** A cancelled job stamped as started the moment it ended was cancelled before a runner took it. */
const neverStarted = (attempt) => {
  const from = time(attempt.startedAt);
  return from === null || from === time(attempt.completedAt);
};

/**
 * How long after a cancellation the next push may be seen and still have caused it. A push is
 * the earliest moment a check on it was seen, and the run it starts cancels the old one as it
 * is created: the cancelled job ends in the same second or a few before the new run's first
 * job is stamped.
 */
export const SUPERSEDE_SLACK_MS = 5_000;

/**
 * The runner minutes of a pull request, and those thrown away by cancelling. A cancelled
 * attempt is `superseded` when a push on the pull request arrived after the attempt started (after
 * its creation where it never did) and before it ended (within `SUPERSEDE_SLACK_MS` after it), which is what `cancel-in-progress` does; any other cancellation is `other`.
 */
function runnerOf(commits, rounds) {
  // A push is when its first CI job was created where that was read: a job that waited for a
  // runner is stamped as started long after the push that created it.
  const pushes = rounds.map((round) => {
    const created = (commits.find((commit) => commit.sha === round.sha)?.checks ?? [])
      .filter((attempt) => attempt.queue?.state === 'read')
      .map((attempt) => time(attempt.queue.createdAt))
      .filter((ms) => ms !== null);
    return created.length ? Math.min(...created) : time(round.pushedAt);
  });
  const cancelled = { superseded: { runs: 0, ms: 0 }, other: { runs: 0, ms: 0 } };
  let total = 0;
  for (const commit of commits) {
    for (const attempt of commit.checks) {
      if (attempt.app != null && attempt.app !== 'github-actions') continue;
      const ms = runnerMs(attempt);
      total += ms;
      if (classify(attempt) !== 'cancelled' || isCopy(attempt)) continue;
      const ended = time(attempt.completedAt);
      const from = neverStarted(attempt) ? time(attempt.queue?.createdAt) : time(attempt.startedAt);
      const superseded = ended !== null && from !== null && pushes.some((push) => push > from && push <= ended + SUPERSEDE_SLACK_MS);
      cancelled[superseded ? 'superseded' : 'other'].runs += 1;
      cancelled[superseded ? 'superseded' : 'other'].ms += ms;
    }
  }
  return { ms: total, cancelled };
}

/**
 * What each failed attempt of a round failed on: the step it stopped at and, for
 * `Test` and `E2E (F3)`, the files its own record marks failed. `outcome` is `red`
 * where the check never passed on the commit and `fluke` where a re-run did.
 *
 * `record` is `null` for a check that keeps none, `read`, or `not-recorded` with
 * `why` (`expired`, `absent`, `ambiguous`, `unreadable`, `not-fetched` where nothing was asked for, or `no-file-failed` where a record was read and marks none) — never an empty file list standing in for it, since an attempt nobody
 * can read is not an attempt that failed on nothing.
 */
function failuresOf(groups) {
  const failures = [];
  for (const { attempts, red } of groups) {
    const outcome = red ? 'red' : 'fluke';
    attempts.forEach((attempt, index) => {
      if (classify(attempt) !== 'fail') return;
      const detail = attempt.failure ?? null;
      const failure = { check: attempt.name, attempt: index + 1, outcome, steps: detail?.steps ?? [], files: [], record: null, why: null, packagesNotRecorded: [] };
      if (recordArtifactOf(attempt.name) !== null) {
        if (detail?.record?.state === 'read') {
          failure.record = 'read';
          const { files, packagesNotRecorded } = failedFilesOf(detail.record.value);
          failure.files = files;
          failure.packagesNotRecorded = packagesNotRecorded;
          // Read, and no file in it failed: the job failed outside any test file, which is not the same as nothing failing.
          if (files.length === 0 && packagesNotRecorded.length === 0) failure.why = 'no-file-failed';
        } else {
          failure.record = 'not-recorded';
          failure.why = detail?.record?.why ?? 'not-fetched';
        }
      }
      else if (detail?.unreadable) failure.why = 'unreadable';
      failures.push(failure);
    });
  }
  return failures;
}

/**
 * Every job that ran in a round, each its own lane: where it started and stopped inside the
 * round, and its wait for a runner as a lead before the start. A skipped job, a re-run's copy
 * of a job that passed and a job cancelled before a runner took it ran nothing and have none.
 * A re-run of a job is its own lane, `rerun`, after the first.
 *
 * `null` where no job drew a lane, or the jobs of the round were not all read: a lane needs its job's creation for
 * the lead, and a round with a job whose list is missing is not drawn as lanes that
 * look complete. A lead is cut at the round's start, since nothing before the first job to start
 * belongs to the round.
 *
 * @param {object[]} checks every check run of the round's commit
 * @param {number} from the round's start, in epoch milliseconds
 * @param {number} to the round's end
 */
function lanesOf(checks, from, to) {
  const ran = checks.filter((check) => classify(check) !== 'skipped' && !isCopy(check) && !(classify(check) === 'cancelled' && neverStarted(check)));
  if (ran.some((check) => (check.app == null || check.app === 'github-actions') && check.queue?.state !== 'read')) return null;

  const position = new Map(attemptsByCheck(ran).flatMap((group) => group.map((attempt, index) => [attempt, index])));
  const families = new Map();
  for (const check of ran) {
    const shard = shardOf(check.name);
    if (shard) families.set(`${check.suiteId}|${shard.family}`, true);
  }

  const lanes = ran
    .map((check) => {
      const start = time(check.startedAt);
      const end = time(check.completedAt) ?? to;
      if (start === null || start >= to) return null;
      const offsetMs = Math.max(0, start - from);
      const ms = Math.max(0, Math.min(end, to) - Math.max(start, from));
      const waited = queuedMs(check);
      const shard = shardOf(check.name);
      const fanIn = !shard && families.has(`${check.suiteId}|${check.name}`);
      return {
        name: check.name,
        ...(shard ? { family: shard.family, shard: shard.index } : fanIn ? { family: check.name, fanIn: true } : {}),
        attempt: position.get(check) + 1,
        rerun: position.get(check) > 0,
        outcome: classify(check),
        startedAt: iso(start),
        endedAt: time(check.completedAt) === null ? null : iso(time(check.completedAt)),
        offsetMs,
        ms,
        // The wait is cut at the round's start; `queuedMs` is the whole of it.
        leadMs: Math.min(waited ?? 0, offsetMs),
        queuedMs: waited,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.offsetMs - b.offsetMs || a.offsetMs + a.ms - (b.offsetMs + b.ms) || a.name.localeCompare(b.name) || a.attempt - b.attempt);
  // No job drew a lane (all cancelled before a runner took them): the round is the block, never an empty one.
  return lanes.length > 0 ? lanes : null;
}

/**
 * The rounds of a pull request, in push order.
 *
 * A commit no check ran on — or only skipped ones did — is not a round of its
 * own; it went out with the next push and is counted in that round's `commits`.
 * A round ends when the last check that ran finished, and never later than the
 * next push (a check the next push cancelled is in flight until it is cancelled,
 * and cancellation lags) or the merge.
 */
function buildRounds(commits, mergedAt) {
  const pushes = [];
  let waiting = 0;
  for (const commit of commits) {
    // A shard family is one check here; the commit's own list still holds every shard, for the round's start.
    const groups = attemptsByCheck(foldFamilies(commit.checks));
    const ran = groups.map((attempts) => attempts.filter((attempt) => classify(attempt) !== 'skipped')).filter((attempts) => attempts.length > 0);
    const at = pushTime(commit.checks);
    if (ran.length === 0 || at === null) {
      waiting += 1;
      continue;
    }
    pushes.push({ commit, at, groups, ran, commits: waiting + 1 });
    waiting = 0;
  }
  pushes.sort((a, b) => a.at - b.at);

  return pushes.map((push, index) => {
    const cap = Math.max(push.at, pushes[index + 1]?.at ?? mergedAt);
    const finish = (attempt) => Math.min(cap, Math.max(push.at, time(attempt.completedAt) ?? cap));

    // Each attempt is charged the time since the one before it finished, so two
    // checks in flight together are counted once, and whichever finished last is
    // the one that held the round up.
    const ordered = push.ran
      .flatMap((attempts) => attempts.map((attempt, position) => ({ attempt, rerun: position > 0 })))
      .map((entry) => ({ ...entry, end: finish(entry.attempt) }))
      .sort((a, b) => a.end - b.end || (time(a.attempt.startedAt) ?? 0) - (time(b.attempt.startedAt) ?? 0));
    let previous = push.at;
    const held = ordered.map(({ attempt, rerun, end }) => {
      const ms = end - previous;
      previous = end;
      // `attempt` is its place among every attempt of the check, as `failures` numbers them, and `queuedMs` its own wait for a runner: what the Harness Monitor's rows are linked by.
      // `runningMs` is the runner time its jobs used, start to end, however long it held the round.
      const attemptNumber = push.groups.find((attempts) => attempts.includes(attempt)).indexOf(attempt) + 1;
      return { name: attempt.name, ms, ...(rerun ? { rerun: true } : {}), attempt: attemptNumber, queuedMs: queuedMs(attempt), runningMs: runningMs(attempt) };
    });

    // What a check ended as is its last attempt that reached a verdict: a failure
    // re-run to a pass is a fluke, not a red round, while one whose re-run was
    // cancelled before it finished has still never passed.
    const decisive = (attempt) => ['pass', 'fail'].includes(classify(attempt));
    const verdicts = push.groups.map((attempts) => ({ attempts, red: classify(attempts.findLast(decisive) ?? attempts[0]) === 'fail' }));
    const failed = verdicts.filter((group) => group.red).map((group) => group.attempts[0].name);
    const finals = push.groups.map((attempts) => attempts[attempts.length - 1]);
    const unrecognised = finals
      .filter((attempt) => classify(attempt) === 'unknown')
      .map((attempt) => ({ name: attempt.name, conclusion: attempt.conclusion }));

    return {
      sha: push.commit.sha,
      pushedAt: iso(push.at),
      endedAt: iso(previous),
      ms: previous - push.at,
      red: failed.length > 0,
      failed,
      unrecognised,
      held,
      last: held.length ? held[held.length - 1].name : null,
      flukes: flukesOf(push.groups, push.commit.sha),
      failures: failuresOf(verdicts),
      // Per attempt that ran, how long it waited for a runner; `queueNotRecorded` where a CI
      // job list could not be read, so the round's queue is missing rather than none.
      queued: push.ran.flat().map((attempt) => ({ name: attempt.name, ms: queuedMs(attempt) })).filter((entry) => entry.ms !== null),
      queueNotRecorded: push.ran.flat().some((attempt) => attempt.queue?.state === 'not-recorded'),
      lanes: lanesOf(push.commit.checks, push.at, previous),
      commits: push.commits,
    };
  });
}

/**
 * What the session record on a pull request body says, read against the first
 * commit. `start` is null where it cannot be trusted or is not there; the rest is
 * read regardless — a record missing one phase is a record with that phase not
 * recorded, not a record to throw away.
 */
function readRecord(body, firstCommit) {
  const absent = { present: false, start: null, notRecorded: [], localReviews: null, reviews: [], tests: [], browser: [], localRuns: { test: null, browser: null }, notes: [] };
  let entries;
  let runs;
  try {
    entries = readBlock(body ?? '');
    runs = readRuns(body ?? '');
  } catch (error) {
    return { ...absent, notes: [`The session record could not be read: ${error.message}`] };
  }
  if (entries.length === 0 && runs.length === 0) return absent;

  const marks = entries.map((entry) => ({ ...entry, ms: time(entry.at) })).filter((entry) => entry.ms !== null);
  const notes = [];

  let start = marks.find((entry) => entry.phase === 'start')?.ms ?? null;
  // A session cannot have begun after the commit it made, so a start that says
  // it did is a clock or a record that does not belong to this branch.
  if (start !== null && firstCommit !== null && start > firstCommit) {
    notes.push("The session record's start is after the pull request's first commit, so it is ignored.");
    start = null;
  }

  // A review is its start paired with the next end of the same kind; a second
  // start with no end between leaves the earlier one unpaired, and unpaired marks
  // say nothing about how long a review took. A review of a kind the session record does not
  // know, written by hand, is left out, since the local time is split by the kinds it knows.
  const open = new Map();
  const reviews = [];
  for (const mark of marks) {
    if (mark.phase === 'review-start' && REVIEW_KINDS.includes(mark.kind)) open.set(mark.kind, mark);
    else if (mark.phase === 'review-end' && open.has(mark.kind)) {
      const begun = open.get(mark.kind);
      open.delete(mark.kind);
      if (mark.ms >= begun.ms) reviews.push({ kind: mark.kind, level: mark.level, startMs: begun.ms, endMs: mark.ms, ms: mark.ms - begun.ms });
    }
  }
  // A record written before each review marked its own end has the ends written together, so a review's
  // own length is not in it: two reviews of different kinds ending within a second of each other.
  for (const review of reviews) {
    review.endedTogether = reviews.some((other) => other.kind !== review.kind && Math.abs(other.endMs - review.endMs) <= TOGETHER_MS);
  }

  // The browser pass pairs the same way: a start with no end after it times nothing.
  const browser = [];
  let browserOpen = null;
  for (const mark of marks) {
    if (mark.phase === 'browser-start') browserOpen = mark;
    else if (mark.phase === 'browser-end' && browserOpen) {
      if (mark.ms >= browserOpen.ms) browser.push({ startMs: browserOpen.ms, endMs: mark.ms, ms: mark.ms - browserOpen.ms });
      browserOpen = null;
    }
  }

  // A test run the runners wrote is already an interval; one whose times cannot be read says nothing.
  const tests = runs
    .map((run) => ({ scopes: run.scopes, startMs: time(run.start), endMs: time(run.end) }))
    .filter((run) => run.startMs !== null && run.endMs !== null && run.endMs >= run.startMs)
    .map((run) => ({ ...run, ms: run.endMs - run.startMs }));

  const byKind = {};
  for (const review of reviews) {
    byKind[review.kind] ??= { count: 0, ms: 0 };
    byKind[review.kind].count += 1;
    byKind[review.kind].ms += review.ms;
  }

  return {
    present: true,
    start,
    notRecorded: PHASES.filter((phase) => !entries.some((entry) => entry.phase === phase)),
    // `ms` is the reviews' wall clock, where parallel reviews share their minutes once; `byKind` is each kind's own.
    localReviews: reviews.length ? { count: reviews.length, ms: unionRanges(reviews.map((review) => ({ from: review.startMs, to: review.endMs }))), byKind } : null,
    reviews,
    tests,
    browser,
    // As marked, the way `localReviews` is; `null` for a kind the record has none of, which is not recorded and not zero.
    localRuns: {
      test: tests.length ? { count: tests.length, ms: sum(tests.map((run) => run.ms)) } : null,
      browser: browser.length ? { count: browser.length, ms: sum(browser.map((pass) => pass.ms)) } : null,
    },
    notes,
  };
}

/**
 * Where each local review sat among the parts of the pull request, and how much of it
 * counts. A review is cut to the gaps it ran in — before the first push, and between
 * a round and the next push — because only there was somebody writing for it to come
 * out of. Time inside a round, after the last round, and in a gap long enough to read
 * as away is in no slice, so the strip and the scatter's harness add up the same
 * minutes. A review keeps its own marked interval, so two that ran in parallel overlap and
 * the strip draws them as lanes.
 *
 * @param {{ kind: string, level: string, startMs: number, endMs: number }[]} reviews
 * @param {{ gap: number, from: number, to: number }[]} gaps `gap` is 0 before the first push, and n after round n
 */
function sliceReviews(reviews, gaps) {
  const slices = [];
  for (const review of [...reviews].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    for (const gap of gaps) {
      const start = Math.max(review.startMs, gap.from);
      const end = Math.min(review.endMs, gap.to);
      if (end > start) slices.push({ kind: review.kind, level: review.level, ...(review.endedTogether ? { endedTogether: true } : {}), gap: gap.gap, at: iso(start), ms: end - start });
    }
  }
  return slices;
}

/**
 * Where each test run and browser pass sat, cut to the same gaps as a review. A test run in
 * the background during a review is drawn as well as the review, and `unionMs` counts the
 * minutes they share once.
 *
 * @param {{ kind: 'test'|'browser', scopes?: string[], startMs: number, endMs: number }[]} runs
 */
function sliceRuns(runs, gaps) {
  const slices = [];
  for (const run of [...runs].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    for (const gap of gaps) {
      const start = Math.max(run.startMs, gap.from);
      const end = Math.min(run.endMs, gap.to);
      if (end > start) slices.push({ kind: run.kind, ...(run.scopes ? { scopes: run.scopes } : {}), gap: gap.gap, at: iso(start), ms: end - start });
    }
  }
  return slices;
}

/** The minutes that slices cover between them, where two that overlap count their shared minutes once. */
function unionMs(slices) {
  return unionRanges(slices.map((slice) => ({ from: Date.parse(slice.at), to: Date.parse(slice.at) + slice.ms })));
}

/** The local kinds in the order a part of Local checks is named: each review kind, then test runs and the browser pass. */
const LOCAL_KINDS = [...LOCAL_REVIEW_KINDS, ...LOCAL_RUN_KINDS];

/**
 * Each local kind's minutes with every minute counted once, so the four add up to the local time
 * `unionMs` gives exactly. A minute two slices share goes to the one that ends last; of two ending together, to the one that started later, then to the kind
 * later in `LOCAL_KINDS`, so the same slices always give the same parts. A kind with no slice is 0.
 *
 * @param {{ kind: string, at: string, ms: number }[]} slices the review and run slices, already cut to the gaps
 */
function localPartsOf(slices) {
  const ranges = slices
    .map((slice) => ({ kind: slice.kind, from: Date.parse(slice.at), to: Date.parse(slice.at) + slice.ms }))
    .sort((a, b) => b.to - a.to || b.from - a.from || LOCAL_KINDS.indexOf(b.kind) - LOCAL_KINDS.indexOf(a.kind));
  const parts = Object.fromEntries(LOCAL_KINDS.map((kind) => [kind, 0]));
  const taken = [];
  // The slice that ends last takes every minute it covers; each after it takes only what none before it took.
  for (const range of ranges) {
    const shared = taken.map((other) => ({ from: Math.max(other.from, range.from), to: Math.min(other.to, range.to) })).filter((overlap) => overlap.to > overlap.from);
    parts[range.kind] += range.to - range.from - unionRanges(shared);
    taken.push(range);
  }
  return parts;
}

/** The minutes that `{ from, to }` ranges cover between them, shared minutes once. */
function unionRanges(ranges) {
  let total = 0;
  let reach = -Infinity;
  for (const { from, to } of [...ranges].sort((a, b) => a.from - b.from)) {
    total += Math.max(0, to - Math.max(from, reach));
    reach = Math.max(reach, to);
  }
  return total;
}

/**
 * One merged pull request, cut into the parts it spent.
 *
 * @param {import('./github.js').Pull} pull
 * @param {string} [trunk] the branch whose pull requests are the report's own; a pull with no `base` is read as into it
 */
export function pullModel(pull, trunk = 'main') {
  const mergedAt = time(pull.mergedAt);
  const rounds = buildRounds(pull.commits, mergedAt);
  const runner = runnerOf(pull.commits, rounds);

  const firstCommit = pull.commits.map((commit) => time(commit.authoredAt)).filter((ms) => ms !== null).sort((a, b) => a - b)[0] ?? time(pull.createdAt) ?? mergedAt;
  const record = readRecord(pull.body, firstCommit);
  const startMs = record.start ?? firstCommit;
  const notes = [...record.notes];
  if (!record.present) notes.push('No session record: the time starts at the first commit, so any coding before it and the local reviews are not recorded.');

  // Every gap between one round finishing and whatever came next is somebody's
  // time, and is either spent fixing (or waiting to merge) or spent away.
  const fixing = [];
  const away = [];
  for (let index = 0; index + 1 < rounds.length; index += 1) {
    const ms = Math.max(0, time(rounds[index + 1].pushedAt) - time(rounds[index].endedAt));
    (ms > AWAY_MS ? away : fixing).push(ms);
  }
  let waitingToMerge = null;
  if (rounds.length > 0) {
    const waited = Math.max(0, mergedAt - time(rounds[rounds.length - 1].endedAt));
    if (waited > AWAY_MS) away.push(waited);
    waitingToMerge = waited > AWAY_MS ? 0 : waited;
  }

  const beforeFirstPushMs = rounds.length ? Math.max(0, time(rounds[0].pushedAt) - startMs) : null;

  // The gaps a local review can sit in: before the first push, and between a round and
  // the next push unless that gap reads as away. Waiting to merge is not one.
  const gaps = [];
  if (rounds.length > 0) gaps.push({ gap: 0, from: startMs, to: time(rounds[0].pushedAt) });
  for (let index = 0; index + 1 < rounds.length; index += 1) {
    const from = time(rounds[index].endedAt);
    const to = time(rounds[index + 1].pushedAt);
    if (to - from <= AWAY_MS) gaps.push({ gap: index + 1, from, to });
  }
  const reviewSlices = sliceReviews(record.reviews, gaps);
  const runSlices = sliceRuns([...record.tests.map((run) => ({ ...run, kind: 'test' })), ...record.browser.map((pass) => ({ ...pass, kind: 'browser' }))], gaps);

  // Coding against the harness: where a person was writing, against where the harness
  // was being waited on. Only a pull request with a record can say — without one,
  // its local reviews are not there to move out of the coding — and one no check ran
  // on has no round to weigh. Local review sits inside the time before the first push
  // and between pushes, so it is taken out of the coding and put with the harness.
  // Waiting to merge is neither: nobody was writing, and no check was running.
  let balance = null;
  if (record.present && rounds.length > 0) {
    const writingMs = beforeFirstPushMs + sum(fixing);
    // The slices are already cut to the gaps, so no more can move than the writing held.
    // Local time that overlaps (a test run during a review) is counted once.
    const localMs = unionMs([...reviewSlices, ...runSlices]);
    const codingMs = writingMs - localMs;
    const harnessMs = sum(rounds.map((round) => round.ms)) + localMs;
    balance = { codingMs, harnessMs, rounds: rounds.length, ratio: codingMs > 0 ? harnessMs / codingMs : null };
  }

  return {
    number: pull.number,
    title: pull.title,
    url: pull.url,
    mergedAt: pull.mergedAt,
    base: pull.base ?? trunk,
    head: pull.head ?? null,
    landing: isLanding(pull.head, pull.base ?? trunk, trunk),
    size: {
      additions: pull.additions,
      deletions: pull.deletions,
      files: pull.changedFiles,
      commits: pull.commitCount,
      // A commit with two parents is `main` merged into the branch.
      mainMerges: pull.commits.filter((commit) => commit.parents >= 2).length,
    },
    start: { at: iso(startMs), from: record.start === null ? 'first-commit' : 'session-record' },
    recorded: record.present,
    notRecorded: record.notRecorded,
    // Time from the session's start to the first push. Zero, never negative, where
    // the first commit is dated after the first push (a rebase or a clock).
    beforeFirstPushMs,
    balance,
    rounds,
    runnerMs: runner.ms,
    cancelled: runner.cancelled,
    fixingMs: fixing,
    awayMs: away,
    waitingToMergeMs: waitingToMerge,
    totalMs: Math.max(0, mergedAt - startMs),
    flukes: rounds.flatMap((round) => round.flukes),
    localReviews: record.localReviews,
    // Each local review cut to the gaps it sat in, in the order they ran: what the strip
    // draws and the harness counts. `gap` is 0 before the first push and n after round n.
    reviewSlices,
    // The same for the test runs and the browser pass, which can sit inside a review's time.
    runSlices,
    // What the record marked of each, as `localReviews` is: `null` for a kind it has none of.
    localRuns: record.localRuns,
    // The local time split by kind with each minute counted once, adding up to the local time; `null` where
    // that time is (no session record, or no round to weigh it against), never zero.
    localParts: balance ? localPartsOf([...reviewSlices, ...runSlices]) : null,
    // What each kind of check held this pull request's own rounds up for, the same
    // shape a window's `harness` is in — so the evolution chart can plot one pull
    // request's kinds the same way it reads a window's. `local` is the local review
    // that the scatter adds to the same rounds, per kind; `null` where none was marked,
    // which is not recorded and not zero.
    harness: { ...harnessOf(rounds), local: localOf(record, reviewSlices, runSlices) },
    notes,
  };
}

/**
 * Local time that counts towards the harness, per kind: each review kind, then test runs and the browser pass. A kind the
 * record has nothing of is `null`, which is not recorded and not zero; `null` altogether where no kind has anything.
 * A lane is a kind's own minutes, so two lanes can share minutes that the harness total counts once.
 */
function localOf(record, reviewSlices, runSlices) {
  if (!record.present) return null;
  const lanes = {};
  for (const kind of LOCAL_REVIEW_KINDS) {
    const own = reviewSlices.filter((slice) => slice.kind === kind);
    lanes[kind] = record.localReviews ? { ms: sum(own.map((slice) => slice.ms)), runs: own.length } : null;
  }
  for (const kind of LOCAL_RUN_KINDS) {
    const own = runSlices.filter((slice) => slice.kind === kind);
    lanes[kind] = record.localRuns[kind] ? { ms: sum(own.map((slice) => slice.ms)), runs: own.length } : null;
  }
  return Object.values(lanes).every((lane) => lane === null) ? null : lanes;
}

/** Minutes held, runs and rounds finished last, for each kind of check — every kind present, so a kind that held nothing reads as a zero it earned. */
function harnessOf(rounds) {
  const kinds = Object.fromEntries(CHECK_KINDS.map((kind) => [kind, { ms: 0, runs: 0, last: 0 }]));
  for (const round of rounds) {
    for (const held of round.held) {
      kinds.checks.ms += held.ms;
      kinds.checks.runs += 1;
    }
    if (round.last !== null) kinds.checks.last += 1;
  }
  return { rounds: rounds.length, kinds };
}

/**
 * Each step and each test file that failed an attempt in these rounds, with the
 * pull requests it failed on and how many attempts it failed there — a spec
 * failing twice on one pull request is one pull request and two attempts. Always
 * lists, never `null`: no failure is an empty list. `notRecorded` counts the
 * failed attempts whose detail could not be read, wholly or for some package, and `noFileFailed` those whose record was read and names no failed file.
 */
function failuresOfWindow(inWindow) {
  const entries = inWindow.flatMap((pull) => pull.rounds.flatMap((round) => round.failures.map((failure) => ({ pull: pull.number, failure }))));

  const tally = (keyed) => {
    const groups = new Map();
    for (const { key, pull, ...rest } of keyed) {
      if (!groups.has(key)) groups.set(key, { ...rest, pulls: new Map() });
      const group = groups.get(key);
      group.pulls.set(pull, (group.pulls.get(pull) ?? 0) + 1);
    }
    return [...groups.values()]
      .map(({ pulls, ...rest }) => ({
        ...rest,
        attempts: sum([...pulls.values()]),
        pulls: [...pulls].map(([number, attempts]) => ({ number, attempts })).sort((a, b) => a.number - b.number),
      }))
      .sort((a, b) => b.pulls.length - a.pulls.length || b.attempts - a.attempts || (a.check ?? '').localeCompare(b.check ?? '') || (a.step ?? a.path).localeCompare(b.step ?? b.path));
  };

  return {
    attempts: entries.length,
    notRecorded: entries.filter(({ failure }) => failure.record === 'not-recorded' || failure.packagesNotRecorded.length > 0 || failure.why === 'unreadable').length,
    noFileFailed: entries.filter(({ failure }) => failure.why === 'no-file-failed').length,
    steps: tally(entries.flatMap(({ pull, failure }) => failure.steps.map((step) => ({ key: `${failure.check}\n${step}`, pull, check: failure.check, step })))),
    files: tally(entries.flatMap(({ pull, failure }) => failure.files.map((path) => ({ key: path, pull, path })))),
  };
}

/**
 * Per check, the median and p95 of the time its jobs waited for a runner, with the rounds
 * and pull requests behind it. `null` where no job list was read, which is not zero.
 */
function queueOfWindow(rounds) {
  const byCheck = new Map();
  for (const { pull, round } of rounds) {
    for (const { name, ms } of round.queued) {
      if (!byCheck.has(name)) byCheck.set(name, []);
      byCheck.get(name).push({ pull, value: ms });
    }
  }
  if (byCheck.size === 0) return null;
  return Object.fromEntries([...byCheck].sort(([a], [b]) => a.localeCompare(b)).map(([name, entries]) => [name, figure(entries)]));
}

/**
 * Runner minutes cancelled, split into those a newer push superseded and the rest, against
 * every runner minute in the window. A share of runner time, not of round time: a round is
 * wall clock and does not divide against minutes of several runners. `null` share where no
 * runner time was recorded.
 */
function cancelledOfWindow(inWindow) {
  const sumOf = (kind) => ({ runs: sum(inWindow.map((pull) => pull.cancelled[kind].runs)), ms: sum(inWindow.map((pull) => pull.cancelled[kind].ms)) });
  const superseded = sumOf('superseded');
  const other = sumOf('other');
  const runnerMs = sum(inWindow.map((pull) => pull.runnerMs));
  return {
    superseded,
    other,
    runnerMs,
    share: runnerMs > 0 ? (superseded.ms + other.ms) / runnerMs : null,
    supersededShare: runnerMs > 0 ? superseded.ms / runnerMs : null,
  };
}

/** One window's picture: the pull requests merged in it, and every part's median and p95. */
function windowModel(pulls, { days, now, coveredSince }) {
  const since = now.getTime() - days * DAY_MS;
  // A feature branch landing is shown but is in no figure: its units are already counted.
  const inWindow = pulls.filter((pull) => {
    const merged = time(pull.mergedAt);
    return !pull.landing && merged >= since && merged <= now.getTime();
  });

  const rounds = inWindow.flatMap((pull) => pull.rounds.map((round) => ({ pull: pull.number, value: round.ms, round })));
  const each = (pick) => inWindow.flatMap((pull) => pick(pull).map((value) => ({ pull: pull.number, value })));
  const withRecord = inWindow.filter((pull) => pull.recorded);
  const reviewed = inWindow.filter((pull) => pull.localReviews);
  const ranIn = (kind) => inWindow.filter((pull) => pull.localRuns[kind]);
  const placed = inWindow.filter((pull) => pull.balance);

  // A window is partial when the fetch did not read back to its start — a 14-day
  // column over nine days of pulls is a nine-day column, and saying otherwise
  // would make a stopped fetch look like a quiet fortnight.
  const partial = coveredSince.getTime() > since;

  return {
    days,
    since: iso(since),
    partial,
    actualDays: partial ? (now.getTime() - coveredSince.getTime()) / DAY_MS : days,
    pulls: { total: inWindow.length, withRecord: withRecord.length, withoutRecord: inWindow.length - withRecord.length },
    parts: {
      total: figure(inWindow.map((pull) => ({ pull: pull.number, value: pull.totalMs }))),
      beforeFirstPush: figure(inWindow.filter((pull) => pull.beforeFirstPushMs !== null).map((pull) => ({ pull: pull.number, value: pull.beforeFirstPushMs }))),
      round: figure(rounds),
      fixing: figure(each((pull) => pull.fixingMs)),
      waitingToMerge: figure(inWindow.filter((pull) => pull.waitingToMergeMs !== null).map((pull) => ({ pull: pull.number, value: pull.waitingToMergeMs }))),
      away: figure(each((pull) => pull.awayMs)),
    },
    // The scatter's dots, each with its lines changed (the Evolution size lane's figure), and the median of their ratios. A dot with no coding time
    // has no ratio, so it is placed but not in the median. `noChecks` are the ones
    // with a record that no check ran on, left off because they have no harness time.
    balance: {
      dots: placed.map((pull) => ({ number: pull.number, title: pull.title, url: pull.url, ...pull.balance, lines: pull.size.additions + pull.size.deletions })),
      ratio: figure(placed.filter((pull) => pull.balance.ratio !== null).map((pull) => ({ pull: pull.number, value: pull.balance.ratio }))),
      noChecks: withRecord.length - placed.length,
    },
    // Only over the pull requests that have a record, which is why the window says
    // how many do not. `ms` is each pull request's review wall clock, shared minutes once; `byKind` splits it
    // per kind, over the pull requests that ran that kind. What counts towards the
    // harness is the part inside the gaps (`pull.harness.local`), which can be less.
    localReviews: {
      count: figure(reviewed.map((pull) => ({ pull: pull.number, value: pull.localReviews.count }))),
      ms: figure(reviewed.map((pull) => ({ pull: pull.number, value: pull.localReviews.ms }))),
      byKind: Object.fromEntries(
        LOCAL_REVIEW_KINDS.map((kind) => [
          kind,
          figure(reviewed.filter((pull) => pull.localReviews.byKind[kind]).map((pull) => ({ pull: pull.number, value: pull.localReviews.byKind[kind].ms }))),
        ]),
      ),
    },
    // The test runs and the browser pass, per kind and over the pull requests whose record has that kind: `null` figures where none does.
    localRuns: Object.fromEntries(
      LOCAL_RUN_KINDS.map((kind) => [
        kind,
        {
          count: figure(ranIn(kind).map((pull) => ({ pull: pull.number, value: pull.localRuns[kind].count }))),
          ms: figure(ranIn(kind).map((pull) => ({ pull: pull.number, value: pull.localRuns[kind].ms }))),
        },
      ]),
    ),
    rounds: inWindow.length
      ? {
          count: rounds.length,
          red: rounds.filter((entry) => entry.round.red).length,
          overTenMinutes: rounds.filter((entry) => entry.value > LONG_ROUND_MS).length,
          queueNotRecorded: rounds.filter((entry) => entry.round.queueNotRecorded).length,
          // A pull request no check ever ran on has no round, so it is left out of
          // the rounds it took rather than counted as taking none.
          perPull: figure(inWindow.filter((pull) => pull.rounds.length > 0).map((pull) => ({ pull: pull.number, value: pull.rounds.length }))),
        }
      : null,
    // What each kind of check held a round up for: its time, the runs that made it,
    // and how many rounds it was the last to finish.
    // Null too where pull requests merged but no check ever ran on any of them: no
    // rounds is no data about what held them, not a harness that held nothing.
    harness: rounds.length ? harnessOf(rounds.map((entry) => entry.round)) : null,
    queue: queueOfWindow(rounds),
    cancelled: inWindow.length ? cancelledOfWindow(inWindow) : null,
    failures: failuresOfWindow(inWindow),
    flukes: rounds.length
      ? {
          count: sum(inWindow.map((pull) => pull.flukes.length)),
          pulls: inWindow.filter((pull) => pull.flukes.length > 0).length,
          ms: sum(inWindow.flatMap((pull) => pull.flukes.map((fluke) => fluke.ms))),
        }
      : null,
  };
}

/** The most steps or files kept for one attempt, and characters kept of each: the Monitor refuses a send past either (apps/harness-monitor/src/cycle-time.ts), and an attempt that failed every spec would otherwise hold the whole night back. */
const KEPT_ITEMS = 500;
const KEPT_CHARS = 500;
const kept = (items) => items.slice(0, KEPT_ITEMS).map((item) => item.slice(0, KEPT_CHARS));
const cutShort = (items) => items.length > KEPT_ITEMS || items.some((item) => item.length > KEPT_CHARS);

/** One round's checks as the Harness Monitor stores them: one per attempt that ran, in the order they finished. */
function checkRows(round) {
  const rows = round.held.map((held, position) => {
    const failure = round.failures.find((candidate) => candidate.check === held.name && candidate.attempt === held.attempt) ?? null;
    return {
      name: held.name,
      attempt: held.attempt,
      heldMs: held.ms,
      last: position === round.held.length - 1,
      // Red where the check never passed on the commit, a fluke where a re-run did; null for an attempt that did not fail.
      failure: failure?.outcome ?? null,
      flukeMs: null,
      queuedMs: held.queuedMs,
      // The runner time its jobs used, every shard of a family added up and queueing left out, so a pull request's attempts add up to its `runnerMs`.
      runningMs: held.runningMs,
      // What `failures` says of the attempt's detail: it could not be read, wholly or in part, or it was read and names no failed file. Detail cut to what the Monitor takes is not wholly recorded either.
      detailNotRecorded: failure
        ? failure.record === 'not-recorded' || failure.packagesNotRecorded.length > 0 || failure.why === 'unreadable' || cutShort(failure.steps) || cutShort(failure.files)
        : false,
      noFileFailed: failure?.why === 'no-file-failed',
      failedSteps: kept(failure?.steps ?? []),
      failedFiles: kept(failure?.files ?? []),
    };
  });
  // A fluke's extra minutes sit on the first attempt of its check that failed, as `flukesOf` found it.
  for (const fluke of round.flukes) {
    const first = rows.filter((row) => row.name === fluke.name && row.failure !== null).sort((a, b) => a.attempt - b.attempt)[0];
    if (first) first.flukeMs = fluke.ms;
  }
  return rows;
}

/**
 * The merged pull requests as the Harness Monitor stores them, each cut as `pullModel` cuts it and
 * flattened to what the Monitor keeps: the time split, the rounds and each round's checks, with the
 * steps and test files that failed an attempt, and its timeline. The Monitor derives nothing from them.
 *
 * Time nobody wrote down is `null`, never zero: a pull request with no session record, or no round to
 * weigh it against, has no writing time (`codingMs`) and no local time (`localMs`), and a kind of local
 * time the record has none of is `null`. `ciMs` is zero when no check ran, which is a fact.
 *
 * @param {object} input
 * @param {import('./github.js').Pull[]} input.pulls
 * @param {string} [input.trunk]
 */
export function monitorRows({ pulls, trunk = 'main' }) {
  return pulls
    .filter((pull) => time(pull.mergedAt) !== null)
    .map((pull) => pullModel(pull, trunk))
    .map((pull) => {
      const ciMs = sum(pull.rounds.map((round) => round.ms));
      return {
        number: pull.number,
        title: pull.title,
        url: pull.url,
        mergedAt: pull.mergedAt,
        base: pull.base,
        head: pull.head,
        landing: pull.landing,
        size: pull.size,
        start: pull.start,
        recorded: pull.recorded,
        codingMs: pull.balance ? pull.balance.codingMs : null,
        localMs: pull.balance ? pull.balance.harnessMs - ciMs : null,
        ciMs,
        waitingToMergeMs: pull.waitingToMergeMs,
        awayMs: sum(pull.awayMs),
        totalMs: pull.totalMs,
        // `byKind` is each review kind's own count and minutes, zero for a kind the record marked none of; the Monitor keeps them beside the combined figure.
        localReviews: pull.localReviews
          ? {
              count: pull.localReviews.count,
              ms: pull.localReviews.ms,
              byKind: Object.fromEntries(LOCAL_REVIEW_KINDS.map((kind) => [kind, { count: pull.localReviews.byKind[kind]?.count ?? 0, ms: pull.localReviews.byKind[kind]?.ms ?? 0 }])),
            }
          : null,
        localRuns: { test: pull.localRuns.test, browser: pull.localRuns.browser },
        // `localMs` split by kind, each minute counted once, so the four add up to it; `null` where `localMs` is.
        localParts: pull.localParts,
        runnerMs: pull.runnerMs,
        cancelled: pull.cancelled,
        rounds: pull.rounds.map((round) => ({
          sha: round.sha,
          pushedAt: round.pushedAt,
          endedAt: round.endedAt,
          ms: round.ms,
          red: round.red,
          commits: round.commits,
          queueNotRecorded: round.queueNotRecorded,
          checks: checkRows(round),
        })),
        timeline: timelineOf(pull),
      };
    });
}

/**
 * What a pull request's strip needs that its row, rounds and checks do not hold, as the Monitor
 * stores it beside them: each round's job lanes in round order, `null` for a round whose job list was
 * not read (or where no job drew a lane), and the local review and run slices, none without a session record.
 */
function timelineOf(pull) {
  // A hand-edited record can leave a review's level word empty (`code-review :2`), which the Monitor refuses as a level: it is sent as no level, so one body never holds up a send.
  const reviewSlices = pull.reviewSlices.map(({ level, ...slice }) => (level ? { ...slice, level } : slice));
  return { lanes: pull.rounds.map((round) => round.lanes), reviewSlices, runSlices: pull.runSlices };
}

/**
 * Each merged pull request's timeline alone, as the backfill sends it beside pull requests the Monitor
 * already holds, cut exactly as `monitorRows` cuts it.
 *
 * @param {object} input
 * @param {import('./github.js').Pull[]} input.pulls
 * @param {string} [input.trunk]
 */
export function monitorTimelines({ pulls, trunk = 'main' }) {
  return monitorRows({ pulls, trunk }).map((row) => ({ number: row.number, timeline: row.timeline }));
}

/**
 * @param {object} input
 * @param {import('./github.js').Pull[]} input.pulls
 * @param {{ number: number, reason: string }[]} [input.failed] pulls that could not be read
 * @param {Date} input.now
 * @param {number} input.requestedDays how far back the fetch was asked to go
 * @param {Date} input.coveredSince how far back the listing was actually read
 * @param {boolean} [input.truncated] whether the pull budget stopped the fetch short
 * @param {number[]} [input.windows] the windows to report, in days
 */
export function buildModel({
  pulls,
  failed = [],
  now,
  requestedDays,
  coveredSince,
  truncated = false,
  repo,
  branch = 'main',
  commit = null,
  windows = [7, 14],
}) {
  // A pull closed without merging has no cycle time to give.
  const merged = pulls.filter((pull) => time(pull.mergedAt) !== null).map((pull) => pullModel(pull, branch)).sort((a, b) => time(b.mergedAt) - time(a.mergedAt));
  const requestedSince = now.getTime() - requestedDays * DAY_MS;

  return {
    repo,
    branch,
    commit,
    generatedAt: now.toISOString(),
    coverage: {
      requestedDays,
      since: iso(requestedSince),
      until: now.toISOString(),
      coveredSince: coveredSince.toISOString(),
      actualDays: Math.min(requestedDays, (now.getTime() - coveredSince.getTime()) / DAY_MS),
      partial: coveredSince.getTime() > requestedSince,
      truncated,
      pulls: merged.length,
      failed,
    },
    windows: windows.map((days) => windowModel(merged, { days, now, coveredSince })),
    pulls: merged,
  };
}
