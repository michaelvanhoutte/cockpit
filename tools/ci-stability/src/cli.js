/**
 * The wiring, and the only place github.js and render/ meet.
 *
 *   collect(repo) -> buildModel(...) -> renderHtml(Model) -> a file
 *                 -> monitorRows(...) -> sendRuns(...)  -> the Harness Monitor, with --send
 *                 -> collectAttempts(...) -> attemptRows(...) -> sendAttempts(...)  -> likewise
 *
 * `--branches --send` is the nightly send of every other branch's attempts: no page, no run, and
 * a day at a time (sendBranches). `backfill.js` runs both over a window with `--old-failures`.
 *
 * `--json` stops after the second arrow, so anything else can consume the
 * model. `--send` reads once for both, back to whichever window starts earlier,
 * and sends after the page is written, so a Monitor that refuses costs the send
 * and never the page. Nothing is written until every request has come back: a page of
 * partial numbers looks exactly like a page of real ones, so a failed fetch
 * leaves the previous report in place rather than replacing it with a
 * plausible lie.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collect, collectAttempts, dayChunks, GitHubError, listBranchRuns } from './github.js';
import { attemptRows, buildModel, monitorRows } from './model.js';
import { MonitorError, newestStored, newestStoredAttempt, sendAttempts, sendRuns, sendWindow } from './monitor.js';
import { renderHtml } from './render/html.js';
import { workspacePackages } from './workspace.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

const USAGE = `Usage: node src/cli.js [options]

  --out <path>        where to write (default ../out/index.html, or model.json with --json)
  --json              write the model instead of the page
  --model <path>      also write the model, as --json would, to this path
  --days <n>          how far back to read (default 30)
  --windows <a,b>     the windows to report, in days (default 7,30)
  --max-runs <n>      stop after this many runs, and report the shorter window (default 800)
  --repo <owner/name> default: $GITHUB_REPOSITORY, else this checkout's origin
  --branch <name>     default: main
  --send              also send the runs, and every attempt of them with its failed tests, to the
                      Harness Monitor at $HARNESS_MONITOR_URL with $HARNESS_WRITE_KEY: those from
                      its newest stored run (or attempt) less two days, or the --days window when
                      it holds none
  --from <YYYY-MM-DD> with --send, send the runs of this window instead and write nothing (the backfill)
  --to <YYYY-MM-DD>   the window's last day, inclusive (default today)
  --branches          with --send, send every attempt of every run on a branch other than main's (a
                      pull request's run, or a push to another branch) instead, from the newest such
                      attempt the Monitor holds less two days, a day at a time, oldest first; writes
                      no page and sends no run. --max-runs stops it after the day that reaches it
  --old-failures      with --send, read a failed job's tests from its annotations or its log where it
                      kept no record of them (the backfill's; \`pnpm stability:backfill\` sends with it)
  --help
`;

/** Quiet on failure: a missing git or a missing remote is not an error here, just no answer. */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function repoFromGitRemote() {
  const url = git(['config', '--get', 'remote.origin.url']);
  const match = url?.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return match ? match[1] : null;
}

/**
 * A token is optional against a public repository, but 60 requests an hour is
 * not enough for a full window, so an unauthenticated run will usually stop at
 * the rate limit and say so. `gh` is asked last, which is what makes a local
 * run work without any setup.
 */
function resolveToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || gh(['auth', 'token']) || undefined;
}

/** The same, for `gh`, which a developer machine has and a runner does not need. */
function gh(args) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * A count, or a recorded complaint.
 *
 * `Number('8OO')` is NaN, and every comparison against NaN is false — so an
 * unchecked `--max-runs` typo does not shrink the budget, it removes it, and
 * the fetch walks the whole run history against an allowance the rest of the
 * repository's workflows share. `--days` fails the same way, through an Invalid
 * Date no run is ever older than. Both mistakes fail towards fetching
 * everything, which is why they are refused rather than defaulted.
 */
export function positive(raw, name, args) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    args.invalid ??= `${name} needs a positive number, not ${JSON.stringify(raw ?? null)}`;
    return undefined;
  }
  return value;
}

