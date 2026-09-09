import type { Rpc } from '@cloudflare/workers-types';
import type {
  CommandName,
  CommandPayload,
  CommandResult,
  Item,
  ItemType,
  ServerEvent,
  Workspace,
} from '@cockpit/shared';
import type { AccountSnapshot, Answer } from './answer.js';
import type { AccountBackup, ForeignRow } from './backup.js';

/**
 * What one account's store answers to, as the Worker sees it across the
 * binding.
 *
 * Written out here rather than inferred from the class, for one reason that is
 * not about taste: `store.ts` imports `DurableObject` from `cloudflare:workers`,
 * a module that only exists inside the Workers runtime's own type definitions.
 * `apps/web` compiles this package's source to infer the API contract, and it
 * cannot resolve that module - so the type the binding is declared with has to
 * be reachable without it. `AccountStore implements AccountStoreRpc` is what
 * keeps the two honest.
 *
 * Every method takes the account's name. Redundant, since the object *is* the
 * account - and that is the point: it is what every query filters on, so a
 * request that reached the wrong store matches no row instead of answering with
 * somebody else's data.
 *
 * The return types allow the value or a promise for it, because the object's
 * own SQLite is synchronous while the caller always awaits across the binding.
 */
export interface AccountStoreRpc extends Rpc.DurableObjectBranded {
  workspaces(accountName: string): Awaitable<Answer<Workspace[]>>;
  itemTypes(accountName: string): Awaitable<Answer<ItemType[]>>;
  snapshot(accountName: string, workspaceId: string): Awaitable<Answer<AccountSnapshot>>;
  /**
   * One Item by its id, or null where the account holds no such Item.
   *
   * Null rather than `missing`, unlike every read above that names something:
   * the only caller is a background job holding an id from minutes ago (issue
   * 296), for which an Item that has since been dismissed and erased - or one
   * that was never in this account, which matches no row because every query
   * filters on the account - is the ordinary case and not a failure to report.
   */
  item(accountName: string, itemId: string): Awaitable<Answer<Item | null>>;
  changesSince(
    accountName: string,
    since: string,
  ): Awaitable<Answer<{ events: ServerEvent[]; cursor: string }>>;
  applyChange<N extends CommandName>(
    accountName: string,
    name: N,
    payload: CommandPayload<N>,
  ): Awaitable<Answer<CommandResult>>;
  /**
   * The store as it stands, for a backup.
   *
   * **Not an `Answer`, unlike everything above.** The three things an `Answer`
   * exists to carry cannot happen here: nothing is named that could be missing,
   * nothing is created that could collide, and there is no bringing up to date
   * to fail - this deliberately skips it, so that backing up every account does
   * not migrate every account (`backup.ts`).
   *
   * `foreign` is separate from the backup rather than thrown, because what to
   * do about a row belonging to somebody else is the caller's to decide and the
   * rows are worth naming either way.
   */
  exportAsItStands(accountName: string): Awaitable<{
    backup: AccountBackup;
    foreign: ForeignRow[];
  }>;
  /**
   * Puts the account back from a backup, replacing whatever is there.
   *
   * An `Answer` again, unlike the export beside it, because every one of its
   * states can happen: a store that already holds data is a `conflict`, a
   * backup from a newer version or carrying another account's rows is
   * `refused`, and the changes still outstanding after the rows go in can fail
   * to apply exactly as they can for any other account.
   */
  restoreFrom(
    accountName: string,
    backup: AccountBackup,
    force: boolean,
  ): Awaitable<Answer<RestoreReport>>;
}

type Awaitable<T> = T | Promise<T>;

/**
 * What a restore did.
 *
 * `notUpToDate` is a warning on a success rather than a failure: by the time it
 * can be set, the rows are already committed. Saying the restore failed would
 * send somebody to re-run it believing the account untouched, when it has
 * already been replaced - see `restoreFrom` in `store.ts`.
 */
export interface RestoreReport {
  tablesWritten: number;
  rowsWritten: number;
  /** Why the account is still behind the current version, where it is. */
  notUpToDate?: string;
}
