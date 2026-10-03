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

import { PHASES, readBlock } from '../../../scripts/lib/session-record.mjs';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** A gap longer than this is somebody away, not somebody fixing or a check waiting to be looked at. */
export const AWAY_MS = 3 * HOUR_MS;

/**
 * The checks that are a review, by the name their job reports. A round in which
 * one ran is a *ready* round: the pull request was marked ready, since a draft
 * skips both. Named here rather than read from the workflows because they no
 * longer exist — they were removed in "Remove the remote code and security
 * reviews" (pull request 512), and history before it still carries them.
 */
export const REVIEW_CHECKS = { 'code-review': 'claude-review', 'security-review': 'Security review' };

/** A round that took longer than this is one somebody was kept waiting on. */
export const LONG_ROUND_MS = 10 * 60_000;

/**
 * What kind of check a name is: one of the two reviews, or everything else, which
 * is the tests and the mechanical checks. The page groups by this rather than by
 * name, because job names come and go and the question is who held the round.
 */
export const CHECK_KINDS = ['checks', ...Object.keys(REVIEW_CHECKS)];

export function kindOf(name) {
  return Object.entries(REVIEW_CHECKS).find(([, reviewName]) => reviewName === name)?.[0] ?? 'checks';
}

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
 * artifact each uploads. Every other check names the step that failed and no files.
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

/**
 * A re-run copies the jobs that passed, and a copy is created after the start it carries.
 * Only known where the job list was read.
 */
const isCopy = (attempt) => {
  if (attempt.queue?.state !== 'read') return false;
  const created = time(attempt.queue.createdAt);
  const started = time(attempt.startedAt);
  return created !== null && started !== null && started < created;
};

/**
 * How long a job waited for a runner: its creation to its start. A job that waits on `needs:`
 * is created only when its dependency finishes, so that wait is never in it. `null` where
 * there is nothing to say: no job list read, a copy, a skipped job, one that never started.
 */
function queuedMs(attempt) {
  if (attempt.queue?.state !== 'read' || isCopy(attempt) || classify(attempt) === 'skipped') return null;
  const created = time(attempt.queue.createdAt);
  const started = time(attempt.startedAt);
  return created === null || started === null ? null : started - created;
}

/** Runner time one attempt used, start to end; a copy, a skipped job and one that never started used none. */
function runnerMs(attempt) {
  const from = time(attempt.startedAt);
  const to = time(attempt.completedAt);
  if (isCopy(attempt) || classify(attempt) === 'skipped' || from === null || to === null) return 0;
  return Math.max(0, to - from);
}

/**
 * How long after a cancellation the next push may be seen and still have caused it. A push is
 * the earliest moment a check on it was seen, and the run it starts cancels the old one as it
 * is created: the cancelled job ends in the same second or a few before the new run's first
 * job is stamped.
 */
export const SUPERSEDE_SLACK_MS = 5_000;

/**
 * The runner minutes of a pull request, and those thrown away by cancelling. A cancelled
 * attempt is `superseded` when another push on the pull request arrived after its own and
 * before it ended (within `SUPERSEDE_SLACK_MS` after it), which is what `cancel-in-progress` does; any other cancellation is `other`.
 */
