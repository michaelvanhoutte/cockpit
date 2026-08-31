import type { CommandName, CommandPayload, CommandResult, ServerEvent, Workspace } from '@cockpit/shared';
import type { Env } from '../env.js';
import { accountIsRegistered } from './register.js';
import type { AccountSnapshot, Answer } from './answer.js';

export type { AccountSnapshot } from './answer.js';

/**
 * The single account this application has. Nobody can choose one yet - signing
 * in is its own piece of work, kept separate from this move on purpose, since a
 * storage change and an authentication change debugged together is two
 * unknowns - so until it lands the name comes from here.
 *
 * What changes when it lands is *this line only*. Everything below already
 * takes the account's name as an argument, looks it up in the register and
 * addresses its store by it, so a session supplying the name instead of a
 * constant changes nothing else - which is the claim the constant in the old
 * `tenancy.ts` made while nothing was in a position to keep it.
 */
export const CURRENT_ACCOUNT_NAME = 'tenant-default';

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
    snapshot: async (workspaceId) => unwrap(await store.snapshot(accountName, workspaceId)),
    changesSince: async (since) => unwrap(await store.changesSince(accountName, since)),
    applyChange: async (name, payload) => unwrap(await store.applyChange(accountName, name, payload)),
  };
}

/** Turns the store's answer back into a value or the error that belongs to it. */
function unwrap<T>(answer: Answer<T>): T {
  switch (answer.status) {
    case 'ok':
      return answer.value;
    case 'missing':
      throw new NotFoundInAccountError(answer.what);
    case 'not-up-to-date':
      throw new AccountNotUpToDateError(answer.failure);
  }
}
