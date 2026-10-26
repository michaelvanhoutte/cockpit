/**
 * The wiring, and the only place github.js and model.js meet.
 *
 *   collect(repo) -> buildModel(...) -> renderHtml(model) -> a file
 *                 -> monitorRows(...) -> sendPulls(...)   -> the Harness Monitor, with --send
 *                 -> monitorTimelines(...) -> sendTimelines(...), with --timelines-only instead
 *
 * `--json` stops after the second arrow, so anything else can consume the
 * model. `--send` reads once for both, back to whichever window starts earlier,
 * and sends after the page is written, so a Monitor that refuses costs the send
 * and never the page. Nothing is written until every request has come back: a page of partial
 * numbers looks exactly like a page of real ones, so a failed fetch leaves the
 * previous file in place rather than replacing it with a plausible lie.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collect, GitHubError } from './github.js';
import { buildModel, monitorRows, monitorTimelines } from './model.js';
import { MonitorError, newestStored, sendPulls, sendTimelines, sendWindow } from './monitor.js';
import { renderHtml } from './render/html.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

const USAGE = `Usage: node src/cli.js [options]

  --out <path>        where to write (default ../out/index.html, or model.json with --json)
  --json              write the model instead of the page
  --model <path>      also write the model, as --json would, to this path
  --days <n>          how far back to read (default: the widest window)
  --windows <a,b>     the windows to report, in days (default 7,14)
  --max-pulls <n>     stop after this many pull requests, and report the shorter period (default 120)
  --repo <owner/name> default: $GITHUB_REPOSITORY, else this checkout's origin
  --branch <name>     the trunk: pull requests merged into it, or into any feature/* branch, are read (default: main)
  --send              also send the pull requests to the Harness Monitor at $HARNESS_MONITOR_URL with
                      $HARNESS_WRITE_KEY: those merged from its newest stored merge less two days, or
                      the --days window when it holds none
  --from <YYYY-MM-DD> with --send, send the pull requests merged in this window instead and write nothing (the backfill)
  --to <YYYY-MM-DD>   the window's last day, inclusive (default today)
  --timelines-only    with --from, send only each pull request's timeline, beside the pull requests the
                      Monitor holds, and never replace a pull request
  --help
`;

/** Quiet on failure: a missing git or a missing remote is not an error here, just no answer. */
function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function repoFromGitRemote() {
  const url = run('git', ['config', '--get', 'remote.origin.url']);
  const match = url?.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  return match ? match[1] : null;
}

/** A token is what makes a full window possible at all; `gh` is asked last, which is what makes a local run work without any setup. */
function resolveToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || run('gh', ['auth', 'token']) || undefined;
}

/**
 * A count, or a recorded complaint. `Number('8OO')` is NaN and every comparison
 * against NaN is false, so an unchecked `--max-pulls` typo does not shrink the
 * budget, it removes it — and a fetch with no budget walks the whole history
 * against an allowance the repository's other workflows share. Refused rather
 * than defaulted.
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
  const args = { windows: [7, 14] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--send') args.send = true;
    else if (arg === '--timelines-only') args.timelinesOnly = true;
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
    else if (arg === '--max-pulls') args.maxPulls = positive(value(), '--max-pulls', args);
    else if (arg === '--repo') args.repo = value();
    else if (arg === '--branch') args.branch = value();
    // `?? ''` because a trailing `--windows` would otherwise throw out of parseArgs,
    // which main calls outside any catch: a stack trace where every other bad
    // argument gets the usage message.
    else if (arg === '--windows')
      args.windows = (value() ?? '')
        .split(',')
        .map((each) => positive(each, '--windows', args));
    // The first one, not the last: a misspelled flag leaves its value looking like
    // an argument too, and naming that sends the reader after the wrong word.
    else args.unknown ??= arg;
  }
  if (args.to && !args.from) args.invalid ??= '--to needs --from';
  if (args.from && !args.send) args.invalid ??= '--from needs --send: a window given by hand is only ever sent';
  if (args.from && args.to && args.to <= args.from) args.invalid ??= '--to cannot be before --from';
  if (args.timelinesOnly && !args.from) args.invalid ??= '--timelines-only needs --from: only the backfill sends timelines alone';
  return args;
}

/**
 * What is written and its default name: the page, or with `--json` the model. Kept
 * apart from `main` so what a flag chooses can be read without a fetch.
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
  const days = args.days ?? Math.max(...args.windows);
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);
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
      since: backfill ? window.since : window && window.since < since ? window.since : since,
      until: backfill ? window.until : null,
      now,
      maxPulls: args.maxPulls ?? 120,
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
    const { written, actualDays, truncated } = writeReport(args, collected, { now, days, since, repo, branch });
    process.stderr.write(
      `wrote ${written.join(', ')} — ${collected.pulls.length} pull requests, ${collected.requests} requests` +
        `${collected.failed.length ? `, ${collected.failed.length} unreadable` : ''}` +
        `${truncated ? `, stopped at --max-pulls after ${actualDays.toFixed(1)} days` : ''}\n`,
    );
  }
  if (unsent) {
    process.stderr.write(`${unsent.message}\nNothing was sent; the next send's window reaches back for it.\n`);
    return 1;
  }
  return monitor ? send(monitor, collected, window, { backfill, branch, timelinesOnly: Boolean(args.timelinesOnly) }) : 0;
}

/**
 * Sends the pull requests merged inside the send's window, oldest first, so a
 * send that stops partway leaves the Monitor's newest merge where the next
 * send's overlap picks the rest up. A read the pull budget stopped inside that
 * window fails, naming the backfill that sends the pull requests before it: the
 * next send starts from the newest stored merge, after the gap, so no overlap
 * ever reaches back into it. With `timelinesOnly` it sends each pull request's
 * timeline alone, which the Monitor stores beside the pull request it holds.
 */
