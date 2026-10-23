/**
 * The wiring, and the only place github.js and render/ meet.
 *
 *   collect(repo) -> buildModel(...) -> renderHtml(Model) -> a file
 *                 -> monitorRows(...) -> sendRuns(...)  -> the Harness Monitor, with --send
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

import { collect, GitHubError } from './github.js';
import { buildModel, monitorRows } from './model.js';
import { MonitorError, newestStored, sendRuns, sendWindow } from './monitor.js';
import { renderHtml } from './render/html.js';

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
  --send              also send the runs to the Harness Monitor at $HARNESS_MONITOR_URL with
                      $HARNESS_WRITE_KEY: those from its newest stored run less two days, or
                      the --days window when it holds none
  --from <YYYY-MM-DD> with --send, send the runs of this window instead and write nothing (the backfill)
  --to <YYYY-MM-DD>   the window's last day, inclusive (default today)
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
function positive(raw, name, args) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    args.invalid ??= `${name} needs a positive number, not ${JSON.stringify(raw ?? null)}`;
    return undefined;
  }
  return value;
}

/** A UTC day as a Date at its start, or a recorded complaint. */
function day(raw, name, args) {
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

  // A Monitor that cannot say where to start costs the send, never the page.
  let window = null;
  let unsent = null;
  if (monitor) {
    try {
      const newest = backfill ? null : await newestStored({ url: monitor.url });
      window = sendWindow({ newest, now, days, from: args.from, to: args.to ?? (backfill ? now : null) });
    } catch (error) {
      if (!(error instanceof MonitorError)) throw error;
      unsent = error;
    }
  }

  let collected;
  try {
    // One read serves the page and the send: back to whichever starts earlier.
    collected = await collect({
      repo,
      branch,
      since: backfill ? window.since : window && window.since < pageSince ? window.since : pageSince,
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
  return monitor ? send(monitor, collected, window, { backfill }) : 0;
}

/**
 * Sends the runs inside the send's window. A send the run budget stopped inside
 * that window fails, naming the backfill that sends the rest: the newest runs
 * are stored all the same, so the next send starts after the gap and no
 * overlap ever reaches back into it.
 */
async function send(monitor, collected, window, { backfill }) {
  const runs = collected.runs.filter((run) => new Date(run.createdAt) >= window.since);
  // A read that went on past the window's start read all of it, whatever stopped it after.
  const cut = collected.truncated && runs.length === collected.runs.length;
  const ids = new Set(runs.map((run) => run.id));
  let result;
  try {
    result = await sendRuns({
      url: monitor.url,
      key: monitor.key,
      runs: monitorRows({ runs, jobs: collected.jobs.filter((job) => ids.has(job.runId)) }),
    });
  } catch (error) {
    if (!(error instanceof MonitorError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  process.stderr.write(
    `sent ${result.runs} runs from ${window.since.toISOString()} to the Harness Monitor in ${result.batches} batch${result.batches === 1 ? '' : 'es'}\n`,
  );
  if (cut) {
    const oldest = runs.reduce((min, run) => (run.createdAt < min ? run.createdAt : min), runs[0]?.createdAt ?? '');
    const from = window.since.toISOString().slice(0, 10);
    process.stderr.write(
      `The run budget (--max-runs), or the 1,000 runs GitHub lists at most, stopped the read at ${oldest}; the runs before it were not sent. Send them with ${backfill ? '' : `the Stability backfill, --from ${from} `}--to ${oldest.slice(0, 10)}.\n`,
    );
    return 1;
  }
  return 0;
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
