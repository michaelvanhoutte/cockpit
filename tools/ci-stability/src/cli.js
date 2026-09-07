/**
 * The wiring, and the only place github.js and render/ meet.
 *
 *   collect(repo) -> buildModel(...) -> renderHtml(Model) -> a file
 *
 * `--json` stops after the second arrow, so anything else can consume the
 * model. Nothing is written until every request has come back: a page of
 * partial numbers looks exactly like a page of real ones, so a failed fetch
 * leaves the previous report in place rather than replacing it with a
 * plausible lie.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collect, GitHubError } from './github.js';
import { buildModel } from './model.js';
import { renderHtml } from './render/html.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

const USAGE = `Usage: node src/cli.js [options]

  --out <path>        where to write (default ../out/index.html, or model.json with --json)
  --json              write the model instead of the page
  --days <n>          how far back to read (default 30)
  --windows <a,b>     the windows to report, in days (default 7,30)
  --max-runs <n>      stop after this many runs, and report the shorter window (default 800)
  --repo <owner/name> default: $GITHUB_REPOSITORY, else this checkout's origin
  --branch <name>     default: main
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

export function parseArgs(argv) {
  const args = { windows: [7, 30] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--out') args.out = value();
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
  return args;
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

  const branch = args.branch ?? 'main';
  const days = args.days ?? 30;
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);

  let collected;
  try {
    collected = await collect({
      repo,
      branch,
      since,
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

  const model = buildModel({
    runs: collected.runs,
    jobs: collected.jobs,
    now,
    requestedDays: days,
    truncated: collected.truncated,
    reachedWindowEdge: collected.reachedWindowEdge,
    ignored: collected.ignored,
    repo,
    branch,
    commit: process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']),
    windows: args.windows,
  });

  const out = path.resolve(
    args.out ?? path.join(here, args.json ? '../out/model.json' : '../out/index.html'),
  );
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, args.json ? JSON.stringify(model, null, 2) : renderHtml(model), 'utf8');
  process.stderr.write(
    `wrote ${out} — ${collected.runs.length} runs, ${collected.requests + 1} requests\n`,
  );
  return 0;
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
