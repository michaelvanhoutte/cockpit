/**
 * The one-off backfill: `pnpm stability:backfill`, run once from the engineer's machine. It sends
 * the Harness Monitor every attempt of every run since 1 October (or `--from`) on `main` and on
 * every other branch, with the two sends that already exist (cli.js): `main`'s runs and attempts a
 * week at a time, oldest first, then every other branch's attempts a day at a time. Nothing new is
 * sent or stored by this file; it only asks both for the window and for what they alone do not do,
 * which is `--old-failures`: a failed job's tests read from GitHub's annotations or its log where
 * no record names them (the nightly sends rely on records, which expire after 30 days).
 *
 * It reads with the engineer's own GitHub token (`GITHUB_TOKEN`, `GH_TOKEN`, else `gh auth token`),
 * whose 5,000 requests an hour hold October in one run, and sends with `HARNESS_WRITE_KEY` to
 * `HARNESS_MONITOR_URL`. Each attempt is stored by its run and number, so a run sent again, or a
 * window sent twice, stores nothing twice.
 */

import { pathToFileURL } from 'node:url';

import { day, main, positive } from './cli.js';

const DAY_MS = 86_400_000;
/** The first day of the backfill: the day the Harness Monitor began to hold CI's runs. */
export const FIRST_DAY = '2026-10-01';
/** The days of `main`'s runs read at a time: GitHub lists at most 1,000 runs of one span. */
const WEEK = 7;
/** Far more than a month holds; the budget the nightly sends keep is for the hourly allowance Actions shares, and this one is the engineer's own. */
const MAX_RUNS = 20_000;

const USAGE = `Usage: pnpm stability:backfill [options]

  --from <YYYY-MM-DD>  the first day to send (default ${FIRST_DAY})
  --to <YYYY-MM-DD>    the last day to send, inclusive (default today)
  --repo <owner/name>  default: $GITHUB_REPOSITORY, else this checkout's origin
  --max-runs <n>       stop the branches after the day that reaches this many runs (default ${MAX_RUNS})
  --only <main|branches>  send one half only, to carry on after a stop
  --help
`;

export function parseBackfillArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--from') args.from = day(value(), '--from', args);
    else if (arg === '--to') args.to = day(value(), '--to', args);
    else if (arg === '--repo') args.repo = value();
    else if (arg === '--max-runs') args.maxRuns = positive(value(), '--max-runs', args);
    else if (arg === '--only') {
      const only = value();
      if (only === 'main' || only === 'branches') args.only = only;
      else args.invalid ??= `--only needs main or branches, not ${JSON.stringify(only ?? null)}`;
    } else args.unknown ??= arg;
  }
  return args;
}

const isoDay = (date) => date.toISOString().slice(0, 10);

/** `main`'s days cut into weeks, oldest first: `{ from, to }` as days, both inclusive. */
function weeks(from, last) {
  const spans = [];
  for (let start = from; start <= last; start = new Date(start.getTime() + WEEK * DAY_MS)) {
    spans.push({ from: isoDay(start), to: isoDay(new Date(Math.min(start.getTime() + (WEEK - 1) * DAY_MS, last.getTime()))) });
  }
  return spans;
}

/** Runs `work` with every request to GitHub counted, and answers how many it made. */
async function counting(work) {
  const real = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (input, init) => {
    if (String(input?.url ?? input).startsWith('https://api.github.com')) requests += 1;
    return real(input, init);
  };
  try {
    return { code: await work(), requests: () => requests };
  } finally {
    globalThis.fetch = real;
  }
}

export async function backfill(argv, { now = new Date() } = {}) {
  const args = parseBackfillArgs(argv);
  const refuse = (message) => {
    process.stderr.write(`${message}\n\n${USAGE}`);
    return 2;
  };
  if (args.unknown) return refuse(`unknown argument: ${args.unknown}`);
  if (args.invalid) return refuse(args.invalid);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!process.env.HARNESS_MONITOR_URL || !process.env.HARNESS_WRITE_KEY) {
    return refuse('Set HARNESS_MONITOR_URL and HARNESS_WRITE_KEY first (docs/deployment.md, "The Harness Monitor").');
  }

  const from = args.from ?? new Date(`${FIRST_DAY}T00:00:00Z`);
  const last = args.to ?? new Date(`${isoDay(now)}T00:00:00Z`);
  if (last < from) return refuse('--to cannot be before --from');
  const shared = [...(args.repo ? ['--repo', args.repo] : []), '--max-runs', String(args.maxRuns ?? MAX_RUNS), '--old-failures'];
  const say = (text) => process.stderr.write(`${text}\n`);
  let total = 0;

  say(`Sending every attempt from ${isoDay(from)} to ${isoDay(last)}${args.only ? `, ${args.only} only` : ''}.`);
  if (args.only !== 'branches') {
    for (const span of weeks(from, last)) {
      say(`\nmain, ${span.from} to ${span.to}`);
      const { code, requests } = await counting(() => main(['--send', '--from', span.from, '--to', span.to, ...shared]));
      total += requests();
      say(`${requests()} GitHub requests`);
      if (code !== 0) {
        say(`\nStopped in main's week from ${span.from}. What came before it is stored. Send the rest with: pnpm stability:backfill --from ${span.from} --to ${isoDay(last)}`);
        return code;
      }
    }
  }
  if (args.only !== 'main') {
    say(`\nevery other branch, ${isoDay(from)} to ${isoDay(last)}`);
    const { code, requests } = await counting(() => main(['--branches', '--send', '--from', isoDay(from), '--to', isoDay(last), ...shared]));
    total += requests();
    if (code !== 0) {
      say(`\nStopped. What came before it is stored. Send the rest with --only branches and the --from day named above: pnpm stability:backfill --only branches --from <that day> --to ${isoDay(last)}`);
      return code;
    }
  }
  say(`\nDone: ${total} GitHub requests. Running it again stores nothing twice.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  backfill(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
