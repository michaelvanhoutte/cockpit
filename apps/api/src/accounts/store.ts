import { DurableObject } from 'cloudflare:workers';
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
import { panelTakesItems } from '@cockpit/shared';
import type { Env } from '../env.js';
import type { AccountSnapshot, Answer } from './answer.js';
import type { AccountStoreRpc, RestoreReport } from './rpc.js';
import { accountChanges } from './changes.js';
import {
  CHANGE_LEDGER,
  accountTables,
  describeForeignRowsInBackup,
  foreignRows,
  readStoreAsItStands,
  type AccountBackup,
  type ForeignRow,
} from './backup.js';
import {
  deleteAllRows,
  dropAccountTables,
  storeHoldsAnything,
  tablesParentsFirst,
  writeRows,
} from './restore.js';
import { createAccountDb, type AccountDb } from './client.js';
import { collectInvalidations, watermark } from './events.js';
import {
  DashboardNameTakenError,
  DashboardNotFoundError,
  ItemNotFoundError,
  ItemTypeNameTakenError,
  ItemTypeNotFoundError,
  ItemTypeOrderStaleError,
  LastDashboardError,
  LayoutNotFoundError,
  LayoutSizeTakenError,
  PanelHoldsSomethingElseError,
  PanelNameTakenError,
  PanelNotFoundError,
  PanelOrderStaleError,
  ScreenSizeNameTakenError,
  ScreenSizeNotFoundError,
  UnknownThemeError,
  WorkspaceNameTakenError,
  WorkspaceNotFoundError,
  WorkspaceOrderStaleError,
  runCommand,
} from './command-service.js';
import {
  decisionHistoryForWorkspace,
  getItem,
  getWorkspace,
  listAssociationsForWorkspace,
  listItemTypes,
  listScreenSizes,
  listDashboards,
  listLayoutsInWorkspace,
  listFilingsInWorkspace,
  listOpenItems,
  listPanelsInWorkspace,
  listWorkspaces,
  recentlyCapturedUnfiled,
  unfiledItemsInWorkspace,
} from './repo.js';
import type { DecisionHistoryEntry } from '../domain/decision-history.js';
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
 * layer holds a handle from `openAccount` and calls the operations below; it
 * never reaches a table. That is what made moving the data here mechanical,
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

  /** All live types of the account, in the order they were put in. */
  itemTypes(accountName: string): Answer<ItemType[]> {
    return this.#answer(accountName, (db) => listItemTypes(db, accountName));
  }

  /** All workspaces of the account. */
  workspaces(accountName: string): Answer<Workspace[]> {
    return this.#answer(accountName, (db) => listWorkspaces(db, accountName));
  }

  /** The full read model for one workspace, or `missing` when there is no such workspace. */
  snapshot(accountName: string, workspaceId: string): Answer<AccountSnapshot> {
    return this.#answer(accountName, (db) => {
      // POC (own-event refetch): before every row this answer carries, the
      // workspace included - `watermark` says why the order is the whole safety
      // argument, and the workspace is as much a row it vouches for as the
      // items are.
      const upTo = watermark(db, accountName);
      const workspace = getWorkspace(db, accountName, workspaceId);
      if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
      return {
        upTo,
        workspace,
        items: listOpenItems(db, accountName, workspaceId),
        dashboards: listDashboards(db, accountName, workspaceId),
        panels: listPanelsInWorkspace(db, accountName, workspaceId),
        layouts: listLayoutsInWorkspace(db, accountName, workspaceId),
        filings: listFilingsInWorkspace(db, accountName, workspaceId),
        associations: listAssociationsForWorkspace(db, accountName, workspaceId),
        itemTypes: listItemTypes(db, accountName),
        screenSizes: listScreenSizes(db, accountName),
      };
    });
  }

  /**
   * One item by its id, or null where this account holds no such item.
   *
   * The one read that names an item without a workspace beside it, which is
   * safe for the reason every method here takes the account's name: the query
   * filters on the account, so an id belonging to somebody else matches no row.
   */
  item(accountName: string, itemId: string): Answer<Item | null> {
    return this.#answer(accountName, (db) => getItem(db, accountName, itemId));
  }

  /**
   * Every live Panel of one Workspace that takes items - what a routing
   * proposal may choose from ("Propose where a captured note belongs, without
   * filing it there", issue 298). A Panel of text is excluded here rather
   * than left to the caller, the same rule `MoveToPicker` applies client-side:
   * nothing is ever filed on one, so proposing one would be a chip that can
   * never be taken.
   *
   * `missing` where the Workspace itself has gone, the same as `snapshot`
   * above answers for the same reason: a Workspace's own tombstone leaves its
   * Dashboards and Panels untouched, so without this check a deleted
   * Workspace's Panels would still read as live.
   */
  panelsThatTakeItems(accountName: string, workspaceId: string): Answer<Panel[]> {
    return this.#answer(accountName, (db) => {
      if (!getWorkspace(db, accountName, workspaceId)) throw new WorkspaceNotFoundError(workspaceId);
      return listPanelsInWorkspace(db, accountName, workspaceId).filter(panelTakesItems);
    });
  }

  /**
   * What a routing proposal reads beside the note itself, in one round trip
   * ("Learn where notes belong from where you actually file them", issue
   * 299): the account's whole decision history for one workspace, and what
   * else it has captured lately and not yet filed.
   */
  routingContext(
    accountName: string,
    workspaceId: string,
    excludeItemId: string,
  ): Answer<{ history: DecisionHistoryEntry[]; recentlyCaptured: string[] }> {
    return this.#answer(accountName, (db) => ({
      history: decisionHistoryForWorkspace(db, accountName, workspaceId),
      recentlyCaptured: recentlyCapturedUnfiled(db, accountName, workspaceId, excludeItemId),
    }));
  }

  /**
   * Every item in one Workspace's Inbox with a captured note - the rest of
   * the inbox a settled filing re-proposes ("Re-propose the rest of the
   * inbox the moment you file one", issue 300).
   */
  unfiledItemsInWorkspace(
    accountName: string,
    workspaceId: string,
  ): Answer<{ id: string; workspaceId: string; capturedMessage: string }[]> {
    return this.#answer(accountName, (db) => unfiledItemsInWorkspace(db, accountName, workspaceId));
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
   * The store as it stands, for a backup - the one way in that does **not**
   * bring the account up to date first.
   *
   * Every other method here starts by applying whatever changes are
   * outstanding, which is right when somebody is about to use their data and
   * wrong when a backup is being taken: backing up every account would then
   * wake and migrate all of them at once, turning a read into the riskiest
   * write there is. The reasoning, and what the recorded change list is then
   * for, is in `backup.ts`.
   */
  exportAsItStands(accountName: string): { backup: AccountBackup; foreign: ForeignRow[] } {
    const backup = readStoreAsItStands(this.ctx.storage.sql);
    return { backup, foreign: foreignRows(backup, accountName) };
  }

  /**
   * Puts the account back from a backup, replacing whatever is there.
   *
   * **All of it or none of it.** The drop, the replay, the emptying and the
   * rows are one `transactionSync`, so a restore that fails partway leaves the
   * account exactly as it was - which is the difference between a failed
   * restore and an account holding half of two states with nothing able to say
   * which half.
   *
   * The order is the whole design. Dropping first clears both the rows and the
   * *shape*, since the backup carries a shape of its own. Replaying the change
   * list the backup recorded rebuilds that shape - and puts a new account's
   * starting data in on the way, which is why the tables are emptied before the
   * backup's own rows go in. Bringing the account up to date happens last and
   * outside the transaction, because it is the ordinary path every account
   * takes after a deploy: if it fails there, the store sits at the backup's
   * shape and the next request tries again, which is exactly what would happen
   * to an account nobody had opened yet.
   */
  restoreFrom(
    accountName: string,
    backup: AccountBackup,
    force: boolean,
  ): Answer<RestoreReport> {
    const changes = accountChanges(accountName);
    const unknown = backup.changesApplied.filter(
      (name) => !changes.some((change) => change.name === name),
    );
    if (unknown.length > 0) {
      return {
        status: 'refused',
        what:
          `the backup was taken from a newer version than this one is running: it records ` +
          `${unknown.join(', ')}, which this version does not have. Restore it into a ` +
          `deployment that has them.`,
      };
    }

    const wrong = foreignRows(backup, accountName);
    if (wrong.length > 0) {
      return { status: 'refused', what: describeForeignRowsInBackup(wrong, accountName) };
    }

    const sql = this.ctx.storage.sql;
    const held = accountTables(sql);
    if (!force && storeHoldsAnything(sql, held)) {
      return {
        status: 'conflict',
        what: `account ${accountName} already holds data - restoring over it has to be asked for`,
      };
    }

    // **Counted by whatever did the writing**, not worked out from the file
    // beforehand. The first version of this counted `backup.tables` here, which
    // read as the same number right up until the two disagreed: a table the
    // replayed changes do not create is one `writeRows` cannot write, so a file
    // whose rows outlive their schema was answered with a count saying they had
    // been. `writeRows` now refuses that outright and returns what it did.
    let written = { tablesWritten: 0, rowsWritten: 0 };
    try {
      this.ctx.storage.transactionSync(() => {
        dropAccountTables(sql, tablesParentsFirst(sql, held));
        sql.exec(`DROP TABLE IF EXISTS ${CHANGE_LEDGER}`);

        for (const change of changes.filter((one) => backup.changesApplied.includes(one.name))) {
          for (const statement of change.statements) {
            sql.exec(statement.sql, ...(statement.params ?? []));
          }
        }

        // Worked out once and used three ways - to empty in child-first order
        // and to write in parent-first - rather than rebuilt from the foreign
        // keys for each, which asked SQLite the same question three times over
        // inside an open write transaction.
        const order = tablesParentsFirst(sql, accountTables(sql));
        deleteAllRows(sql, order);
        written = writeRows(sql, backup, order);

        sql.exec(
          `CREATE TABLE IF NOT EXISTS ${CHANGE_LEDGER} (
             name text PRIMARY KEY NOT NULL,
             applied_at text NOT NULL
           ) STRICT`,
        );
        const at = new Date().toISOString();
        for (const name of backup.changesApplied) {
          sql.exec(`INSERT INTO ${CHANGE_LEDGER} (name, applied_at) VALUES (?, ?)`, name, at);
        }
      });
    } catch (error) {
      // **Logged as well as answered.** The body reaching here has been through
      // the route's schema, so what is left to fail is a constraint the rows
      // break - a file somebody edited - and that is the caller's to fix, which
      // is why it answers as a refusal. But it is also where a fault of ours
      // would surface, indistinguishable from the outside, so the underlying
      // error goes to the logs rather than only into somebody's terminal.
      console.error(
        JSON.stringify({
          level: 'error',
          message: `restoring ${accountName} was undone: ${(error as Error).message}`,
        }),
      );
      return { status: 'refused', what: `the restore was undone: ${(error as Error).message}` };
    }

    // The store now believes whatever the backup believed, so the memory of
    // being up to date has to go with it, or the outstanding changes are never
    // applied to what was just written.
    this.#upToDate = false;

    // **A backup of an account nobody had opened restores to one nobody has
    // opened**, rather than to one that has been brought up to date. Bringing
    // it up to date here would create the tables *and* give a new account the
    // workspace, dashboard and panel it starts with, and its standard types -
    // so restoring nothing would produce five rows, and the account would no
    // longer be what the backup held. Left alone, the first request creates it
    // exactly as it does for any account that has never been touched, which is
    // what it was.
    //
    // Found by running the command rather than by a test: the case only shows
    // when a backup covers an account that exists in the register and has never
    // been opened, which is the ordinary state of a newly added user.
    if (backup.changesApplied.length === 0) return { status: 'ok', value: written };

    // **The rows are in, so this answers `ok` however this goes.** Bringing an
    // account up to date is the ordinary path every account takes after a
    // deploy, and it failing here says the change list will not apply - which
    // is true of every account, restored or not, and is fixed by fixing the
    // change list rather than by restoring again.
    //
    // Answering with a failure instead would be the dangerous lie: the drop,
    // the replay and the rows have already committed, so a caller told this
    // account was not restored would re-run believing its data untouched, when
    // it has in fact already been replaced. The warning says what is pending;
    // the next request retries it, exactly as it would for an account nobody
    // had opened yet.
    try {
      this.#bringUpToDate(accountName);
    } catch (error) {
      return {
        status: 'ok',
        value: { ...written, notUpToDate: (error as Error).message },
      };
    }
    return { status: 'ok', value: written };
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
        error instanceof LayoutNotFoundError ||
        error instanceof ScreenSizeNotFoundError
      ) {
        return { status: 'missing', what: error.message };
      }
      if (
        error instanceof WorkspaceNameTakenError ||
        error instanceof DashboardNameTakenError ||
        error instanceof PanelNameTakenError ||
        error instanceof LayoutSizeTakenError ||
        error instanceof ScreenSizeNameTakenError ||
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
        error instanceof PanelOrderStaleError ||
        error instanceof ItemTypeNameTakenError ||
        // The same collision one list along: a whole order sent against a set
        // of types that has moved on.
        error instanceof ItemTypeOrderStaleError
      ) {
        return { status: 'conflict', what: error.message };
      }
      if (
        error instanceof UnknownThemeError ||
        // A 400 rather than a 404 or a 409: the panel exists and nothing is in
        // the way - it is simply not the kind of panel that takes this.
        error instanceof PanelHoldsSomethingElseError
      ) {
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
