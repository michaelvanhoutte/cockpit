import type {
  CommandName,
  CommandPayload,
  CommandResult,
  ItemType,
  ServerEvent,
  Workspace,
} from '@cockpit/shared';
import type { Env } from '../env.js';
import { accountIsRegistered } from './register.js';
import { describeForeignRows, type AccountBackup } from './backup.js';
import type { AccountSnapshot, Answer } from './answer.js';

export type { AccountSnapshot } from './answer.js';
export type { AccountBackup } from './backup.js';
export {
  RegisterDisagreesError,
  registerContents,
  registeredAccountNames,
  restoreRegister,
} from './register.js';
export type { RegisterBackup, RegisterPlan } from './register.js';

/** The account is not in the register, so it has no data and never had any. */
export class AccountNotInRegisterError extends Error {
  constructor(accountName: string) {
    super(`account ${accountName} is not in the register`);
    this.name = 'AccountNotInRegisterError';
  }
}

/** A change to the account's store could not be applied; the message says which and why. */
export class AccountNotUpToDateError extends Error {
  constructor(failure: string) {
    super(failure);
    this.name = 'AccountNotUpToDateError';
  }
}

/** Something the change would create is already in the account under that name. */
export class ConflictInAccountError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'ConflictInAccountError';
  }
}

/** The request named something the product does not offer - not a collision, just not on the menu. */
export class RefusedByAccountError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'RefusedByAccountError';
  }
}

/** Something a request named does not exist in the account. */
export class NotFoundInAccountError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'NotFoundInAccountError';
  }
}

/**
 * Everything the rest of the Worker may do with an account's data. Reading and
 * writing it goes through here and nowhere else, which is what let the data
 * move stores without an excavation.
 */
export interface Account {
  workspaces(): Promise<Workspace[]>;
  snapshot(workspaceId: string): Promise<AccountSnapshot>;
  /** The account's live types, in the order they were put in. */
  itemTypes(): Promise<ItemType[]>;
  changesSince(since: string): Promise<{ events: ServerEvent[]; cursor: string }>;
  applyChange<N extends CommandName>(
    name: N,
    payload: CommandPayload<N>,
  ): Promise<CommandResult>;
}

/**
 * Resolves an account to its store: check the register, then address the store
 * by name.
 *
 * **The name comes from whoever is signed in** (`src/auth/gate.ts`), which is
 * what the constant that used to stand here promised would be the only line to
 * change when signing in landed - and it was. Nothing below moved: this already
 * took the account's name as an argument, looked it up in the register and
 * addressed the store by it.
 *
 * There is deliberately no "the store is not configured" failure here.
 * Addressing a store by account name cannot fail - one binding names the whole
 * namespace and every account is a name inside it - so being absent from the
 * register is the only way to miss, which is one failure mode fewer than a
 * database per account would have had.
 */
export async function openAccount(env: Env, accountName: string): Promise<Account> {
  if (!(await accountIsRegistered(env, accountName))) {
    throw new AccountNotInRegisterError(accountName);
  }
  const store = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountName));

  return {
    workspaces: async () => unwrap(await store.workspaces(accountName)),
    itemTypes: async () => unwrap(await store.itemTypes(accountName)),
    snapshot: async (workspaceId) => unwrap(await store.snapshot(accountName, workspaceId)),
    changesSince: async (since) => unwrap(await store.changesSince(accountName, since)),
    applyChange: async (name, payload) => unwrap(await store.applyChange(accountName, name, payload)),
  };
}

/** A store held a row belonging to another account, so nothing was backed up. */
export class RowsFromAnotherAccountError extends Error {
  constructor(what: string) {
    super(what);
    this.name = 'RowsFromAnotherAccountError';
  }
}

/**
 * One account's store as it stands, for a backup.
 *
 * Separate from `openAccount` rather than a sixth method on `Account`, for the
 * two reasons that make a backup different from use: it must not bring the
 * account up to date (`backup.ts`), and it names the account it wants instead
 * of taking whoever is signed in - there being nobody signed in when an
 * operator takes a backup.
 *
 * The register is still what says an account is real, exactly as it does for
 * `openAccount`: a store is addressed by name and `idFromName` hands back an
 * empty one for a name nobody ever created, so without this a typo would back
 * up an account that does not exist and report nothing wrong.
 */
export async function backUpAccount(env: Env, accountName: string): Promise<AccountBackup> {
  if (!(await accountIsRegistered(env, accountName))) {
    throw new AccountNotInRegisterError(accountName);
  }
  const store = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountName));
  const { backup, foreign } = await store.exportAsItStands(accountName);
  if (foreign.length > 0) {
    throw new RowsFromAnotherAccountError(describeForeignRows(foreign, accountName));
  }
  return backup;
}

/**
 * Puts one account's store back from a backup.
 *
 * **The register is deliberately not consulted**, which is the one place this
 * differs from `backUpAccount` beside it. An account's store is restored
 * *before* its register row is written, so that a user never exists pointing at
 * data that has not arrived - which means at this moment the account is
 * routinely not in the register yet, and requiring it would make restoring into
 * an empty environment impossible.
 *
 * What stands in for that check is the backup itself: the names come from the
 * file rather than from anybody typing, and every row in it has to carry the
 * name of the account it is going into (`restore.ts`), so a file cannot be
 * poured into the wrong store.
 */
export async function restoreAccount(
  env: Env,
  accountName: string,
  backup: AccountBackup,
  force: boolean,
): Promise<{ tablesWritten: number; rowsWritten: number }> {
  const store = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountName));
  return unwrap(await store.restoreFrom(accountName, backup, force));
}

/** Turns the store's answer back into a value or the error that belongs to it. */
function unwrap<T>(answer: Answer<T>): T {
  switch (answer.status) {
    case 'ok':
      return answer.value;
    case 'missing':
      throw new NotFoundInAccountError(answer.what);
    case 'conflict':
      throw new ConflictInAccountError(answer.what);
    case 'refused':
      throw new RefusedByAccountError(answer.what);
    case 'not-up-to-date':
      throw new AccountNotUpToDateError(answer.failure);
  }
}
