/**
 * The nightly job's alarm step, and the only place alarm.js and issues.js meet.
 *
 *   model.json -> decideAlarms(model, the repository's alarm issues) -> the writes
 *
 * Runs after the report is written and uploaded, so a failure here makes the
 * job red and costs the page nothing. Every write is tried; a refused one is
 * named by its bar at the end rather than stopping the others.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { decideAlarms } from './alarm.js';
import { repoFromGitRemote, resolveToken } from './environment.js';
import { addComment, createIssue, editIssue, ensureLabel, listAlarmIssues, listComments } from './issues.js';

const USAGE = `Usage: node src/alarm-cli.js --model <path> [options]

  --model <path>      the model the report step wrote
  --repo <owner/name> default: $GITHUB_REPOSITORY, else this checkout's origin
  --dry-run           print what would be filed, edited and commented on; change nothing
  --help
`;

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--model') args.model = value();
    else if (arg === '--repo') args.repo = value();
    else args.unknown ??= arg;
  }
  return args;
}

/** One line per action, for the log and for --dry-run. */
export function summarise(action) {
  if (action.kind === 'create') return `file    [${action.bar}] ${action.title}`;
  if (action.kind === 'edit') return `edit    [${action.bar}] #${action.number} ${action.title}`;
  return `comment [${action.bar}] #${action.number}`;
}

/**
 * Reads the alarm issues, decides, and performs the writes.
 *
 * @returns {Promise<{ actions: object[], failures: { bar: string, message: string }[] }>}
 */
export async function runAlarm({ model, repo, token, fetchImpl, dryRun = false, log = () => {} }) {
  const ctx = { repo, token, fetchImpl };
  const alarms = await listAlarmIssues(ctx);
  for (const alarm of alarms) {
    if (alarm.state === 'open') alarm.comments = await listComments({ ...ctx, number: alarm.number });
  }

  const actions = decideAlarms({ model, alarms });
  for (const action of actions) log(summarise(action));
  if (dryRun || actions.length === 0) return { actions, failures: [] };

  const failures = [];
  const attempt = async (action, work) => {
    try {
      await work();
    } catch (error) {
      failures.push({ bar: action.bar, message: error.message });
    }
  };

  // Without the label a create would file an issue nothing can find again; the
  // edits and comments need no label and still go ahead.
  let labelError = null;
  if (actions.some((action) => action.kind === 'create')) {
    try {
      await ensureLabel(ctx);
    } catch (error) {
      labelError = error;
    }
  }

  for (const action of actions) {
    if (action.kind === 'create') {
      if (labelError) {
        failures.push({ bar: action.bar, message: `the selection-alarm label could not be made: ${labelError.message}` });
        continue;
      }
      await attempt(action, async () => log(`filed [${action.bar}] #${await createIssue({ ...ctx, title: action.title, body: action.body })}`));
    } else if (action.kind === 'edit') {
      await attempt(action, () => editIssue({ ...ctx, number: action.number, title: action.title, body: action.body }));
    } else {
      await attempt(action, () => addComment({ ...ctx, number: action.number, body: action.body }));
    }
  }
  return { actions, failures };
}

export async function main(argv, { fetchImpl } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.unknown || !args.model) {
    process.stderr.write(`${args.unknown ? `unknown argument: ${args.unknown}` : '--model needs a path'}\n\n${USAGE}`);
    return 2;
  }
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY ?? repoFromGitRemote();
  if (!repo) {
    process.stderr.write('Could not tell which repository to read; pass --repo owner/name.\n');
    return 2;
  }
  const token = resolveToken();
  if (!token) {
    process.stderr.write('Filing an issue needs a token: set GITHUB_TOKEN.\n');
    return 2;
  }

  const model = JSON.parse(readFileSync(args.model, 'utf8'));
  const { actions, failures } = await runAlarm({ model, repo, token, fetchImpl, dryRun: args.dryRun, log: (line) => process.stderr.write(`${line}\n`) });

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`alarm for ${failure.bar} failed: ${failure.message}\n`);
    return 1;
  }
  process.stderr.write(actions.length === 0 ? 'no alarm to file, edit or comment on\n' : `${args.dryRun ? 'would make' : 'made'} ${actions.length} alarm ${actions.length === 1 ? 'change' : 'changes'}\n`);
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
