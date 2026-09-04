import { DurableObject } from 'cloudflare:workers';
import type { CommandName, CommandPayload, CommandResult, ServerEvent, Workspace } from '@cockpit/shared';
import type { Env } from '../env.js';
import type { AccountSnapshot, Answer } from './answer.js';
import type { AccountStoreRpc } from './rpc.js';
import { accountChanges } from './changes.js';
import { createAccountDb, type AccountDb } from './client.js';
import { collectInvalidations } from './events.js';
import {
  DashboardNameTakenError,
  DashboardNotFoundError,
  ItemNotFoundError,
  ItemTypeNotFoundError,
  LastDashboardError,
  LayoutNotFoundError,
  PanelNameTakenError,
  PanelNotFoundError,
  PanelOrderStaleError,
  UnknownThemeError,
  WorkspaceNameTakenError,
  WorkspaceNotFoundError,
  WorkspaceOrderStaleError,
  runCommand,
} from './command-service.js';
import {
  getWorkspace,
  listAssociationsForWorkspace,
  listItemTypes,
  listDashboards,
  listLayoutsInWorkspace,
  listFilingsInWorkspace,
  listOpenItems,
  listPanelsInWorkspace,
  listWorkspaces,
} from './repo.js';
import { bringUpToDate, type Change } from './up-to-date.js';

/**
 * One account's data, in one Durable Object: its workspaces, items,
 * associations and change log. Reached by account name at runtime
 * (`env.ACCOUNT.idFromName(name)`), created on first touch, named nowhere in
 * configuration - which is the whole reason this shape was chosen over a
 * database per account (see
 * [account-storage-options.md](../../../../docs/account-storage-options.md)).
 *
 * **Nothing outside `src/accounts/` talks to an account's data.** The HTTP
 * layer holds a handle from `openAccount` and calls the four operations below;
 * it never reaches a table. That is what made moving the data here mechanical,
 * and it is what keeps the next move cheap.
 *
 * Every call brings the account up to date first. It costs nothing after the
 * first one - the object stays in memory and remembers - and on the first call
 * after a deploy it is the only moment an outstanding change can be applied,
 * because no deploy step can reach an object that does not exist yet.
 */
export class AccountStore extends DurableObject<Env> implements AccountStoreRpc {
  #db: AccountDb | null = null;
  #upToDate = false;

  /** All workspaces of the account. */
  workspaces(accountName: string): Answer<Workspace[]> {
    return this.#answer(accountName, (db) => listWorkspaces(db, accountName));
  }

  /** The full read model for one workspace, or `missing` when there is no such workspace. */
  snapshot(accountName: string, workspaceId: string): Answer<AccountSnapshot> {
    return this.#answer(accountName, (db) => {
      const workspace = getWorkspace(db, accountName, workspaceId);
      if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
      return {
        workspace,
        items: listOpenItems(db, accountName, workspaceId),
        dashboards: listDashboards(db, accountName, workspaceId),
        panels: listPanelsInWorkspace(db, accountName, workspaceId),
        layouts: listLayoutsInWorkspace(db, accountName, workspaceId),
        filings: listFilingsInWorkspace(db, accountName, workspaceId),
        associations: listAssociationsForWorkspace(db, accountName, workspaceId),
        itemTypes: listItemTypes(db, accountName),
      };
    });
  }

  /** What has changed since `since`, for the live-updates stream the Worker holds open. */
  changesSince(
    accountName: string,
    since: string,
  ): Answer<{ events: ServerEvent[]; cursor: string }> {
    return this.#answer(accountName, (db) => collectInvalidations(db, accountName, since));
  }

  /** Applies one change to the account, idempotently. */
  applyChange<N extends CommandName>(
    accountName: string,
    name: N,
    payload: CommandPayload<N>,
  ): Answer<CommandResult> {
    return this.#answer(accountName, (db) => runCommand(db, accountName, name, payload));
  }

  /**
   * Brings the account up to date, then does the work - and turns the two
   * things a caller has to be able to tell apart into an answer rather than an
   * exception, because a Durable Object's exceptions reach the Worker as an
   * `Error` with nothing left on it to branch on.
   */
  #answer<T>(accountName: string, work: (db: AccountDb) => T): Answer<T> {
    try {
      this.#bringUpToDate(accountName);
    } catch (error) {
      return { status: 'not-up-to-date', failure: (error as Error).message };
    }
    try {
      return { status: 'ok', value: work(this.#database()) };
    } catch (error) {
      if (
        error instanceof ItemNotFoundError ||
        error instanceof ItemTypeNotFoundError ||
        error instanceof WorkspaceNotFoundError ||
        error instanceof DashboardNotFoundError ||
        error instanceof PanelNotFoundError ||
        error instanceof LayoutNotFoundError
      ) {
        return { status: 'missing', what: error.message };
      }
      if (
        error instanceof WorkspaceNameTakenError ||
        error instanceof DashboardNameTakenError ||
        error instanceof PanelNameTakenError ||
        // A refusal to say out loud rather than a shape problem: the request is
        // well formed and names a dashboard that exists, and the answer is that
        // this one may not go.
        error instanceof LastDashboardError ||
        // Not a missing workspace, even though a deleted one is the likeliest
        // way to get here: what has collided is the whole list against a list
        // of workspaces that has moved on.
        error instanceof WorkspaceOrderStaleError ||
        // Same kind of collision one level down: a whole order sent against a
        // panel whose items have moved on.
        error instanceof PanelOrderStaleError
      ) {
        return { status: 'conflict', what: error.message };
      }
      if (error instanceof UnknownThemeError) {
        return { status: 'refused', what: error.message };
      }
      throw error;
    }
  }

  #database(): AccountDb {
    this.#db ??= createAccountDb(this.ctx.storage);
    return this.#db;
  }

  /**
   * Applies every change this account has not applied yet, one transaction per
   * change, so a change that fails leaves nothing of itself behind and is
   * retried whole next time. The record of what has run is this store's own,
   * created before the first change because nothing else can create it.
   */
  #bringUpToDate(accountName: string): void {
    if (this.#upToDate) return;

    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS account_changes (
         name text PRIMARY KEY NOT NULL,
         applied_at text NOT NULL
       ) STRICT`,
    );
    const applied = this.ctx.storage.sql
      .exec<{ name: string }>('SELECT name FROM account_changes')
      .toArray()
      .map((row) => row.name);

    bringUpToDate(accountName, accountChanges(accountName), applied, (change) => {
      this.ctx.storage.transactionSync(() => this.#apply(change));
    });

    this.#upToDate = true;
  }

  #apply(change: Change): void {
    for (const statement of change.statements) {
      this.ctx.storage.sql.exec(statement.sql, ...(statement.params ?? []));
    }
    this.ctx.storage.sql.exec(
      'INSERT INTO account_changes (name, applied_at) VALUES (?, ?)',
      change.name,
      new Date().toISOString(),
    );
  }
}
