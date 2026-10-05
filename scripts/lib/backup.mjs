//
// Everything `pnpm backup:export` decides, with the fetching and the file
// writing injected - the same shape as health.mjs, and for the same reason: a
// decision that nothing can run is a decision nothing checks. The runner
// (scripts/backup-export.mjs) supplies a real `ask` and a real `files`; the
// tests supply fakes and drive the cases that matter, which are the ones where
// something goes wrong partway.
//
// What a backup is, and why it is a directory rather than one file, is "Take a
// backup of an environment, or of one user" (issue 208). The short version: one
// file per account is what makes restoring a single user a file operation
// rather than a filter.
//

import * as fsp from 'node:fs/promises';
import { join } from 'node:path';

import { readAnswer, readEnvironment, readFlags } from './operator.mjs';

/** Where each environment answers. Production and staging are Workers of their own. */
const WORKERS = Object.freeze({
  production: 'cockpit',
  staging: 'cockpit-staging',
});

/**
 * The address to back up.
 *
 * **Local has no fixed port**, so none is written here: a linked worktree gets
 * its own pair derived from its path, which is what lets several run at once
 * (scripts/lib/ports.mjs). The caller passes the one `portsFor` gave it.
 */
export function addressOf(environment, { subdomain, apiPort } = {}) {
  if (environment === 'local') {
    if (!apiPort) throw new Error('the local address needs the port pnpm dev is on');
    return `http://localhost:${apiPort}`;
  }
  // Reached only by something that did not read its arguments through
  // `readArguments`, which checks this first - kept so the name is refused
  // wherever it arrives, and calling the same function so there is one message
  // rather than two that drift.
  readEnvironment(environment);
  const worker = WORKERS[environment];
  if (!subdomain) {
    throw new Error(
      `reaching ${environment} needs the workers.dev subdomain it is served from: put it in ` +
        'backup-tokens.json as "subdomain", or set CLOUDFLARE_WORKERS_SUBDOMAIN',
    );
  }
  return `https://${worker}.${subdomain}.workers.dev`;
}

/**
 * What the command was asked to do.
 *
 * `--user` names one account rather than every registered one. It is the
 * account's name, which is what the register calls a user's account and what
 * every row of their store carries.
 */
export function readArguments(argv) {
  const args = readFlags(argv, {
    takes: { '--env': 'environment', '--out': 'out', '--user': 'user' },
    switches: { '--dated': 'dated', '--force': 'force' },
  });
  if (!args.environment) throw new Error('--env says which environment to back up');
  readEnvironment(args.environment);
  if (!args.out) throw new Error('--out says where to write the backup');
  if (args.force && args.dated) {
    throw new Error('--force has nothing to replace with --dated - a dated folder is new every run');
  }
  return args;
}

/**
 * The sub-folder `--dated` writes into: `<env>-<UTC time>`, or
 * `<env>-<user>-<UTC time>` with `--user`, the time as `2026-10-05T14-32-07Z`
 * because Windows refuses colons in a name. `startedAt` is when the run began,
 * since the name is needed before staging does; the manifest's `takenAt` stays
 * the moment it finished.
 */
export function datedName(environment, user, startedAt) {
  const time = `${startedAt.toISOString().slice(0, 19).replaceAll(':', '-')}Z`;
  return [environment, user && nameAsAFile(user), time].filter(Boolean).join('-');
}

/** What may sit in a folder `--force` replaces: an earlier backup and nothing else. */
const BACKUP_FILES = Object.freeze(['manifest.json', 'register.json']);

/**
 * Where the backup goes, and the `files` that put it there - refusing, before
 * anything is fetched, every destination it must not write into.
 *
 * `disk` is `node:fs/promises` unless a test hands it one with a step that
 * fails. Every refusal here leaves the disk as it found it, except that
 * `--dated` creates `--out` when it is missing.
 */
