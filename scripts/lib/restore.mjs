//
// Everything `pnpm backup:restore` decides, with the reading, the asking and
// the confirming injected - the same shape as backup.mjs beside it.
//
// This is the half that destroys something, so the ordering below is the
// design rather than an implementation detail. It is written out in "Restore an
// environment, or one user, from a backup" (issue 209), and the two rules that
// matter here:
//
//   - **Accounts go in before the register**, so a user never exists pointing
//     at a store that has not arrived.
//   - **A run across several accounts is not one transaction.** Each account's
//     own load is all-or-nothing, and nothing joins them, so a failure stops at
//     once and says which accounts went in and which did not - the alternative
//     is carrying on and leaving somebody to work out how far it got.
//

/** What the command was asked to do. */
export function readArguments(argv) {
  const takes = { '--env': 'environment', '--from': 'from', '--user': 'user' };
  const flags = { '--force': 'force' };
  const args = { environment: undefined, from: undefined, user: undefined, force: false };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flags[flag]) {
      args[flags[flag]] = true;
      continue;
    }
    const field = takes[flag];
    if (!field) {
      throw new Error(`there is no ${flag} - the flags are --env, --from, --user and --force`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} was given nothing to go with it`);
    }
    if (args[field] !== undefined) {
      throw new Error(`${flag} was given twice - it takes one value`);
    }
    args[field] = value;
    i += 1;
  }

  if (!args.environment) throw new Error('--env says which environment to restore into');
  if (!args.from) throw new Error('--from says which backup to read');
  return args;
}

/**
 * Whether this target may be written to without being named out loud first.
 *
 * **Only the one running here.** Staging is deliberately never re-seeded, so
 * what has accumulated in it is the point of it, and production holds the only
 * copy of anything real - restoring over either destroys something nobody can
 * put back. Typing the name is a small price against the run that was meant for
 * a local checkout.
 */
export function needsSayingOutLoud(environment) {
  return environment !== 'local';
}

/**
 * Reads a backup off disk, refusing one that is not whole.
 *
 * A directory with no manifest is a run that did not finish - the manifest is
 * written last for exactly this reason - and restoring from one would put back
 * however many accounts happened to be written before it stopped.
 */
export function readBackup({ manifest, register, accounts }) {
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.accounts)) {
    throw new Error(
      'that directory has no manifest, so it is a backup that did not finish rather than one to restore from',
    );
  }
  if (!register || !Array.isArray(register.tenants) || !Array.isArray(register.users)) {
    throw new Error('that backup has no register in it');
  }
  const missing = manifest.accounts
    .map((one) => one.account)
    .filter((name) => !Object.prototype.hasOwnProperty.call(accounts, name));
  if (missing.length > 0) {
    throw new Error(
      `that backup's manifest names ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in it`,
    );
  }
  return { manifest, register, accounts };
}

/**
 * Puts a backup back: the accounts first, then the register.
 *
 * `only` restores one account out of the backup, and the register rows that go
 * with it - just that user and just their account, so restoring one person into
 * a shared environment does not bring everybody else's row along.
 */
export async function putBack({ ask, backup, only, force, say = () => {} }) {
  const wanted = only ? [only] : Object.keys(backup.accounts);
  if (only && !Object.prototype.hasOwnProperty.call(backup.accounts, only)) {
    throw new Error(
      `no account ${only} in this backup - it holds ${listed(Object.keys(backup.accounts))}`,
    );
  }

  const done = [];
  for (const account of wanted) {
    try {
      const written = await ask(
        `/v1/admin/restore/accounts/${encodeURIComponent(account)}${force ? '?force=true' : ''}`,
        backup.accounts[account],
      );
      done.push({ account, ...written });
      say(`  ${account}: ${written.rowsWritten} rows`);
    } catch (error) {
      // Stopped at the first failure rather than carried on, and what did go in
      // is named: a run that reports only its last error leaves somebody to
      // work out how far it got against a backup they can no longer trust.
      throw new Error(
        `${error.message}\n\nStopped there. ${describeProgress(done)} ` +
          'The register was not touched, so nobody can sign in to a half-restored account.',
      );
    }
  }

  const register = await ask('/v1/admin/restore/register', registerFor(backup, wanted));
  return { accounts: done, ...register };
}

/**
 * The register rows the accounts being restored need, and no others. Restoring
 * one person into a shared environment should not bring everybody else's row.
 */
function registerFor(backup, wanted) {
  const accounts = new Set(wanted);
  return {
    tenants: backup.register.tenants.filter((row) => accounts.has(row.id)),
    users: backup.register.users.filter((row) => accounts.has(row.account_id)),
  };
}

function describeProgress(done) {
  if (done.length === 0) return 'Nothing was restored.';
  return `Restored: ${done.map((one) => one.account).join(', ')}.`;
}

function listed(names) {
  return names.length ? names.join(', ') : 'no accounts at all';
}

/** What one refusal from a restore route means, in the words that help. */
export function readRefusal({ status, body }) {
  if (status === 401) {
    return (
      'refused: the operator secret was not accepted. It is BACKUP_TOKEN, set per ' +
      'environment with `wrangler secret put BACKUP_TOKEN`, and given to this command ' +
      'as COCKPIT_BACKUP_TOKEN.'
    );
  }
  if (status === 409) return `refused: ${message(body)}\n\nPass --force to replace what is there.`;
  if (status === 400) return `refused: ${message(body)}`;
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