function runnerOf(commits, rounds) {
  const pushes = rounds.map((round) => time(round.pushedAt));
  const cancelled = { superseded: { runs: 0, ms: 0 }, other: { runs: 0, ms: 0 } };
  let total = 0;
  for (const commit of commits) {
    const own = pushTime(commit.checks);
    for (const attempt of commit.checks) {
      const ms = runnerMs(attempt);
      total += ms;
      if (classify(attempt) !== 'cancelled' || isCopy(attempt)) continue;
      const ended = time(attempt.completedAt);
      const from = own ?? time(attempt.startedAt);
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
    const groups = attemptsByCheck(commit.checks);
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
      return { name: attempt.name, ms, ...(rerun ? { rerun: true } : {}) };
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
    const reviewNames = Object.values(REVIEW_CHECKS);

    return {
      sha: push.commit.sha,
      pushedAt: iso(push.at),
      endedAt: iso(previous),
      ms: previous - push.at,
      kind: push.ran.flat().some((attempt) => reviewNames.includes(attempt.name)) ? 'ready' : 'draft',
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
  let entries;
  try {
    entries = readBlock(body ?? '');
  } catch (error) {
    return { present: false, start: null, notRecorded: [], localReviews: null, notes: [`The session record could not be read: ${error.message}`] };
  }
  if (entries.length === 0) return { present: false, start: null, notRecorded: [], localReviews: null, notes: [] };

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
  // say nothing about how long a review took.
  const open = new Map();
  const reviews = [];
  for (const mark of marks) {
    if (mark.phase === 'review-start') open.set(mark.kind, mark);
    else if (mark.phase === 'review-end' && open.has(mark.kind)) {
      const begun = open.get(mark.kind);
      open.delete(mark.kind);
      if (mark.ms >= begun.ms) reviews.push({ kind: mark.kind, level: mark.level, ms: mark.ms - begun.ms });
    }
  }

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
    localReviews: reviews.length ? { count: reviews.length, ms: sum(reviews.map((review) => review.ms)), byKind } : null,
    notes,
  };
}

/**
 * One merged pull request, cut into the parts it spent.
 *
 * @param {import('./github.js').Pull} pull
 */
export function pullModel(pull) {
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

  // Coding against the harness: where a person was writing, against where the harness
  // was being waited on. Only a pull request with a record can say — without one,
  // its local reviews are not there to move out of the coding — and one no check ran
  // on has no round to weigh. Local review sits inside the time before the first push
  // and between pushes, so it is taken out of the coding and put with the harness.
  // Waiting to merge is neither: nobody was writing, and no check was running.
  let balance = null;
  if (record.present && rounds.length > 0) {
    const writingMs = beforeFirstPushMs + sum(fixing);
    // A review can only come out of the time it sat in: one marked longer than that
    // (it ran beside a round, or through a night) would otherwise be moved in full to
    // the harness and taken from a coding that never held it.
    const reviewMs = Math.min(record.localReviews?.ms ?? 0, writingMs);
    const codingMs = writingMs - reviewMs;
    const harnessMs = sum(rounds.map((round) => round.ms)) + reviewMs;
    balance = { codingMs, harnessMs, rounds: rounds.length, ratio: codingMs > 0 ? harnessMs / codingMs : null };
  }

  return {
    number: pull.number,
    title: pull.title,
    url: pull.url,
    mergedAt: pull.mergedAt,
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
    // What each kind of check held this pull request's own rounds up for, the same
    // shape a window's `harness` is in — so the evolution chart can plot one pull
    // request's kinds the same way it reads a window's.
    harness: harnessOf(rounds),
    notes,
  };
}

/** Minutes held, runs and rounds finished last, for each kind of check — every kind present, so a kind that held nothing reads as a zero it earned. */
function harnessOf(rounds) {
  const kinds = Object.fromEntries(CHECK_KINDS.map((kind) => [kind, { ms: 0, runs: 0, last: 0 }]));
  for (const round of rounds) {
    for (const held of round.held) {
      const kind = kindOf(held.name);
      kinds[kind].ms += held.ms;
      kinds[kind].runs += 1;
    }
    if (round.last !== null) kinds[kindOf(round.last)].last += 1;
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
  const inWindow = pulls.filter((pull) => {
    const merged = time(pull.mergedAt);
    return merged >= since && merged <= now.getTime();
  });

  const rounds = inWindow.flatMap((pull) => pull.rounds.map((round) => ({ pull: pull.number, value: round.ms, round })));
  const each = (pick) => inWindow.flatMap((pull) => pick(pull).map((value) => ({ pull: pull.number, value })));
  const withRecord = inWindow.filter((pull) => pull.recorded);
  const reviewed = inWindow.filter((pull) => pull.localReviews);
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
      draftRound: figure(rounds.filter((entry) => entry.round.kind === 'draft')),
      readyRound: figure(rounds.filter((entry) => entry.round.kind === 'ready')),
      fixing: figure(each((pull) => pull.fixingMs)),
      waitingToMerge: figure(inWindow.filter((pull) => pull.waitingToMergeMs !== null).map((pull) => ({ pull: pull.number, value: pull.waitingToMergeMs }))),
      away: figure(each((pull) => pull.awayMs)),
    },
    // The scatter's dots, and the median of their ratios. A dot with no coding time
    // has no ratio, so it is placed but not in the median. `noChecks` are the ones
    // with a record that no check ran on, left off because they have no harness time.
    balance: {
      dots: placed.map((pull) => ({ number: pull.number, title: pull.title, url: pull.url, ...pull.balance })),
      ratio: figure(placed.filter((pull) => pull.balance.ratio !== null).map((pull) => ({ pull: pull.number, value: pull.balance.ratio }))),
      noChecks: withRecord.length - placed.length,
    },
    // Only over the pull requests that have a record, which is why the window says
    // how many do not.
    localReviews: {
      count: figure(reviewed.map((pull) => ({ pull: pull.number, value: pull.localReviews.count }))),
      ms: figure(reviewed.map((pull) => ({ pull: pull.number, value: pull.localReviews.ms }))),
    },
    rounds: inWindow.length
      ? {
          count: rounds.length,
          red: rounds.filter((entry) => entry.round.red).length,
          ready: rounds.filter((entry) => entry.round.kind === 'ready').length,
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
  // A pull closed without merging has no lead time to give.
  const merged = pulls.filter((pull) => time(pull.mergedAt) !== null).map(pullModel).sort((a, b) => time(b.mergedAt) - time(a.mergedAt));
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