export async function prepareBackup({ out, dated, force, environment, user, startedAt, disk = fsp }) {
  let target = out;
  if (dated) {
    await disk.mkdir(out, { recursive: true });
    target = join(out, datedName(environment, user, startedAt));
  }
  await refuseLeftovers(disk, target);

  let replacing = 'nothing';
  const found = await kindOf(disk, target);
  if (found === 'directory' && (await disk.readdir(target)).length === 0) {
    replacing = 'an empty folder';
  } else if (found && dated) {
    throw new Error(`${target} is already there - a dated backup was taken this same second.`);
  } else if (found && !force) {
    throw new Error(
      `${target} is already there. Backups are not written over: name a new directory, ` +
        'add --dated to write into a new dated folder inside it, or add --force to replace ' +
        'an earlier backup there.',
    );
  } else if (found) {
    await refuseAnythingButABackup(disk, target);
    replacing = 'an earlier backup';
  }

  return {
    target,
    files: {
      // Beside the destination rather than in a temporary folder, so that
      // settling is a rename within one filesystem.
      async stage(at) {
        const staged = `${at}.partial`;
        // Not recursive, so a `.partial` that appeared since the check above
        // fails here rather than being written into.
        await disk.mkdir(staged);
        await disk.mkdir(join(staged, 'accounts'));
        return staged;
      },
      async write(path, contents) {
        await disk.writeFile(path, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
      },
      settle: (staged, at) => settle({ disk, staged, target: at, replacing }),
    },
  };
}

/**
 * Moves the staged backup to where it was asked for, and returns a warning to
 * print if one is owed.
 *
 * **An earlier backup is set aside by renaming, never deleted first**, and is
 * removed only once the new one is in its place. Windows will not rename onto
 * an existing directory, hence three steps rather than one. Where a run stops:
 *
 *   - before the first rename: the earlier backup is untouched at `<out>` and
 *     the new one is in `<out>.partial`;
 *   - between the renames: `<out>` is absent, and `<out>.replaced` (the earlier
 *     backup) and `<out>.partial` (the new) are both whole;
 *   - after the second: the new backup is at `<out>`, and only removing
 *     `<out>.replaced` is outstanding - a failure there is a warning, not a
 *     failed run, and a removal stopped halfway leaves a partial copy of a
 *     backup already superseded.
 *
 * Any `<out>.replaced` or `<out>.partial` left behind refuses the next run,
 * `--force` or not (`refuseLeftovers`), so an interrupted swap is never
 * compounded by another that deletes the copy set aside. The backup-only check
 * is made again here, because a long run gives somebody time to put a file
 * there; one written between this check and the rename is set aside and
 * deleted with the earlier backup. An empty folder is removed with a plain
 * directory removal, which the platform refuses on one that is no longer
 * empty, rather than a recursive one trusting a check made a moment earlier.
 */
async function settle({ disk, staged, target, replacing }) {
  if (replacing === 'nothing') {
    if (await kindOf(disk, target)) {
      throw new Error(`${target} appeared during the run. The new backup is in ${staged}.`);
    }
    await disk.rename(staged, target);
    return undefined;
  }

  if (replacing === 'an empty folder') {
    try {
      await disk.rmdir(target);
    } catch (error) {
      throw new Error(
        `${target} is no longer empty - something was put there during the run - so it was ` +
          `left alone (${error.code ?? error.message}). The new backup is in ${staged}.`,
      );
    }
    await disk.rename(staged, target);
    return undefined;
  }

  await refuseAnythingButABackup(disk, target, ` The new backup is in ${staged}.`);
  const replaced = `${target}.replaced`;
  await disk.rename(target, replaced);
  try {
    await disk.rename(staged, target);
  } catch (error) {
    throw new Error(
      `${staged} could not be moved to ${target} (${error.code ?? error.message}). Both backups ` +
        `are whole: the earlier one is in ${replaced}, the new one in ${staged}.`,
    );
  }
  try {
    await disk.rm(replaced, { recursive: true });
  } catch (error) {
    return (
      `The new backup is in place, but the earlier one it replaced could not be removed ` +
      `(${error.code ?? error.message}): remove ${replaced} by hand before the next backup here.`
    );
  }
  return undefined;
}

/** Refuses what an interrupted run left beside `target`, `--force` or not. */
async function refuseLeftovers(disk, target) {
  const replaced = `${target}.replaced`;
  const staged = `${target}.partial`;
  const stagedThere = await kindOf(disk, staged);
  if (await kindOf(disk, replaced)) {
    throw new Error(
      `${replaced} is already there: the earlier backup, set aside by a replacement that did ` +
        `not finish${stagedThere ? `, and ${staged} is the new one it was replacing it with` : ''}. ` +
        `Put back what you want at ${target}, remove the rest, then try again.`,
    );
  }
  // Refused rather than cleared away. What an interrupted run left there is
  // evidence about how far it got, and a silent `rm -rf` of a path derived
  // from what somebody typed would be a poor thing for a backup command to do.
  if (stagedThere) {
    throw new Error(
      `${staged} is already there, left by a run that did not finish. Look at it or remove it, then try again.`,
    );
  }
}

/**
 * Refuses `dir` unless it holds an earlier backup and nothing else:
 * `manifest.json` present, nothing beside it but `register.json` and
 * `accounts/`, and only `.json` files in `accounts/`. This is the whole of what
 * stands between `--force` and a mistyped `--out I:\`.
 */
async function refuseAnythingButABackup(disk, dir, more = '') {
  const refuse = (why) => {
    throw new Error(`${dir} is not only an earlier backup (${why}), so --force leaves it alone.${more}`);
  };
  const entries = await disk.readdir(dir, { withFileTypes: true });
  if (!entries.some((entry) => entry.name === 'manifest.json' && entry.isFile())) {
    refuse('it has no manifest.json');
  }
  for (const entry of entries) {
    const expected = BACKUP_FILES.includes(entry.name)
      ? entry.isFile()
      : entry.name === 'accounts' && entry.isDirectory();
    if (!expected) refuse(`it holds ${entry.name}`);
  }
  if (!entries.some((entry) => entry.name === 'accounts')) return;
  for (const entry of await disk.readdir(join(dir, 'accounts'), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) refuse(`accounts holds ${entry.name}`);
  }
}

/** 'directory', 'other', or null where nothing is there. */
async function kindOf(disk, path) {
  try {
    return (await disk.lstat(path)).isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Takes the backup: the register first, so the list of accounts comes from the
 * environment rather than from whoever typed the command, then each account in
 * turn.
 *
 * **Nothing is written where the backup is asked for until all of it is
 * read.** `files.stage` is somewhere else on the same disk and `files.settle`
 * is what moves it into place, so a run that stops partway - a network that
 * goes, an account that refuses - leaves no directory that reads as a complete
 * backup. The alternative is a half-written backup that looks exactly like a
 * whole one, discovered on the day somebody needs it.
 */
export async function takeBackup({ ask, files, out, only, environment, now = () => new Date() }) {
  const register = await ask('/v1/operator/backup/register');
  readRegister(register);
  const accounts = only ? [only] : register.accounts;

  if (only && !register.accounts.includes(only)) {
    throw new Error(`no account ${only} in this environment - it holds ${listed(register.accounts)}`);
  }

  // Before anything is created, so a register that cannot be written to disk
  // stops the command rather than half of it.
  for (const account of accounts) nameAsAFile(account);

  const staged = await files.stage(out);
  const taken = [];
  for (const account of accounts) {
    const file = await ask(`/v1/operator/backup/accounts/${encodeURIComponent(account)}`);
    readAccountFile(file, account);
    await files.write(`${staged}/accounts/${nameAsAFile(account)}.json`, file);
    taken.push({ account, changesApplied: file.changesApplied, rows: countRows(file.tables) });
  }

  await files.write(`${staged}/register.json`, registerWithout(register));
  // Last, so that a directory with a manifest in it is a directory that
  // finished - which is what the settling below then makes visible all at once.
  await files.write(`${staged}/manifest.json`, {
    takenAt: now().toISOString(),
    environment,
    accounts: taken,
  });
  const warning = await files.settle(staged, out);
  return { accounts: taken, warning };
}

/**
 * The account's name, once it is known to be usable as a file name.
 *
 * **Refused rather than mangled**, because a backup is addressed by the name in
 * it: quietly rewriting `a/b` to `a-b` would produce a file no restore could
 * match back to an account. An account's name is a register id with no
 * constraint on its shape - the rows are written by hand today - so a name
 * carrying a separator or a walk upwards would otherwise put the file outside
 * the staging directory, which is exactly what the staging directory exists to
 * prevent.
 */
function nameAsAFile(account) {
  if (!/^[A-Za-z0-9._-]+$/.test(account) || account === '.' || account === '..') {
    throw new Error(
      `account ${JSON.stringify(account)} cannot be written to a file of its own - ` +
        'an account name has to be letters, digits, dots, dashes and underscores',
    );
  }
  return account;
}

/**
 * That an answer is actually the register.
 *
 * The same guard as `readAccountFile`, on the request that is made *first* and
 * is therefore the likeliest to meet something answering in the environment's
 * place. Without it an answer shaped like anything else reaches `accounts` as
 * `undefined` and throws `is not iterable`, or `Cannot read properties of
 * undefined` on the `--user` path - which is the raw internal error the other
 * guard exists to stop an operator seeing, left in place on the one call that
 * had none.
 */
function readRegister(register) {
  if (!register || typeof register !== 'object' || !Array.isArray(register.accounts)) {
    throw new Error(
      'reading the register got an answer that is not one - is something in front of this environment?',
    );
  }
}

/**
 * That an answer is actually an account's backup.
 *
 * A 200 is not on its own: an edge or a proxy can answer with JSON of its own,
 * and without this the first thing to notice is `Object.values(undefined)`
 * throwing somewhere in the middle - which reads as a bug in this command
 * rather than as an environment answering oddly.
 */
function readAccountFile(file, account) {
  if (!file || typeof file !== 'object' || !file.tables || !Array.isArray(file.changesApplied)) {
    throw new Error(
      `backing up ${account} got an answer that is not a backup - is something in front of this environment?`,
    );
  }
}

/**
 * The register as it goes into its own file. `accounts` is the list the command
 * walked and is recorded in the manifest instead, so the file holds the
 * register's rows and nothing this command worked out.
 */
function registerWithout(register) {
  return { tenants: register.tenants, users: register.users };
}

function countRows(tables) {
  return Object.values(tables).reduce((total, rows) => total + rows.length, 0);
}

function listed(names) {
  return names.length ? names.join(', ') : 'no accounts at all';
}

/**
 * What one answer from an operator route means. Taking a backup meets no status
 * the pair does not share, so it adds nothing to the common reading.
 */
export function readRefusal(answer) {
  return readAnswer(answer);
}
