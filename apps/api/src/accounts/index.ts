import type {
  CommandName,
  CommandPayload,
  CommandResult,
  Item,
  ItemType,
  Panel,
  ServerEvent,
  Workspace,
} from '@cockpit/shared';
import type { Env } from '../env.js';
import { GUEST_ACCOUNT_NAME } from '../auth/register.js';
import { accountIsRegistered } from './register.js';
import { describeForeignRows, type AccountBackup } from './backup.js';
import type { RestoreReport } from './rpc.js';
import type { AccountSnapshot, Answer } from './answer.js';
import type { DecisionHistoryEntry } from '../domain/decision-history.js';

export type { AccountSnapshot } from './answer.js';
export type { AccountBackup } from './backup.js';
export {
  RegisterDisagreesError,
  RegisterRowUnusableError,
  addUser,
  changeUser,
  registerContents,
  registeredAccountNames,
  registeredUsers,
  restoreRegister,
  setAccess,
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
  /**
   * One Item by its id, or null where this account holds no such Item - which
   * an id belonging to another account also is, every query filtering on the
   * account. Read by the enrichment job and by nothing else (issue 296): a
   * browser holds the whole workspace and has no reason to ask for one row.
   */
  item(itemId: string): Promise<Item | null>;
  /**
   * Every live Panel of one Workspace that takes items - what a routing
   * proposal may choose from ("Propose where a captured note belongs, without
   * filing it there", issue 298). Read by the enrichment job and by nothing
   * else.
   */
  panelsThatTakeItems(workspaceId: string): Promise<Panel[]>;
  /**
   * What a routing proposal reads beside the note itself, in one round trip
   * ("Learn where notes belong from where you actually file them", issue
   * 299): the account's whole decision history for one workspace, oldest
   * first, what else it has captured lately and not yet filed, most recent
   * first, `excludeItemId` left out, and the Workspace's own live correction
   * of what the system otherwise learned, or null ("Show what the system
   * learned, in a sentence you can correct", issue 301). Read by the
   * enrichment job and by nothing else.
   */
  routingContext(
    workspaceId: string,
    excludeItemId: string,
  ): Promise<{ history: DecisionHistoryEntry[]; recentlyCaptured: string[]; correction: string | null }>;
  /**
   * One Workspace's whole decision history alone, oldest first - what the
   * nightly summary job reads ("Show what the system learned, in a sentence
   * you can correct", issue 301). Read by that job and by nothing else.
   */
  decisionHistory(workspaceId: string): Promise<DecisionHistoryEntry[]>;
  /**
   * Every item in one Workspace's Inbox with a captured note - the rest of
   * the inbox a settled filing re-proposes ("Re-propose the rest of the
   * inbox the moment you file one", issue 300). Read by the enrichment job
   * and by nothing else, the same as `panelsThatTakeItems` above.
   */
  unfiledItemsInWorkspace(
    workspaceId: string,
  ): Promise<{ id: string; workspaceId: string; capturedMessage: string; proposedPanelId: string | null }[]>;
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
    item: async (itemId) => unwrap(await store.item(accountName, itemId)),
    panelsThatTakeItems: async (workspaceId) =>
      unwrap(await store.panelsThatTakeItems(accountName, workspaceId)),
    routingContext: async (workspaceId, excludeItemId) =>
      unwrap(await store.routingContext(accountName, workspaceId, excludeItemId)),
    decisionHistory: async (workspaceId) => unwrap(await store.decisionHistory(accountName, workspaceId)),
    unfiledItemsInWorkspace: async (workspaceId) =>
      unwrap(await store.unfiledItemsInWorkspace(accountName, workspaceId)),
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
 * **What stands in for that check is the route, not this function.** A backup
 * carries the name it was taken from, and `http/app.ts` refuses one whose name
 * is not the account it is going into. That is what stops a file reaching the
 * wrong store; the rows' own `tenant_id` (`foreignRows`) is a second lock
 * behind it and not a substitute, because it can only disagree with rows that
 * exist - a backup of an account nobody has opened has none, and used to pass
 * straight through into whichever store was named.
 */
export async function restoreAccount(
  env: Env,
  accountName: string,
  backup: AccountBackup,
  force: boolean,
): Promise<RestoreReport> {
  const store = env.ACCOUNT.get(env.ACCOUNT.idFromName(accountName));
  return unwrap(await store.restoreFrom(accountName, backup, force));
}

/**
 * Puts the guest account back to its demonstration - the one reset both the
 * operator's route and the nightly run call ("Reset the guest account to its
 * seeded state", issue 356).
 *
 * **Takes no account, so no caller can point it at one.** The guest's store is
 * the only one this addresses; whether that store really is the guest's is
 * checked inside it (`resetGuest`, store.ts).
 *
 * **An environment with no guest account resets nothing and creates nothing.**
 * Addressing a store by name makes one, so without the register check the
 * nightly run would build a demonstration in staging - where guest sign-in is
 * refused (`GUEST_SIGN_IN`) - for nobody to open.
 */
export async function resetGuestAccount(env: Env): Promise<'reset' | 'no guest account'> {
  if (!(await accountIsRegistered(env, GUEST_ACCOUNT_NAME))) return 'no guest account';
  const store = env.ACCOUNT.get(env.ACCOUNT.idFromName(GUEST_ACCOUNT_NAME));
  unwrap(await store.resetGuest());
  return 'reset';
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