async function send(monitor, collected, window, { backfill, branch, timelinesOnly }) {
  const pulls = collected.pulls
    .filter((pull) => new Date(pull.mergedAt) >= window.since)
    .sort((a, b) => new Date(a.mergedAt) - new Date(b.mergedAt));
  // A read that went back past the window's start read all of it, whatever stopped it after.
  const cut = collected.truncated && collected.coveredSince > window.since;
  const reached = collected.coveredSince.toISOString().slice(0, 10);
  const gap = cut
    ? `The pull budget (--max-pulls) stopped the read at ${reached}; the pull requests merged before it were not sent. Send them with ${backfill ? '' : 'the Cycle time backfill, '}--from ${window.since.toISOString().slice(0, 10)} --to ${reached}${timelinesOnly ? ' --timelines-only' : ''}.\n`
    : '';
  const unreadable = collected.failed.length
    ? `${collected.failed.length} pull request${collected.failed.length === 1 ? '' : 's'} could not be read and ${collected.failed.length === 1 ? 'was' : 'were'} not sent: ${collected.failed.map((pull) => `#${pull.number}`).join(', ')}.\n`
    : '';
  let result;
  try {
    result = timelinesOnly
      ? await sendTimelines({ url: monitor.url, key: monitor.key, timelines: monitorTimelines({ pulls, trunk: branch }) })
      : await sendPulls({ url: monitor.url, key: monitor.key, pulls: monitorRows({ pulls, trunk: branch }) });
  } catch (error) {
    if (!(error instanceof MonitorError)) throw error;
    process.stderr.write(`${error.message}\n${unreadable}${gap}`);
    return 1;
  }
  process.stderr.write(
    `sent ${result.pulls} ${timelinesOnly ? "pull requests' timelines" : 'pull requests'} merged from ${window.since.toISOString()} to the Harness Monitor in ${result.batches} batch${result.batches === 1 ? '' : 'es'}\n${unreadable}${gap}`,
  );
  // A pull request that could not be read is not sent, and once a later merge is stored the next send's window starts past it: the run fails so it is looked at while it still reaches.
  return cut || collected.failed.length > 0 ? 1 : 0;
}

/** The page, or the model, over its own window, and the model beside it with --model. */
function writeReport(args, collected, { now, days, since, repo, branch }) {
  // A send can read further back than the page shows; the page keeps to its window,
  // and a read that went back past it read all of it, whatever stopped it after.
  const pulls = collected.pulls.filter((pull) => new Date(pull.mergedAt) >= since);
  const truncated = collected.truncated && collected.coveredSince > since;
  const model = buildModel({
    pulls,
    failed: collected.failed,
    now,
    requestedDays: days,
    coveredSince: collected.coveredSince,
    truncated,
    repo,
    branch,
    commit: process.env.GITHUB_SHA ?? run('git', ['rev-parse', 'HEAD']),
    windows: args.windows,
  });

  const { content } = output(args, model);
  const out = path.resolve(args.out ?? defaultOut(args));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, content, 'utf8');
  const written = [out];

  if (args.model) {
    const modelOut = path.resolve(args.model);
    mkdirSync(path.dirname(modelOut), { recursive: true });
    writeFileSync(modelOut, modelJson(model), 'utf8');
    written.push(modelOut);
  }
  return { written, actualDays: model.coverage.actualDays, truncated };
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
