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

import { readAnswer, readEnvironment, readFlags } from './operator.mjs';

/** What the command was asked to do. */
export function readArguments(argv) {
  const args = readFlags(argv, {
    takes: { '--env': 'environment', '--from': 'from', '--user': 'user' },
    switches: { '--force': 'force' },
  });
  if (!args.environment) throw new Error('--env says which environment to restore into');
  readEnvironment(args.environment);
  if (!args.from) throw new Error('--from says which backup to read');
  return args;
}

/**
 * Whether this target may be written to without being named out loud first.
 *
 * **Only the one running here.** Both deployed environments hold real data
 * nothing re-seeds or wipes (docs/deployment.md, "The environments"), so
 * restoring over either destroys something nobody can put back. Typing the name
 * is a small price against the run that was meant for a local checkout.
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
        `/v1/operator/restore/accounts/${encodeURIComponent(account)}${force ? '?force=true' : ''}`,
        backup.accounts[account],
      );
      done.push({ account, ...written });
      say(`  ${account}: ${written.rowsWritten} rows`);
      // The rows are in and the account is still behind the current version -
      // a success carrying a warning, not a failure. Said loudly because
      // nothing else will: the next request retries it, and until one comes
      // the account is at the shape the backup was taken at.
      if (written.notUpToDate) {
        say(
          `  ${account}: restored, but not yet brought up to date - ${written.notUpToDate}\n` +
            '    Its rows are in. The change list has to apply before anybody can open it.',
        );
      }
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

  try {
    const register = await ask('/v1/operator/restore/register', registerFor(backup, wanted));
    return { accounts: done, ...register };
  } catch (error) {
    // **The same progress report, and this is where it matters most.** By now
    // every account named above has been replaced and cannot be put back, so a
    // refusal here that said only what the register objected to would leave
    // somebody holding an environment they could not describe.
    //
    // What is true at this point is worth spelling out rather than leaving to
    // be worked out: the data is in, the register was not written, and nobody
    // can sign in to it until the disagreement is settled - which is a person's
    // decision about who somebody is, not something to re-run at.
    throw new Error(
      `${error.message}\n\n${describeProgress(done)} Their data is in and cannot be put back. ` +
        'The register was not written, so nobody can sign in to them yet - settle the ' +
        'disagreement above and restore the register on its own.',
    );
  }
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

/**
 * What one refusal from a restore route means, for the route it came from.
 *
 * **The `--force` advice belongs to an account's 409 and to nothing else.**
 * Both routes answer 409 and they mean different things: an account already
 * holding data, which `--force` is exactly the answer to, and a register that
 * disagrees about who somebody is, which has no force and no flag - the
 * environment and the backup name the same person differently, and a command
 * may not decide that.
 *
 * Telling somebody to re-run with `--force` on a register collision is worse
 * than unhelpful, because accounts are restored before the register: following
 * the advice replaces every targeted account's data - past the guard that was
 * protecting it - and then meets the identical refusal.
 */
export function readRefusal(answer, path = '') {
  if (path.endsWith('/restore/register')) return readAnswer(answer);
  return readAnswer(answer, {
    409: (why) => `refused: ${why}\n\nPass --force to replace what is there.`,
  });
}
