/**
 * The wiring, and the only place github.js and model.js meet.
 *
 *   collect(repo) -> buildModel(...) -> a file
 *
 * Nothing is written until every request has come back: a model of partial
 * numbers looks exactly like a model of real ones, so a failed fetch leaves the
 * previous file in place rather than replacing it with a plausible lie. The page
 * that draws the model is a separate piece of work, so the model is all this
 * writes and `--json` is what it always does.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { collect, GitHubError } from './github.js';
import { buildModel } from './model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

const USAGE = `Usage: node src/cli.js [options]

  --out <path>        where to write the model (default ../out/model.json)
  --json              write the model; the only output there is, so this changes nothing
  --days <n>          how far back to read (default: the widest window)
  --windows <a,b>     the windows to report, in days (default 7,14)
  --max-pulls <n>     stop after this many pull requests, and report the shorter period (default 150)
  --repo <owner/name> default: $GITHUB_REPOSITORY, else this checkout's origin
  --branch <name>     default: main
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

export function parseArgs(argv) {
  const args = { windows: [7, 14] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--out') args.out = value();
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
  const days = args.days ?? Math.max(...args.windows);
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);

  let collected;
  try {
    collected = await collect({ repo, branch, since, now, maxPulls: args.maxPulls ?? 150, token: resolveToken() });
  } catch (error) {
    if (error instanceof GitHubError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const model = buildModel({
    pulls: collected.pulls,
    failed: collected.failed,
    now,
    requestedDays: days,
    coveredSince: collected.coveredSince,
    truncated: collected.truncated,
    repo,
    branch,
    commit: process.env.GITHUB_SHA ?? run('git', ['rev-parse', 'HEAD']),
    windows: args.windows,
  });

  const out = path.resolve(args.out ?? path.join(here, '../out/model.json'));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(model, null, 2), 'utf8');
  process.stderr.write(
    `wrote ${out} — ${collected.pulls.length} pull requests, ${collected.requests} requests` +
      `${collected.failed.length ? `, ${collected.failed.length} unreadable` : ''}` +
      `${collected.truncated ? `, stopped at --max-pulls after ${model.coverage.actualDays.toFixed(1)} days` : ''}\n`,
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
