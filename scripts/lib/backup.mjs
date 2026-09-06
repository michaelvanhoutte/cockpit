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
  const worker = WORKERS[environment];
  if (!worker) {
    throw new Error(
      `no environment ${environment} - it is one of local, staging or production`,
    );
  }
  if (!subdomain) {
    throw new Error(
      `backing up ${environment} needs CLOUDFLARE_WORKERS_SUBDOMAIN, the workers.dev subdomain it is served from`,
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
  const takes = { '--env': 'environment', '--out': 'out', '--user': 'user' };
  const args = { environment: undefined, out: undefined, user: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const field = takes[flag];
    if (!field) {
      throw new Error(`there is no ${flag} - the flags are --env, --out and --user`);
    }
    const value = argv[i + 1];
    // A flag with nothing after it, rather than one silently taking the next
    // flag as its value - which is how `--user --out x` would quietly back up
    // an account called `--out`.
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} was given nothing to go with it`);
    }
    // Said rather than taking the last quietly: the two environments differ in
    // exactly the way that makes being surprised by which one was read
    // expensive.
    if (args[field] !== undefined) {
      throw new Error(`${flag} was given twice - it takes one value`);
    }
    args[field] = value;
  }
  if (!args.environment) throw new Error('--env says which environment to back up');
  if (!args.out) throw new Error('--out says where to write the backup');
  return args;
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
  const register = await ask('/v1/admin/backup/register');
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
    const file = await ask(`/v1/admin/backup/accounts/${encodeURIComponent(account)}`);
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
  await files.settle(staged, out);
  return { accounts: taken };
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
 * What one answer from an operator route means.
 *
 * The two that are worth telling apart by hand are the secret and the account,
 * because they are the two things somebody typed. Everything else is reported
 * as it arrived rather than translated, since a backup that stops is going to
 * be read by whoever ran it.
 */
export function readRefusal({ status, body }) {
  if (status === 401) {
    return (
      'refused: the operator secret was not accepted. It is BACKUP_TOKEN, set per ' +
      'environment with `wrangler secret put BACKUP_TOKEN`, and given to this command ' +
      'as COCKPIT_BACKUP_TOKEN.'
    );
  }
  // A name that is not there, and a store holding somebody else's rows: both
  // are the environment saying no for a reason it has already put in words.
  if (status === 404 || status === 409) return `refused: ${message(body)}`;
  if (status === 0) return 'nothing answered - is the environment up, and the address right?';
  return `answered ${status}: ${message(body)}`;
}

function message(body) {
  try {
    return JSON.parse(body).error ?? body;
  } catch {
    return body;
  }
}
