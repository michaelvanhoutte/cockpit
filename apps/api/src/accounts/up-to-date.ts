/**
 * Bringing one account's store up to date: a list of changes, a record of
 * which have already run, and an executor that applies one of them.
 *
 * The executor is injected, which is what makes the deciding part pure - it
 * has no storage, no clock and no Durable Object in it, so every branch below
 * is provable at L1 (apps/api/tests/unit/accounts/up-to-date.test.ts).
 *
 * **Why this is not `drizzle-orm/durable-sqlite/migrator`.** That migrator
 * wraps the whole run in one transaction and, when a statement fails, calls
 * `tx.rollback()` - which throws `TransactionRollbackError: Rollback` and
 * *replaces* the real error. The account storage decision measured exactly
 * that (see [account-storage-options.md](../../../../docs/account-storage-options.md),
 * "A migration that cannot apply"): the SQL error reaches neither the response
 * nor the logs, so the first schema change that goes wrong in production says
 * only "Rollback" while every account fails one at a time as it wakes. Saying
 * which change failed and why is the whole reason this file exists.
 */

/** One SQL statement of a change, with any values it binds. */
export interface Statement {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

/** One change to an account's store: a name it is recorded under, and its statements in order. */
export interface Change {
  readonly name: string;
  readonly statements: readonly Statement[];
}

/**
 * A change that could not be applied, named, with the underlying cause kept
 * rather than swallowed. The message is what a caller is shown and what is
 * logged, so it carries both halves.
 */
export class ChangeFailedError extends Error {
  constructor(
    readonly accountName: string,
    readonly changeName: string,
    cause: unknown,
  ) {
    super(
      `account ${accountName} could not be brought up to date: change ${changeName} failed: ${describe(cause)}`,
      { cause },
    );
    this.name = 'ChangeFailedError';
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Applies every change the account has not applied yet, in order.
 *
 * `applyOne` has to be atomic per change - the statements and the record that
 * they ran, together - so that a change which fails partway leaves nothing of
 * itself behind and is retried whole the next time the account is opened.
 *
 * @returns the names applied by this call, oldest first
 * @throws ChangeFailedError naming the first change that could not be applied
 */
export function bringUpToDate(
  accountName: string,
  changes: readonly Change[],
  alreadyApplied: Iterable<string>,
  applyOne: (change: Change) => void,
): string[] {
  const applied = new Set(alreadyApplied);
  const justApplied: string[] = [];

  for (const change of changes) {
    if (applied.has(change.name)) continue;
    try {
      applyOne(change);
    } catch (cause) {
      throw new ChangeFailedError(accountName, change.name, cause);
    }
    justApplied.push(change.name);
  }

  return justApplied;
}