/** A UTC day as a Date at its start, or a recorded complaint. */
export function day(raw, name, args) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw ?? '') ? new Date(`${raw}T00:00:00Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    args.invalid ??= `${name} needs a day as YYYY-MM-DD, not ${JSON.stringify(raw ?? null)}`;
    return undefined;
  }
  return date;
}

export function parseArgs(argv) {
  const args = { windows: [7, 30] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--send') args.send = true;
    else if (arg === '--branches') args.branches = true;
    else if (arg === '--old-failures') args.oldFailures = true;
    else if (arg === '--from') args.from = day(value(), '--from', args);
    // The last day is inclusive, so the window ends at the start of the day after it.
    else if (arg === '--to') {
      const last = day(value(), '--to', args);
      if (last) args.to = new Date(last.getTime() + DAY_MS);
    }
    else if (arg === '--out') args.out = value();
    else if (arg === '--model') {
      const modelValue = value();
      if (!modelValue) {
        args.invalid ??= '--model needs a path';
      } else {
        args.model = modelValue;
      }
    }
    else if (arg === '--days') args.days = positive(value(), '--days', args);
    else if (arg === '--max-runs') args.maxRuns = positive(value(), '--max-runs', args);
    else if (arg === '--repo') args.repo = value();
    else if (arg === '--branch') args.branch = value();
    // `?? ''` because a trailing `--windows` with nothing after it would
    // otherwise throw a TypeError out of parseArgs, which main calls outside any
    // catch: a stack trace and exit 1, where every other bad argument gets the
    // usage message and exit 2.
    else if (arg === '--windows')
      args.windows = (value() ?? '')
        .split(',')
        .map((each) => positive(each, '--windows', args));
    // The first one, not the last: a misspelled flag leaves its value looking
    // like an argument too, and naming that instead sends the reader after the
    // wrong word.
    else args.unknown ??= arg;
  }
  if (args.to && !args.from) args.invalid ??= '--to needs --from';
  if (args.from && !args.send) args.invalid ??= '--from needs --send: a window given by hand is only ever sent';
  if (args.from && args.to && args.to <= args.from) args.invalid ??= '--to cannot be before --from';
  if (args.oldFailures && !args.send) args.invalid ??= '--old-failures needs --send: it only changes what is sent';
  if (args.branches && !args.send) args.invalid ??= '--branches needs --send: it writes no page, only sends';
  if (args.branches && (args.json || args.out || args.model)) args.invalid ??= '--branches writes no page or model, so --json, --out and --model do not apply';
  return args;
}

/**
 * What is written and its default name: the page, or with `--json` the model.
 */
export function output(args, model) {
  return args.json
    ? { file: 'model.json', content: modelJson(model) }
    : { file: 'index.html', content: renderHtml(model) };
}

/** The model as JSON, the same as output() returns for --json. */
function modelJson(model) {
  return JSON.stringify(model, null, 2);
}

/** The default output path for the page or --json model. */
function defaultOut(args) {
  const file = args.json ? 'model.json' : 'index.html';
  return path.join(here, '../out', file);
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.unknown) {
    process.stderr.write(`unknown argument: ${args.unknown}\n\n${USAGE}`);
    return 2;
  }
  if (args.invalid) {
    process.stderr.write(`${args.invalid}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.model) {
    const effectiveOut = args.out ?? defaultOut(args);
    if (path.resolve(args.model) === path.resolve(effectiveOut)) {
      process.stderr.write(`--model and --out cannot be the same path\n\n${USAGE}`);
      return 2;
    }
  }

  const repo = args.repo ?? process.env.GITHUB_REPOSITORY ?? repoFromGitRemote();
  if (!repo) {
    process.stderr.write('Could not tell which repository to read; pass --repo owner/name.\n');
    return 2;
  }

  const monitor = args.send ? { url: process.env.HARNESS_MONITOR_URL, key: process.env.HARNESS_WRITE_KEY } : null;
  if (monitor && (!monitor.url || !monitor.key)) {
    process.stderr.write('--send needs HARNESS_MONITOR_URL and HARNESS_WRITE_KEY set (docs/deployment.md, "The Harness Monitor").\n');
    return 2;
  }

  const branch = args.branch ?? 'main';
  const days = args.days ?? 30;
  const now = new Date();
  const pageSince = new Date(now.getTime() - days * DAY_MS);
  const backfill = Boolean(args.from);
  if (args.branches) return sendBranches({ args, monitor, repo, trunk: branch, days, now, backfill });

  // A Monitor that cannot say where to start costs the send, never the page. The attempts start
  // from their own newest, and a Monitor that cannot say costs only them: the runs still go.
  let window = null;
  let unsent = null;
  let attemptWindow = null;
  let attemptsUnsent = null;
  if (monitor) {
    const given = { from: args.from, to: args.to ?? (backfill ? now : null) };
    try {
      const newest = backfill ? null : await newestStored({ url: monitor.url });
      window = sendWindow({ newest, now, days, ...given });
    } catch (error) {
      if (!(error instanceof MonitorError)) throw error;
      unsent = error;
    }
    if (window) {
      try {
        const newest = backfill ? null : await newestStoredAttempt({ url: monitor.url });
        attemptWindow = sendWindow({ newest, now, days, ...given });
      } catch (error) {
        if (!(error instanceof MonitorError)) throw error;
        attemptsUnsent = error;
      }
    }
  }

  let collected;
  try {
    // One read serves the page and the send: back to whichever starts earlier.
    collected = await collect({
      repo,
      branch,
      since: backfill ? window.since : new Date(Math.min(pageSince, window?.since ?? pageSince, attemptWindow?.since ?? pageSince)),
      until: backfill ? window.until : null,
      maxRuns: args.maxRuns ?? 800,
      token: resolveToken(),
    });
  } catch (error) {
    if (error instanceof GitHubError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  if (!backfill) {
    const written = writeReport(args, collected, { now, days, pageSince, repo, branch });
    process.stderr.write(
      `wrote ${written.join(', ')} — ${collected.runs.length} runs, ${collected.requests + 1} requests\n`,
    );
  }
  if (unsent) {
    process.stderr.write(`${unsent.message}\nNothing was sent; the next send's window reaches back for it.\n`);
    return 1;
  }
  if (!monitor) return 0;
  const runsCode = await send(monitor, collected, window, { backfill });
  const attemptsCode = await sendEveryAttempt({ monitor, collected, window: attemptWindow, unsent: attemptsUnsent, repo, trunk: branch, backfill, oldFailures: args.oldFailures });
  return runsCode || attemptsCode;
}

/**
 * Sends the runs inside the send's window, oldest first, so a send that stops
 * partway leaves the Monitor's newest run where the next send's overlap picks
 * the rest up. A read the run budget stopped inside that window fails, naming
 * the backfill that sends the runs before it: the next send starts from the
 * newest stored run, after the gap, so no overlap ever reaches back into it.
 */
async function send(monitor, collected, window, { backfill }) {
  // listRuns reads newest first.
  const runs = collected.runs.filter((run) => new Date(run.createdAt) >= window.since);
  const { cut, gap } = gapOf(collected, runs, window, { backfill });
  const ids = new Set(runs.map((run) => run.id));
  let result;
  try {
    result = await sendRuns({
      url: monitor.url,
      key: monitor.key,
      runs: monitorRows({ runs: runs.toReversed(), jobs: collected.jobs.filter((job) => ids.has(job.runId)) }),
    });
  } catch (error) {
    if (!(error instanceof MonitorError)) throw error;
    process.stderr.write(`${error.message}\n${gap}`);
    return 1;
  }
  process.stderr.write(
    `sent ${result.runs} runs from ${window.since.toISOString()} to the Harness Monitor in ${result.batches} batch${result.batches === 1 ? '' : 'es'}\n${gap}`,
  );
  return cut ? 1 : 0;
}

/**
 * Whether the read stopped inside the send's window, and the sentence naming the backfill that
 * sends what it left unread. A read that went on past the window's start read all of it,
 * whatever stopped it after.
 */
function gapOf(collected, runs, window, { backfill }) {
  const cut = collected.truncated && runs.length === collected.runs.length;
  const oldest = runs.at(-1)?.createdAt ?? '';
  const gap = cut
    ? `The run budget (--max-runs), or the 1,000 runs GitHub lists at most, stopped the read at ${oldest}; the runs before it were not sent. Send them with ${backfill ? '' : `the Stability backfill, --from ${window.since.toISOString().slice(0, 10)} `}--to ${oldest.slice(0, 10)}.\n`
    : '';
  return { cut, gap };
}

/** What a stop before any attempt went leaves: a window given by hand has no next send to reach back for them. */
const attemptsLeft = (backfill) => (backfill ? 'No attempt of this window was sent; send it again.' : "No attempt was sent; the next send's window reaches back for them.");

/**
 * Sends every attempt of the runs inside the attempts' window, oldest first, like the runs: a send
 * that stops partway leaves the Monitor's newest attempt where the next send's overlap picks up
 * the rest. Reading them costs a request per re-run and per failed job's record, so a spent
 * allowance or an unreachable Monitor costs these alone: the runs were sent before.
 */
async function sendEveryAttempt({ monitor, collected, window, unsent, repo, trunk, backfill, oldFailures }) {
  if (unsent) {
    process.stderr.write(`${unsent.message}\n${attemptsLeft(backfill)}\n`);
    return 1;
  }
  if (!window) return 0;
  const inWindow = (run) => new Date(run.createdAt) >= window.since;
  const { cut, gap } = gapOf(collected, collected.runs.filter(inWindow), window, { backfill });
  let attempts;
  try {
    const entries = await collectAttempts({ repo, runs: [...collected.runs, ...collected.dependabot], jobs: collected.jobs, since: window.since, oldFailures, packages: oldFailures ? workspacePackages() : [], token: resolveToken() });
    attempts = attemptRows(entries, { trunk }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    process.stderr.write(`${error.message}\n${attemptsLeft(backfill)}\n`);
    return 1;
  }
  let result;
  try {
    result = await sendAttempts({ url: monitor.url, key: monitor.key, attempts });
  } catch (error) {
    if (!(error instanceof MonitorError)) throw error;
    process.stderr.write(`${error.message}\n${gap}`);
    return 1;
  }
  process.stderr.write(
    `sent ${result.attempts} attempts from ${window.since.toISOString()} to the Harness Monitor in ${result.batches} batch${result.batches === 1 ? '' : 'es'}\n${gap}`,
  );
  return cut ? 1 : 0;
}

/**
 * Sends every attempt of every run on a branch other than the trunk's, from the newest such attempt
 * the Monitor holds less two days (`on=branches`, so `main`'s send never moves it), one day at a
 * time and oldest first: list the day, read its attempts, send them. A day sent stays stored
 * whatever stops the next, and a send cut short by the run budget or GitHub leaves the Monitor's
 * newest where the next night's overlap carries on. An attempt started after its run's day (a
 * re-run) is held to the end, so the newest never passes a day not yet sent; a stop leaves it unsent.
 * A branch's attempt keeps its failed jobs alone, so only a failed attempt's jobs are read (a
 * re-run's earlier attempts are read for their verdict).
 */
async function sendBranches({ args, monitor, repo, trunk, days, now, backfill }) {
  let window;
  try {
    const newest = backfill ? null : await newestStoredAttempt({ url: monitor.url, on: 'branches' });
    window = sendWindow({ newest, now, days, from: args.from, to: args.to ?? (backfill ? now : null) });
  } catch (error) {
    if (!(error instanceof MonitorError)) throw error;
    process.stderr.write(`${error.message}\nNothing was sent; the next send's window reaches back for it.\n`);
    return 1;
  }

  const until = window.until ?? now;
  const token = resolveToken();
  const packages = args.oldFailures ? workspacePackages() : [];
  const counter = { requests: 0 };
  const maxRuns = args.maxRuns ?? 800;
  let sent = 0;
  let runsRead = 0;
  let capped = false;
  let stoppedAt = null;
  const deferred = [];
  const heldBack = () =>
    deferred.length > 0 ? ` ${deferred.length} re-run attempts started after their day were held back; --from ${window.since.toISOString().slice(0, 10)} sends them.` : '';

  for (const { from, to } of dayChunks(window.since, until)) {
    if (runsRead >= maxRuns) {
      stoppedAt = from;
      break;
    }
    try {
      const listed = await listBranchRuns({ repo, trunk, from, to, token, counter });
      if (listed.truncated) {
        capped = true;
        process.stderr.write(`GitHub lists at most 1,000 runs of a span, and ${from.toISOString()} to ${to.toISOString()} holds more; the attempts of some of its runs were not sent.\n`);
      }
      runsRead += listed.runs.length;
      const entries = await collectAttempts({ repo, runs: listed.runs, since: from, failedJobs: true, oldFailures: args.oldFailures, packages, token, counter });
      // A re-run's attempt carries the time it started, which can be after this day. It waits for
      // the end, so a stop part-way cannot leave the Monitor's newest past days not yet sent.
      const attempts = attemptRows(entries, { trunk }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const due = [];
      for (const attempt of attempts) (Date.parse(attempt.createdAt) < to.getTime() ? due : deferred).push(attempt);
      sent += (await sendAttempts({ url: monitor.url, key: monitor.key, attempts: due })).attempts;
    } catch (error) {
      if (!(error instanceof GitHubError || error instanceof MonitorError)) throw error;
      process.stderr.write(`${error.message}\nThe day from ${from.toISOString()} was not sent; ${sent} attempts were sent before it, and ${backfill ? `--from ${from.toISOString().slice(0, 10)} sends the rest` : 'the next send continues from the newest the Monitor holds'}.${heldBack()}\n`);
      return 1;
    }
  }

  if (!stoppedAt && deferred.length > 0) {
    try {
      deferred.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      sent += (await sendAttempts({ url: monitor.url, key: monitor.key, attempts: deferred })).attempts;
    } catch (error) {
      if (!(error instanceof MonitorError)) throw error;
      process.stderr.write(`${error.message}\nThe re-runs started after their day were not sent; ${sent} attempts were sent before them, and the next send continues from the newest the Monitor holds.\n`);
      return 1;
    }
  }

  process.stderr.write(`sent ${sent} attempts on branches from ${window.since.toISOString()} to the Harness Monitor, ${counter.requests} GitHub requests\n`);
  if (stoppedAt) {
    const rest = backfill ? `Send the rest with --from ${stoppedAt.toISOString().slice(0, 10)}.` : 'The next night continues from the newest the Monitor holds.';
    process.stderr.write(`The run budget (--max-runs ${maxRuns}) stopped the read at ${stoppedAt.toISOString()}; the attempts from there were not sent. ${rest}${heldBack()}\n`);
  }
  return stoppedAt || capped ? 1 : 0;
}

/** The page, or the model, over its own window, and the model beside it with --model. Returns the paths written. */
function writeReport(args, collected, { now, days, pageSince, repo, branch }) {
  // A send can read further back than the page shows; the page keeps to its window,
  // and a read that went on past it read all of it, whatever stopped it after.
  const runs = collected.runs.filter((run) => new Date(run.createdAt) >= pageSince);
  const pastPage = runs.length < collected.runs.length;
  const ids = new Set(runs.map((run) => run.id));
  const model = buildModel({
    runs,
    jobs: collected.jobs.filter((job) => ids.has(job.runId)),
    now,
    requestedDays: days,
    truncated: collected.truncated && !pastPage,
    reachedWindowEdge: collected.reachedWindowEdge || pastPage,
    ignored: collected.ignored,
    repo,
    branch,
    commit: process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']),
    windows: args.windows,
  });

  const { content } = output(args, model);
  const out = path.resolve(args.out ?? defaultOut(args));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, content, 'utf8');
  const writtenFiles = [out];

  if (args.model) {
    const modelOut = path.resolve(args.model);
    mkdirSync(path.dirname(modelOut), { recursive: true });
    writeFileSync(modelOut, modelJson(model), 'utf8');
    writtenFiles.push(modelOut);
  }
  return writtenFiles;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
