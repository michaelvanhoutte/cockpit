/**
 * The wiring, and the only place github.js and model.js meet.
 *
 *   collect(repo) -> buildModel(...) -> a model file
 *                 -> monitorRows(...) -> sendPulls(...)   -> the Harness Monitor, with --send
 *
 * The model file is what the nightly job's alarms read; the Harness Monitor
 * draws the page. Nothing is written until every request has come back: a
 * model of partial numbers looks exactly like a model of real ones, so a failed
 * fetch leaves the previous file in place rather than replacing it with a
 * plausible lie. `--send` reads once for both, back to whichever window starts
 * earlier, and sends after the model is written, so a Monitor that refuses
 * costs the send and never the model.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { git, repoFromGitRemote, resolveToken } from './environment.js';
import { collect, GitHubError } from './github.js';
import { listAlarmIssues } from './issues.js';
import { buildModel, monitorBars, monitorRows } from './model.js';
import { MonitorError, newestStored, sendPulls, sendWindow } from './monitor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

const USAGE = `Usage: node src/cli.js [options]

  --model <path>      where to write the model (default ../out/model.json)
  --days <n>          how far back to read (default 14)
  --windows <a,b>     the windows "Is selection working?" reports, in days (default 7,14)
  --max-pulls <n>     stop after this many merged pull requests (default 150)
  --repo <owner/name> default: $GITHUB_REPOSITORY, else this checkout's origin
  --branch <name>     default: main
  --send              also send the pull requests to the Harness Monitor at $HARNESS_MONITOR_URL with
                      $HARNESS_WRITE_KEY: those merged from its newest stored merge less two days, or
                      the --days window when it holds none
  --from <YYYY-MM-DD> with --send, send the pull requests merged in this window instead and write nothing (the backfill)
  --to <YYYY-MM-DD>   the window's last day, inclusive (default today)
  --help
`;

/**
 * A count, or a recorded complaint. `Number('8OO')` is NaN, and every
 * comparison against NaN is false — so an unchecked typo does not shrink the
 * budget, it removes it. Both mistakes fail towards fetching everything,
 * which is why they are refused rather than defaulted.
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
    else if (arg === '--send') args.send = true;
    else if (arg === '--from') args.from = day(value(), '--from', args);
    // The last day is inclusive, so the window ends at the start of the day after it.
    else if (arg === '--to') {
      const last = day(value(), '--to', args);
      if (last) args.to = new Date(last.getTime() + DAY_MS);
    }
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
    // `?? ''`: a trailing `--windows` with nothing after it would otherwise
    // throw a TypeError out of parseArgs, which main calls outside any catch.
    else if (arg === '--windows') args.windows = (value() ?? '').split(',').map((each) => positive(each, '--windows', args));
    // The first unrecognised argument, not the last: a misspelled flag leaves
    // its value looking like an argument too, and naming that instead sends
    // the reader after the wrong word.
    else args.unknown ??= arg;
  }
  if (args.to && !args.from) args.invalid ??= '--to needs --from';
  if (args.from && !args.send) args.invalid ??= '--from needs --send: a window given by hand is only ever sent';
  if (args.from && args.to && args.to <= args.from) args.invalid ??= '--to cannot be before --from';
  return args;
}

/** What a run writes: the model, and nothing else. */
export function output(args, model) {
  return { file: path.resolve(args.model ?? path.join(here, '../out/model.json')), content: JSON.stringify(model, null, 2) };
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
  const days = args.days ?? 14;
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);
  const token = resolveToken();
  const backfill = Boolean(args.from);

  // A Monitor that cannot say where to start costs the send, never the model.
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
    // One read serves the model and the send: back to whichever starts earlier.
    collected = await collect({
      repo,
      branch,
      since: backfill ? window.since : window && window.since < since ? window.since : since,
      until: backfill ? window.until : null,
      now,
      maxPulls: args.maxPulls ?? 150,
      token,
    });
  } catch (error) {
    if (error instanceof GitHubError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  // Each bar's alarm is carried in the model and sent with its threshold: a model without the links is
  // still true, so unlike the pull requests above a failed read costs the links, and the Monitor keeps
  // the alarm issues it holds rather than being told there are none.
  let alarms = null;
  try {
    alarms = await listAlarmIssues({ repo, token });
  } catch (error) {
    process.stderr.write(`could not read the alarm issues, so the model links none${monitor ? ' and the Harness Monitor keeps the ones it holds' : ''}: ${error.message}\n`);
  }

  if (!backfill) {
    const { written, pulls: shown } = writeReport(args, collected, { alarms: alarms ?? [], now, days, since, repo, branch });
    process.stderr.write(`wrote ${written.join(', ')} — ${shown} pull requests\n`);
  }
  if (unsent) {
    process.stderr.write(`${unsent.message}\nNothing was sent; the next send's window reaches back for it.\n`);
    return 1;
  }
  return monitor ? send(monitor, collected, window, { alarms: alarms ?? undefined, backfill }) : 0;
}

/**
 * Sends the pull requests merged inside the send's window, oldest first, so a
 * send that stops partway leaves the Monitor's newest merge where the next
 * send's overlap picks the rest up. A read the pull budget stopped inside that
 * window fails, naming the backfill that sends the pull requests before it: the
 * next send starts from the newest stored merge, after the gap, so no overlap
 * ever reaches back into it.
 */
async function send(monitor, collected, window, { alarms, backfill }) {
  const pulls = collected.pulls
    .filter((data) => new Date(data.pull.mergedAt) >= window.since)
    .sort((a, b) => new Date(a.pull.mergedAt) - new Date(b.pull.mergedAt));
  // A read that went back past the window's start read all of it, whatever stopped it after.
  const cut = collected.truncated && collected.coveredSince > window.since;
  const reached = collected.coveredSince.toISOString().slice(0, 10);
  const gap = cut
    ? `The pull budget (--max-pulls) stopped the read at ${reached}; the pull requests merged before it were not sent. Send them with ${backfill ? '' : `the Selection backfill, --from ${window.since.toISOString().slice(0, 10)} `}--to ${reached}.\n`
    : '';
  let result;
  try {
    result = await sendPulls({ url: monitor.url, key: monitor.key, pulls: monitorRows({ pulls }), bars: monitorBars({ alarms }) });
  } catch (error) {
    if (!(error instanceof MonitorError)) throw error;
    process.stderr.write(`${error.message}\n${gap}`);
    return 1;
  }
  process.stderr.write(
    `sent ${result.pulls} pull requests merged from ${window.since.toISOString()} to the Harness Monitor in ${result.batches} batch${result.batches === 1 ? '' : 'es'}\n${gap}`,
  );
  return cut ? 1 : 0;
}

/** The model, over its own window. */
function writeReport(args, collected, { alarms, now, days, since, repo, branch }) {
  // A send can read further back than the model shows; the model keeps to its window,
  // and a read that went back past it read all of it, whatever stopped it after.
  const pulls = collected.pulls.filter((data) => new Date(data.pull.mergedAt) >= since);
  const model = buildModel({
    alarms,
    pulls,
    now,
    requestedDays: days,
    coveredSince: collected.coveredSince,
    truncated: collected.truncated && collected.coveredSince > since,
    repo,
    branch,
    commit: process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']),
    windows: args.windows,
  });

  const { file, content } = output(args, model);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return { written: [file], pulls: pulls.length };
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
