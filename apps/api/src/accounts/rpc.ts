import type { Rpc } from '@cloudflare/workers-types';
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
import type { AccountSnapshot, Answer } from './answer.js';
import type { AccountBackup, ForeignRow } from './backup.js';
import type { AttachmentForDownload } from '../domain/attachments.js';
import type { DecisionHistoryEntry } from '../domain/decision-history.js';
import type { PinnedExampleEntry } from '../domain/pinned-text-examples.js';
import type { QueuedRewriteAttempt, RewriteHistoryEntryRow, RewriteOutcome } from '../domain/rewrite-history.js';
import type { TextCorrectionEntry, WhatStood } from '../domain/text-corrections.js';

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
  /**
   * One attachment by its id, with the R2 key its bytes are stored under -
   * what the download route reads ("Attach a file to an item", issue 441).
   * Null rather than `missing`, for the same reason `item` above answers
   * null: the download route answers 404 either way.
   */
  attachmentForDownload(
    accountName: string,
    attachmentId: string,
  ): Awaitable<Answer<AttachmentForDownload | null>>;
  /**
   * Whether this account already has an attachment by this id, checked by
   * the upload route before it ever writes to R2 ("Attach a file to an
   * item", issue 441) - see `store.ts`'s own comment on why.
   */
  attachmentExists(accountName: string, attachmentId: string): Awaitable<Answer<boolean>>;
  /**
   * Every live Panel that takes items, in one Workspace - what a routing
   * proposal may choose from ("Propose where a captured note belongs, without
   * filing it there", issue 298). Read by the enrichment job and by nothing
   * else: a browser already has the full snapshot, panels of text included.
   */
  panelsThatTakeItems(accountName: string, workspaceId: string): Awaitable<Answer<Panel[]>>;
  /**
   * What a routing proposal reads beside the note itself: the most recent 50
   * settled decisions for one workspace whose chosen panel still exists,
   * oldest first, and what else it has captured lately and not yet filed,
   * most recent first, `excludeItemId` left out ("Learn where notes belong
   * from where you actually file them", issue 299; "Cap the routing prompt
   * to the last 50 decisions on panels that still exist, and drop the
   * correction override", issue 450). One round trip for both, since nothing
   * ever reads one without the other - the same reasoning `snapshot` above
   * already carries several reads in one answer. Read by the enrichment job
   * and by nothing else, the same as `panelsThatTakeItems` beside it.
   */
  routingContext(
    accountName: string,
    workspaceId: string,
    excludeItemId: string,
  ): Awaitable<Answer<{ history: DecisionHistoryEntry[]; recentlyCaptured: string[] }>>;
  /**
   * What a title or description proposal reads about how this account
   * writes: the rules it has written for itself, every correction it has
   * ever made, and how many of its other proposals simply stood ("Learn how
   * you write from the titles you correct", issue 394; "Show what Cockpit is
   * told, and say how you want it changed", issue 398). Per account, not per
   * workspace. Read by the enrichment job for the prompt, the same as
   * `routingContext` above, and by the HTTP layer for the window that shows
   * how it is doing.
   */
  textLearningContext(accountName: string): Awaitable<
    Answer<{
      rules: string | null;
      rulesSetAt: string | null;
      corrections: TextCorrectionEntry[];
      stood: WhatStood;
      pinnedExamples: PinnedExampleEntry[];
    }>
  >;
  /**
   * Every item in one workspace's Inbox with a captured note - what a
   * settled filing re-proposes the panel for ("Re-propose the rest of the
   * inbox the moment you file one", issue 300). Read by that job and by
   * nothing else, the same as `panelsThatTakeItems` and `routingContext`
   * above.
   */
  unfiledItemsInWorkspace(
    accountName: string,
    workspaceId: string,
  ): Awaitable<Answer<{ id: string; workspaceId: string; capturedMessage: string; proposedPanelId: string | null }[]>>;
  /**
   * Every item in the whole account with a captured note whose texts nobody
   * has settled - what a correction re-proposes texts for ("Re-read the rest
   * of the inbox the moment you fix a title", issue 399). Read by that job
   * and by nothing else, the same as `unfiledItemsInWorkspace` above.
   */
  itemsWithUnsettledTexts(
    accountName: string,
  ): Awaitable<
    Answer<
      { id: string; workspaceId: string; title: string; description: string | null; capturedMessage: string }[]
    >
  >;
  /**
   * Queues one rewrite attempt, "Pending" until `recordRewriteOutcome` below
   * settles it ("See the history of what Cockpit proposed for the Inbox's
   * items", issue 444). Written by the enrichment job (and the route that
   * fires it) and by nothing else.
   */
  queueRewriteAttempt(accountName: string, attempt: QueuedRewriteAttempt): Awaitable<Answer<null>>;
  /**
   * Settles one queued rewrite attempt by its own id - a queue retry of the
   * same attempt calls this again with the same id, updating that one row
   * rather than adding another (issue 444). Written by the enrichment job and
   * by nothing else.
   */
  recordRewriteOutcome(
    accountName: string,
    attemptId: string,
    outcome: RewriteOutcome,
  ): Awaitable<Answer<null>>;
  /**
   * Every rewrite attempt for one Workspace's items, most recent first - the
   * table opened from the Inbox's own menu (issue 444).
   */
  rewriteHistoryForWorkspace(
    accountName: string,
    workspaceId: string,
  ): Awaitable<Answer<RewriteHistoryEntryRow[]>>;
  /**
   * Every rewrite attempt for one item, most recent first - the table opened
   * from that item's own menu (issue 444).
   */
  rewriteHistoryForItem(accountName: string, itemId: string): Awaitable<Answer<RewriteHistoryEntryRow[]>>;
  /**
   * Writes what one Item means and pairs it against every other Item of the
   * account that says the same thing ("Flag a captured note that says what
   * another one already said", issue 407). Written by the job that reads a
   * note and by nothing else.
   *
   * A plain answer rather than `missing`, for the reason `item` above answers
   * null: the caller holds an id from minutes ago, and an Item dismissed and
   * erased in the meantime is the ordinary case rather than a failure.
   */
  rememberWhatAnItemMeans(
    accountName: string,
    itemId: string,
    model: string,
    reading: number[],
  ): Awaitable<Answer<'remembered' | 'no such item'>>;
  /**
   * Forgets what an Item means, and every pair built on it - for an Item whose
   * two texts have been emptied and which now says nothing to compare.
   */
  forgetWhatAnItemMeans(accountName: string, itemId: string): Awaitable<Answer<null>>;
  /**
   * One batch of the open Items nothing has read yet, from `after` onwards -
   * what `pnpm duplicates:backfill` walks ("Give every item already there a
   * vector", issue 409). Read by the operator's route and by nothing else.
   */
  itemsToRead(
    accountName: string,
    model: string,
    after: string | null,
    limit: number,
  ): Awaitable<Answer<{ id: string; title: string; description: string | null }[]>>;
  /**
   * Writes what a batch of Items mean and works out which of this account's
   * Items say the same thing ("Give every item already there a vector", issue
   * 409). Written by the operator's route and by nothing else.
   *
   * Answers which of them were written: one gone, finished with or dismissed
   * since its reading was asked for is left out rather than refused, for the
   * reason `rememberWhatAnItemMeans` above answers plainly.
   */
  rememberWhatTheseItemsMean(
    accountName: string,
    model: string,
    readings: readonly { itemId: string; reading: number[] }[],
  ): Awaitable<Answer<{ remembered: string[] }>>;
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
  /**
   * Puts the shared guest account back to the demonstration it opens on
   * ("Reset the guest account to its seeded state", issue 356).
   *
   * **No account name, like `destroy` below**, because there is only one
   * account it may be asked of and it names that itself. A store holding any
   * other account's rows answers `conflict` and drops nothing - see
   * `resetGuest` in `store.ts`.
   */
  resetGuest(): Awaitable<Answer<null>>;
  /**
   * How many live workspaces the store holds, and whether it holds anything at
   * all, for the question asked before its owner is deleted ("Delete a user,
   * and the account they owned with them", issue 234). Both, because a
   * deleted workspace keeps what was in it - so none left live is not the
   * same as nothing held.
   *
   * **Counted as it stands, like the export**: an admin looking at somebody's
   * row must not be what creates or migrates their account. One nobody ever
   * opened has no tables, and holds nothing.
   */
  holdings(accountName: string): Awaitable<{ workspaces: number; empty: boolean }>;
  /**
   * Destroys everything the store holds - every table and the record of which
   * changes ran - so the next time anything opens it, it starts as a new
   * account does (issue 234).
   *
   * **No account name, like `resetGuest` above, and for the opposite reason**:
   * nothing is filtered, the whole object goes. Only `deleteUser` reaches it,
   * and only after the register has named whose account this is.
   */
  destroy(): Awaitable<void>;
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
