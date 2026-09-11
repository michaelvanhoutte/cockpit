import {
  FIRST_DASHBOARD_NAME,
  FIRST_PANEL_NAME,
  FIRST_WORKSPACE_NAME,
  GRID_COLUMNS,
  themeOf,
} from '@cockpit/shared';
import type { AssociationKind } from '@cockpit/shared';
import { GUEST_ACCOUNT_NAME } from '../auth/register.js';
import { foldName } from '../domain/names.js';
import { GUEST_DEMO, SEEDED_AT, type SeedDashboard, type SeedItem } from './guest-seed-data.js';
import type { Change, Statement } from './up-to-date.js';

/**
 * Every change an account's store has ever needed, oldest first. An account
 * applies the ones it has not applied yet the next time somebody opens it -
 * which is the price of the storage decision (see
 * [account-storage-options.md](../../../../docs/account-storage-options.md)):
 * a Durable Object is reached by name at runtime and created on first touch,
 * so nothing can bring it up to date ahead of a request the way
 * `wrangler d1 migrations apply` does for the register.
 *
 * **Never edit a change that has shipped.** An account that already applied it
 * will not apply it again, so an edit only ever reaches the accounts that had
 * not - which is two schemas in production and no way to tell them apart. Add
 * the next change instead.
 *
 * **Renaming one is editing it, and the name is the only thing a store keys
 * on.** A store records what it has applied by name and compares by name, so a
 * rename makes an applied change look unapplied and it runs a second time -
 * `duplicate column name`, and the account cannot be opened at all. Renaming is
 * therefore safe only against stores that never applied the old name, and
 * "shipped" for this rule means *applied anywhere*, not *deployed*: a
 * developer's own store counts, and is the one you are most likely to forget
 * because you filled it yourself an hour earlier. That is exactly how
 * `0005-workspace-bar` broke the machine it was written on.
 *
 * **And it bought nothing.** It was renumbered from `0004` because
 * `0004-workspace-order` merged first and two `0004`s read badly - but a
 * shared number is not a fault. Names are compared whole, so both applied in
 * list order and nothing was skipped; the collision was untidy, and untidy is
 * not worth an edit that can stop an account opening. **A duplicate *name* is
 * the fault worth acting on** - the second change then looks applied and never
 * runs - and that is what tests/unit/accounts/changes.test.ts holds. Where a
 * rename is genuinely unavoidable, the cost is that everyone carrying the old
 * name resets their local stores (readme, "Resetting local data"); it is never
 * paid a second time by renaming back.
 *
 * **The SQL is written out, not generated.** drizzle-kit generates against a
 * database it can connect to, and there is no such thing for a Durable Object
 * that is created on demand; it also cannot emit STRICT (see `schema.ts`), so
 * even the generated output would be hand-edited. `schema.ts` remains what
 * queries are written against, and
 * apps/api/tests/integration/accounts/constraints.test.ts is what keeps the
 * two from drifting: it asserts the conventions against the schema an account
 * actually ends up with, rather than against the TypeScript that describes it.
 */
export function accountChanges(accountId: string): readonly Change[] {
  return [
    ACCOUNT_SCHEMA,
    DASHBOARDS,
    WORKSPACE_ORDER,
    PANELS,
    WORKSPACE_BAR,
    PANEL_ITEMS,
    ITEM_COMPLETED_AT,
    itemTypes(accountId),
    ITEM_WORKSPACE_DECIDED,
    ITEM_TEXTS,
    WORKSPACE_INK,
    LAYOUT_NAMES,
    standardTypes(accountId),
    PANEL_ROWS,
    // Last, because these are the ones that have not shipped: everything above
    // is applied in accounts already, and a change that has shipped can never
    // be reordered any more than it can be edited.
    DROP_ITEM_PREVIEW,
    TEXT_PANELS,
    PANEL_TEXT_FORMAT,
    TITLE_FROM_CAPTURED_MESSAGE,
    SCREEN_SIZES,
    DROP_LAYOUT_NAME_AND_WIDTH,
    ITEM_TEXTS_SETTLED,
    ITEM_READINGS,
    ITEM_PROPOSED_PANEL,
    DECISION_HISTORY,
    WORKSPACE_ROUTING_SUMMARY,
    firstWorkspace(accountId),
    guestDemoSeed(accountId),
  ];
}

/**
 * When a person took an Item's title and description over from Cockpit ("Clean
 * up a captured note into a clear title and a fuller message", issue 296).
 *
 * **One added column and nothing else** - no backfill and no rebuild. The
 * failure-mode questions the `scoping` skill asks of a change that cannot put
 * state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It adds a column and writes to no row.
 * - **Interrupted partway.** It cannot be: a change's statement and the record
 *   that it ran commit together (up-to-date.ts), so a failure leaves no column
 *   and the change is retried whole. That transaction is load-bearing rather
 *   than a nicety, exactly as for `0009-item-texts`: SQLite has no
 *   `ADD COLUMN IF NOT EXISTS`, so a half-applied change could never re-run.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left no column. Nothing is written to any row, so a second run doubles
 *   nothing.
 * - **Data the new rules reject.** None. The column starts null on every row,
 *   and null means "Cockpit may still propose these two". That is the *unsafe*
 *   direction on the face of it - every Item that exists says its hand-written
 *   title is replaceable - and it is safe here for a reason outside this
 *   column: only `capture_item` enqueues an enrichment, so no existing row is
 *   ever read by the one thing that would act on it (issue 296, "What does it
 *   run on?"). A default of the current time was the alternative and was
 *   rejected: it would state, on every row, that somebody edited its texts at
 *   the moment of a deploy, which is a fact nobody could later trust.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop, in
 *   staging and in production alike.
 * - **The windows it can be interrupted in.** Two, and both are safe because
 *   this is additive. *Before it runs*, the code in front of it is the previous
 *   release, which does not name the column. *After it runs, with that release
 *   promoted back*, its reads name a subset of the columns that exist, which
 *   SQLite is happy with - and its `set_title` writes leave the column null, so
 *   the worst a rollback costs is a title edited during it being proposed over
 *   once when the release goes forward again. The reverse - a release naming a
 *   column that is gone - is what dropping this would cause, which is why that
 *   would need a release of its own (deployment, "Migrations and rollback").
 */
const ITEM_TEXTS_SETTLED: Change = {
  name: '0021-item-texts-settled',
  statements: [{ sql: 'ALTER TABLE `items` ADD COLUMN `texts_settled_at` text' }],
};

/**
 * The other ways Cockpit read a captured note, where it genuinely found any
 * ("Offer the other readings when a captured note says two things", issue
 * 297) - JSON, in the same nullable text column `schema.ts` describes.
 *
 * **One added column and nothing else** - no backfill and no rebuild, the
 * same shape `0021-item-texts-settled` is. The failure-mode questions the
 * `scoping` skill asks of a change that cannot put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It adds a column and writes to no row.
 * - **Interrupted partway.** It cannot be: a change's statement and the record
 *   that it ran commit together (up-to-date.ts), so a failure leaves no column
 *   and the change is retried whole. SQLite has no `ADD COLUMN IF NOT EXISTS`,
 *   so a half-applied change could never re-run.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left no column. Nothing is written to any row, so a second run doubles
 *   nothing.
 * - **Data the new rules reject.** None. The column starts null on every row,
 *   which is exactly what "Cockpit found no other reading" means for a row
 *   nothing has proposed readings for yet - the same row every Item has until
 *   its own note is next read.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop,
 *   in staging and in production alike.
 * - **The windows it can be interrupted in.** Two, and both are safe because
 *   this is additive. *Before it runs*, the code in front of it is the
 *   previous release, which does not name the column. *After it runs, with
 *   that release promoted back*, its reads name a subset of the columns that
 *   exist, which SQLite is happy with - and its `propose_item_texts` writes
 *   leave the column untouched, so the worst a rollback costs is a set of
 *   readings from before it that nobody sees until the release goes forward
 *   again.
 */
const ITEM_READINGS: Change = {
  name: '0022-item-readings',
  statements: [{ sql: 'ALTER TABLE `items` ADD COLUMN `readings` text' }],
};

/**
 * The Panel Cockpit proposes an Item belongs on, and why ("Propose where a
 * captured note belongs, without filing it there", issue 298) - two nullable
 * columns and nothing else, the same shape `0021-item-texts-settled` and
 * `0022-item-readings` are.
 *
 * **The reference is spelled out, like every foreign key added to a live
 * table here.** SQLite's default action is NO ACTION, which is not what
 * `schema.ts` declares, and nothing in the constraints test compares the two
 * - it reads the target table and not the action.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It adds two columns and writes to no row.
 * - **Interrupted partway.** It cannot be: a change's statements and the
 *   record that they ran commit together (up-to-date.ts), so a failure leaves
 *   neither column and the change is retried whole.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left neither column. Nothing is written to any row, so a second run
 *   doubles nothing.
 * - **Data the new rules reject.** None. Both columns start null on every row,
 *   which is exactly what "nothing has been proposed yet" means.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop,
 *   in staging and in production alike.
 * - **The windows it can be interrupted in.** Two, and both are safe because
 *   this is additive. *Before it runs*, the code in front of it is the
 *   previous release, which does not name either column. *After it runs, with
 *   that release promoted back*, its reads name a subset of the columns that
 *   exist, and its writes never reach these two - so the worst a rollback
 *   costs is a proposal from after it that nobody sees until the release goes
 *   forward again.
 */
const ITEM_PROPOSED_PANEL: Change = {
  name: '0023-item-proposed-panel',
  statements: [
    {
      sql: 'ALTER TABLE `items` ADD COLUMN `proposed_panel_id` text REFERENCES `panels`(`id`) ON UPDATE no action ON DELETE restrict',
    },
    { sql: 'ALTER TABLE `items` ADD COLUMN `proposed_panel_reason` text' },
  ],
};

/**
 * The append-only decision history a routing proposal reads whole ("Learn
 * where notes belong from where you actually file them", issue 299) - see
 * `schema.ts` for what each column carries and why.
 *
 * **A brand new table, so it is created whole with its CHECK rather than
 * added to and altered later** - the same shape `SCREEN_SIZES` and
 * `ITEM_READINGS` use, and the reason is the same one this file gives for
 * both: a table created here can carry a CHECK from the start, unlike a
 * column added to `items` or `panels`, which cannot be rebuilt while other
 * tables point at them under RESTRICT.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It adds a table and writes to no existing row.
 * - **Interrupted partway.** It cannot be: the two statements and the record
 *   that they ran commit together (`up-to-date.ts`), so a failure leaves
 *   neither the table nor the index and the change is retried whole.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left nothing behind.
 * - **Data the new rules reject.** None: the table starts empty, and nothing
 *   sweeps past filings into it. History accumulates from this shipping
 *   forward, the same precedent issue 296 set for title cleanup.
 */
const DECISION_HISTORY: Change = {
  name: '0024-decision-history',
  statements: [
    {
      sql: `CREATE TABLE \`decision_history\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`workspace_id\` text NOT NULL,
	\`item_id\` text NOT NULL,
	\`proposed_panel_id\` text,
	\`proposed_panel_reason\` text,
	\`chosen_panel_id\` text NOT NULL,
	\`decided_at\` text NOT NULL,
	FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`proposed_panel_id\`) REFERENCES \`panels\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`chosen_panel_id\`) REFERENCES \`panels\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "decision_history_decided_at_is_timestamp" CHECK(decided_at IS NULL OR (datetime(decided_at) IS NOT NULL AND substr(decided_at, 11, 1) = 'T' AND substr(decided_at, -1) = 'Z' AND length(decided_at) >= 20 AND date(decided_at) = substr(decided_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX `decision_history_tenant_workspace_decided` ON `decision_history` (`tenant_id`,`workspace_id`,`decided_at`)',
    },
  ],
};

/**
 * One new, additive table (`schema.ts`'s own comment on `workspaceRoutingSummary`
 * carries the design; this is its failure-mode account, per the scoping skill,
 * for "Show what the system learned, in a sentence you can correct", issue
 * 301):
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It creates a table and writes to no row.
 * - **Interrupted partway.** It cannot be, for the same reason every change
 *   here cannot: the statement and the record that it ran commit together
 *   (up-to-date.ts).
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left no table.
 * - **Rows that already break the new rule.** None - the table is new and
 *   holds nothing to have broken any rule yet.
 * - **What each environment does.** The same thing everywhere: an account
 *   applies its outstanding changes inside the first request that opens it.
 */
const WORKSPACE_ROUTING_SUMMARY: Change = {
  name: '0025-workspace-routing-summary',
  statements: [
    {
      sql: `CREATE TABLE \`workspace_routing_summary\` (
	\`workspace_id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`summary\` text,
	\`summary_generated_at\` text,
	\`correction\` text,
	\`correction_set_at\` text,
	FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "workspace_routing_summary_generated_at_is_timestamp" CHECK(summary_generated_at IS NULL OR (datetime(summary_generated_at) IS NOT NULL AND substr(summary_generated_at, 11, 1) = 'T' AND substr(summary_generated_at, -1) = 'Z' AND length(summary_generated_at) >= 20 AND date(summary_generated_at) = substr(summary_generated_at, 1, 10))),
	CONSTRAINT "workspace_routing_summary_correction_set_at_is_timestamp" CHECK(correction_set_at IS NULL OR (datetime(correction_set_at) IS NOT NULL AND substr(correction_set_at, 11, 1) = 'T' AND substr(correction_set_at, -1) = 'Z' AND length(correction_set_at) >= 20 AND date(correction_set_at) = substr(correction_set_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX `workspace_routing_summary_tenant_workspace` ON `workspace_routing_summary` (`tenant_id`,`workspace_id`)',
    },
  ],
};

/**
 * The whole schema in one statement list, because an account's store starts
 * empty and has no history to preserve. The two D1 migrations that produced
 * the same shape are the register's history, not this one's; they stay where
 * they are and are not replayed here.
 */
const ACCOUNT_SCHEMA: Change = {
  name: '0001-account-schema',
  statements: [
    {
      sql: `CREATE TABLE \`workspaces\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`folded_name\` text DEFAULT '' NOT NULL,
	\`color\` text NOT NULL,
	\`ground\` text DEFAULT '#e3e1f2' NOT NULL,
	\`header\` text DEFAULT '#d2cdea' NOT NULL,
	\`created_at\` text NOT NULL,
	\`deleted_at\` text,
	CONSTRAINT "workspaces_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10))),
	CONSTRAINT "workspaces_deleted_at_is_timestamp" CHECK(deleted_at IS NULL OR (datetime(deleted_at) IS NOT NULL AND substr(deleted_at, 11, 1) = 'T' AND substr(deleted_at, -1) = 'Z' AND length(deleted_at) >= 20 AND date(deleted_at) = substr(deleted_at, 1, 10)))
) STRICT`,
    },
    {
      sql: `CREATE TABLE \`items\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`workspace_id\` text NOT NULL,
	\`source\` text NOT NULL,
	\`source_id\` text,
	\`source_link\` text,
	\`sender\` text,
	\`source_timestamp\` text,
	\`title\` text NOT NULL,
	\`preview\` text,
	\`source_resolved_at\` text,
	\`status\` text NOT NULL,
	\`next_action\` text,
	\`focus_horizon\` text,
	\`priority\` text,
	\`due_date\` text,
	\`snoozed_until\` text,
	\`unseen\` integer DEFAULT false NOT NULL,
	\`deleted_at\` text,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "items_source_is_known" CHECK(source IN ('internal', 'mail', 'slack', 'notion', 'whatsapp')),
	CONSTRAINT "items_status_is_known" CHECK(status IN ('to_process', 'task', 'waiting', 'snoozed', 'delegated', 'reference', 'done', 'dismissed')),
	CONSTRAINT "items_focus_horizon_is_known" CHECK(focus_horizon IN ('today', 'week', 'month', 'quarter')),
	CONSTRAINT "items_priority_is_known" CHECK(priority IN ('low', 'normal', 'high')),
	CONSTRAINT "items_unseen_is_flag" CHECK(unseen IN (0, 1)),
	CONSTRAINT "items_due_date_is_date" CHECK(due_date IS NULL OR (date(due_date) IS NOT NULL AND date(due_date) = due_date)),
	CONSTRAINT "items_source_timestamp_is_timestamp" CHECK(source_timestamp IS NULL OR (datetime(source_timestamp) IS NOT NULL AND substr(source_timestamp, 11, 1) = 'T' AND substr(source_timestamp, -1) = 'Z' AND length(source_timestamp) >= 20 AND date(source_timestamp) = substr(source_timestamp, 1, 10))),
	CONSTRAINT "items_source_resolved_at_is_timestamp" CHECK(source_resolved_at IS NULL OR (datetime(source_resolved_at) IS NOT NULL AND substr(source_resolved_at, 11, 1) = 'T' AND substr(source_resolved_at, -1) = 'Z' AND length(source_resolved_at) >= 20 AND date(source_resolved_at) = substr(source_resolved_at, 1, 10))),
	CONSTRAINT "items_snoozed_until_is_timestamp" CHECK(snoozed_until IS NULL OR (datetime(snoozed_until) IS NOT NULL AND substr(snoozed_until, 11, 1) = 'T' AND substr(snoozed_until, -1) = 'Z' AND length(snoozed_until) >= 20 AND date(snoozed_until) = substr(snoozed_until, 1, 10))),
	CONSTRAINT "items_deleted_at_is_timestamp" CHECK(deleted_at IS NULL OR (datetime(deleted_at) IS NOT NULL AND substr(deleted_at, 11, 1) = 'T' AND substr(deleted_at, -1) = 'Z' AND length(deleted_at) >= 20 AND date(deleted_at) = substr(deleted_at, 1, 10))),
	CONSTRAINT "items_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10))),
	CONSTRAINT "items_updated_at_is_timestamp" CHECK(updated_at IS NULL OR (datetime(updated_at) IS NOT NULL AND substr(updated_at, 11, 1) = 'T' AND substr(updated_at, -1) = 'Z' AND length(updated_at) >= 20 AND date(updated_at) = substr(updated_at, 1, 10)))
) STRICT`,
    },
    {
      sql: `CREATE TABLE \`associations\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`item_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`label\` text NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "associations_kind_is_known" CHECK(kind IN ('person', 'project', 'topic')),
	CONSTRAINT "associations_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10)))
) STRICT`,
    },
    {
      sql: `CREATE TABLE \`commands\` (
	\`command_id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`workspace_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`payload\` text NOT NULL,
	\`issued_at\` text NOT NULL,
	\`received_at\` text NOT NULL,
	CONSTRAINT "commands_payload_is_json" CHECK(json_valid(payload)),
	CONSTRAINT "commands_issued_at_is_timestamp" CHECK(issued_at IS NULL OR (datetime(issued_at) IS NOT NULL AND substr(issued_at, 11, 1) = 'T' AND substr(issued_at, -1) = 'Z' AND length(issued_at) >= 20 AND date(issued_at) = substr(issued_at, 1, 10))),
	CONSTRAINT "commands_received_at_is_timestamp" CHECK(received_at IS NULL OR (datetime(received_at) IS NOT NULL AND substr(received_at, 11, 1) = 'T' AND substr(received_at, -1) = 'Z' AND length(received_at) >= 20 AND date(received_at) = substr(received_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE UNIQUE INDEX `workspaces_tenant_live_folded_name` ON `workspaces` (`tenant_id`,`folded_name`) WHERE "deleted_at" IS NULL',
    },
    {
      sql: 'CREATE INDEX `items_tenant_workspace_status` ON `items` (`tenant_id`,`workspace_id`,`status`)',
    },
    { sql: 'CREATE INDEX `associations_tenant_item` ON `associations` (`tenant_id`,`item_id`)' },
    { sql: 'CREATE INDEX `commands_tenant_received` ON `commands` (`tenant_id`,`received_at`)' },
  ],
};


/**
 * Dashboards: the table, and one dashboard for every workspace that was there
 * before it ("Add and switch dashboards", issue 32).
 *
 * **Nothing is rebuilt and nothing is dropped**, so the destructive half of the
 * checklist is genuinely empty. What is left is the backfill, which writes rows
 * a second run must not double.
 *
 * **Interrupted, or run again.** A change is applied atomically here - its
 * statements and the record that they ran, together (up-to-date.ts) - so a
 * change that fails partway leaves nothing of itself behind and is retried
 * whole. That is stronger than the D1 migrations this issue's failure modes
 * were written against, where nothing wraps two statements and a repeat has to
 * survive its own first half. The guards below are kept anyway, because they
 * cost nothing and because "it cannot happen" is a claim about the applier
 * rather than about this file:
 *
 * - `CREATE TABLE IF NOT EXISTS`, so a retry over a table that is somehow
 *   already there is a no-op rather than a failed deploy;
 * - the backfill **skips workspaces that already have a dashboard** rather than
 *   leaning on the unique index to catch the collision, so a second run does
 *   nothing rather than failing over rows that are already correct;
 * - backfilled ids are **derived from the workspace's own id**, matching
 *   `firstDashboardId` in src/domain/dashboards.ts, so a workspace's first
 *   dashboard has one id whether this change made it or `create_workspace`
 *   did, and no run can produce a second row that merely looks different.
 *
 * **Tombstoned workspaces get one too.** Backfilling them costs a row each and
 * keeps "every workspace has at least one dashboard" unconditional; skipping
 * them leaves a hole that opens the moment a deleted workspace is restored by
 * hand. The unique index is partial on the *dashboard's* tombstone, not the
 * workspace's, so nothing about a deleted workspace makes its dashboard
 * special.
 *
 * **No data can be rejected.** Every workspace gets a name no dashboard of that
 * workspace can already hold, because that workspace has no dashboards at all
 * when this runs; the foreign key holds because the row it points at is the one
 * being read to write it.
 */
const DASHBOARDS: Change = {
  name: '0003-dashboards',
  statements: [
    {
      sql: `CREATE TABLE IF NOT EXISTS \`dashboards\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`workspace_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`folded_name\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`deleted_at\` text,
	FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dashboards_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10))),
	CONSTRAINT "dashboards_deleted_at_is_timestamp" CHECK(deleted_at IS NULL OR (datetime(deleted_at) IS NOT NULL AND substr(deleted_at, 11, 1) = 'T' AND substr(deleted_at, -1) = 'Z' AND length(deleted_at) >= 20 AND date(deleted_at) = substr(deleted_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE UNIQUE INDEX IF NOT EXISTS `dashboards_workspace_live_folded_name` ON `dashboards` (`tenant_id`,`workspace_id`,`folded_name`) WHERE "deleted_at" IS NULL',
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS `dashboards_tenant_workspace` ON `dashboards` (`tenant_id`,`workspace_id`)',
    },
    {
      // One INSERT ... SELECT, so it fills every workspace or none. The name
      // is written out here rather than bound, to keep it beside the fold it
      // must agree with; both match FIRST_DASHBOARD_NAME in
      // src/domain/dashboards.ts, and the constraints test is what notices if
      // they ever stop agreeing.
      sql: `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
              SELECT w.id || '-dashboard-1', w.tenant_id, w.id, 'Dashboard 1', 'dashboard 1', w.created_at
                FROM workspaces w
               WHERE NOT EXISTS (SELECT 1 FROM dashboards d WHERE d.workspace_id = w.id)`,
    },
  ],
};
/**
 * Where each workspace sits in the tabs ("Reorder workspaces", issue 31): the
 * column, and a position for every workspace that was there before it.
 *
 * **Nothing is dropped and nothing is rebuilt**, so the destructive half of the
 * checklist is empty. What is left is one `ALTER TABLE` and one backfill, and
 * the questions worth answering before writing either:
 *
 * - **If it fails partway.** A change is applied atomically here - its
 *   statements and the record that they ran, in one transaction (store.ts), so
 *   a failure leaves neither the column nor the record and the change is
 *   retried whole. That atomicity is load-bearing rather than a nicety: SQLite
 *   has no `ADD COLUMN IF NOT EXISTS`, so a half-applied change that left the
 *   column behind could never be re-run. The other changes here can lean on
 *   `IF NOT EXISTS` as well as on the transaction; this one has only the
 *   transaction.
 * - **If it runs again.** Only an unfinished one runs again, and an unfinished
 *   one left no column - but the backfill is idempotent anyway, because it
 *   computes each position from `created_at` rather than incrementing anything.
 *   Running it twice writes the same numbers. It runs once per account, before
 *   anybody can have reordered anything, so it cannot overwrite an order
 *   somebody chose.
 * - **Data the new rule rejects.** None. Every existing row gets a position, and
 *   the rank is total: `created_at` first, then `id`, so two workspaces created
 *   in the same millisecond still get different numbers rather than sharing one.
 * - **What each environment does.** All of them do this, and they do it the same
 *   way - an account applies its outstanding changes inside the first request
 *   that opens it, whether that account is on a laptop, in staging or in
 *   production. There is no per-environment seeding step to differ,
 *   because nothing outside a store can reach one.
 * - **The windows it can be interrupted in.** Two, and the second is the reason
 *   the column is additive rather than a rebuild. *Before it runs*: the account
 *   is untouched, and the code in front of it is the previous release, which
 *   orders workspaces by `created_at` and never names this column. *After it
 *   runs, with the previous release promoted back*: that same code reads a table
 *   with a column it does not know about, which SQLite is happy with because no
 *   read names every column (`workspaceColumns` in repo.ts). The order somebody
 *   chose is ignored until the rollback is rolled forward; nothing fails and
 *   nothing is lost.
 */
const WORKSPACE_ORDER: Change = {
  name: '0004-workspace-order',
  statements: [
    { sql: 'ALTER TABLE `workspaces` ADD COLUMN `position` integer DEFAULT 0 NOT NULL' },
    {
      // The order they were made in, which is the order they have been shown in
      // until now: counting the workspaces of this account that come before
      // this one gives 0, 1, 2, … with no gaps. `id` breaks a tie on
      // `created_at` so the count cannot be the same for two rows.
      //
      // The unqualified `workspaces` inside the subquery is the row being
      // updated - the subquery's own copy is aliased `earlier` precisely so
      // that it is.
      sql: `UPDATE workspaces
               SET position = (SELECT COUNT(*)
                                 FROM workspaces earlier
                                WHERE earlier.tenant_id = workspaces.tenant_id
                                  AND (earlier.created_at < workspaces.created_at
                                       OR (earlier.created_at = workspaces.created_at
                                           AND earlier.id < workspaces.id)))`,
    },
  ],
};

/**
 * Panels, the layouts that arrange them, and the placements that say where each
 * panel sits in each layout ("Panels on a dashboard, with per-screen-size
 * layouts", issue 33).
 *
 * **Three empty tables and their indexes, and nothing else.** Nothing is
 * rebuilt, nothing is dropped, and there is no backfill: a dashboard with no
 * panels is a dashboard that shows none, which is exactly what every existing
 * dashboard already shows. That is what makes the failure-mode checklist for a
 * change that cannot put state back (the `scoping` skill) short here rather
 * than absent - the questions were asked, and the answers are:
 *
 * - **Interrupted partway.** A change is applied atomically (up-to-date.ts):
 *   its statements and the record that they ran commit together, so a failure
 *   leaves nothing of itself behind and the whole change is retried next time
 *   somebody opens the account.
 * - **Run again.** Every statement is `IF NOT EXISTS`, so a retry over tables
 *   that are somehow already there is a no-op. No rows are written, so there is
 *   nothing a second run could double.
 * - **Data the new rules reject.** None can exist: the tables are created
 *   empty by this change, so the first row any of these constraints ever sees
 *   is one the command handlers wrote.
 * - **What each environment does.** Nothing environment-specific: no seed and
 *   no backfill, so staging and production - neither of them ever re-seeded,
 *   both holding real data - get the same three empty tables. Every account
 *   applies this the next time it is opened, which is the price the account
 *   storage decision records.
 * - **The windows it can be interrupted in.** Two, and both are safe. Before
 *   the tables exist, the code running is the code that never reads them.
 *   After, an account is brought up to date *before* any work in the same
 *   request (store.ts), so there is no moment where the new code meets the old
 *   schema.
 *
 * The one thing worth saying out loud about the shape: `panel_placements` has a
 * composite primary key rather than an id of its own, and no `deleted_at`. The
 * reasons are on the tables in `schema.ts`, which is what queries are written
 * against; this file is only how they are actually created.
 */
const PANELS: Change = {
  name: '0005-panels',
  statements: [
    {
      sql: `CREATE TABLE IF NOT EXISTS \`panels\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`dashboard_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`folded_name\` text NOT NULL,
	\`created_at\` text NOT NULL,
	\`deleted_at\` text,
	FOREIGN KEY (\`dashboard_id\`) REFERENCES \`dashboards\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "panels_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10))),
	CONSTRAINT "panels_deleted_at_is_timestamp" CHECK(deleted_at IS NULL OR (datetime(deleted_at) IS NOT NULL AND substr(deleted_at, 11, 1) = 'T' AND substr(deleted_at, -1) = 'Z' AND length(deleted_at) >= 20 AND date(deleted_at) = substr(deleted_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE UNIQUE INDEX IF NOT EXISTS `panels_dashboard_live_folded_name` ON `panels` (`tenant_id`,`dashboard_id`,`folded_name`) WHERE "deleted_at" IS NULL',
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS `panels_tenant_dashboard` ON `panels` (`tenant_id`,`dashboard_id`)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS \`layouts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`dashboard_id\` text NOT NULL,
	\`screen_width\` integer NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`dashboard_id\`) REFERENCES \`dashboards\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "layouts_screen_width_is_a_width" CHECK(screen_width BETWEEN 1 AND 100000),
	CONSTRAINT "layouts_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS `layouts_tenant_dashboard` ON `layouts` (`tenant_id`,`dashboard_id`)',
    },
    {
      // The spans are written out as numbers rather than interpolated from the
      // shared constants the way schema.ts builds them: a change that has
      // shipped may never be edited, and a constant that later moves would
      // rewrite this statement for the accounts that have not applied it yet -
      // two schemas in production, and no way to tell them apart. The
      // constraints test is what notices if the two ever stop agreeing.
      sql: `CREATE TABLE IF NOT EXISTS \`panel_placements\` (
	\`tenant_id\` text NOT NULL,
	\`layout_id\` text NOT NULL,
	\`panel_id\` text NOT NULL,
	\`position\` integer NOT NULL,
	\`column_span\` integer NOT NULL,
	\`row_span\` integer NOT NULL,
	PRIMARY KEY(\`layout_id\`, \`panel_id\`),
	FOREIGN KEY (\`layout_id\`) REFERENCES \`layouts\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`panel_id\`) REFERENCES \`panels\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "panel_placements_column_span_fits_the_grid" CHECK(column_span BETWEEN 1 AND 12),
	CONSTRAINT "panel_placements_row_span_fits_the_grid" CHECK(row_span BETWEEN 1 AND 8),
	CONSTRAINT "panel_placements_position_is_an_order" CHECK(position >= 0)
) STRICT`,
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS `panel_placements_tenant_layout` ON `panel_placements` (`tenant_id`,`layout_id`)',
    },
  ],
};

/**
 * The fourth workspace color: the strip the dashboard tabs sit on, one step
 * lighter than the header above it ("Modernise the app shell: a fourth
 * workspace colour, connected tabs, and Inbox rows you can read at a glance",
 * issue 125).
 *
 * **The mapping below is written out and frozen, not built from the palette.**
 * A shipped change that read `WORKSPACE_THEMES` would change meaning the day
 * somebody tunes a color, which is the "never edit a change that has shipped"
 * rule arriving by the back door: the accounts that already applied it would
 * keep the old value and the ones that had not would get the new one, with
 * nothing to tell them apart. These are the eight bars as of this change, and
 * they stay these eight whatever the palette does next.
 *
 * **Nothing is rebuilt and nothing is dropped**, so the destructive half of the
 * checklist is empty: one added column and one update of rows that are already
 * there.
 *
 * **Interrupted, or run again.** A change is applied atomically here - its
 * statements and the record that they ran, together (up-to-date.ts) - so a
 * change that fails partway leaves nothing of itself behind and is retried
 * whole. That matters more here than it did for the dashboards change, because
 * SQLite has no `ADD COLUMN IF NOT EXISTS` and there is no guard to write: a
 * re-run over a store that somehow already had the column would fail loudly.
 * That is the outcome to want rather than one to paper over - it means the
 * ledger and the schema disagree, which is a thing to find out about.
 *
 * **No data is rejected, and the update cannot write a NULL.** `ADD COLUMN`
 * gives every existing row the default, which is only the right bar for the
 * first theme; the update then corrects the rest. A workspace whose color is
 * not one of the palette's tints matches no arm and `ELSE bar` writes it back
 * to itself, so it keeps the default rather than being emptied or refused -
 * the same fallback `themeOf` makes, and the same call "Choose a workspace's
 * colors from a palette" (issue 79) made for the same reason: an unfamiliar
 * color is one thing that looks slightly wrong, not a corrupt row.
 */
const WORKSPACE_BAR: Change = {
  // `0005`, and it should have been `0004`. "Reorder workspaces" (issue 31)
  // merged with that number while this was being built, and this was renumbered
  // so the two would not read as one - which fixed nothing, because names are
  // compared whole and two `0004`s apply perfectly well (see the header).
  //
  // What it cost was real: a store recording `0004-workspace-bar` does not
  // recognise `0005-workspace-bar`, so it runs again and fails with `duplicate
  // column name: bar`, and the account cannot be opened. That happened to the
  // machine this was written on.
  //
  // It stays `0005` now for the same reason it should never have moved: this
  // name has been applied and recorded, and renaming it back would break the
  // stores that carry it. Anyone still holding the old one resets (readme,
  // "Resetting local data").
  //
  // **And it sits beside `0005-panels`, deliberately.** That change merged
  // while this branch was open, taking the number the same way
  // `0004-workspace-order` did - so the situation that caused all of the above
  // arrived a second time, and this time nothing was renamed. Both apply, in
  // list order, and no store notices. That is the rule working rather than an
  // oversight, and it is written here because the next person to see two
  // `0005`s will reach for the tidy fix.
  name: '0005-workspace-bar',
  statements: [
    {
      sql: "ALTER TABLE `workspaces` ADD COLUMN `bar` text DEFAULT '#dbd7ee' NOT NULL",
    },
    {
      sql: `UPDATE workspaces SET bar = CASE color
              WHEN '#6f62b5' THEN '#dbd7ee'
              WHEN '#3a72c8' THEN '#cbdef5'
              WHEN '#c06a45' THEN '#eedcc4'
              WHEN '#3f8f78' THEN '#cbe4dc'
              WHEN '#a8548c' THEN '#edd3e4'
              WHEN '#b58a2f' THEN '#eee2c2'
              WHEN '#4f8fa8' THEN '#cde2eb'
              WHEN '#7d8f3f' THEN '#dde4c6'
              ELSE bar
            END`,
    },
  ],
};

/**
 * The table that lets a panel hold items ("Panels hold the items filed into
 * them, and the Inbox holds the rest", issue 36). The reasons for its shape are
 * on `panelItems` in `schema.ts`, which is what queries are written against;
 * this is only how it is created.
 *
 * **Nothing is rebuilt, nothing is dropped and no existing row is written**, so
 * the destructive half of the checklist is empty. One new table, and the app
 * looks exactly as it did until something is filed - every open item is filed
 * nowhere on the day this lands, which is the definition of being in the Inbox.
 *
 * **Interrupted, or run again.** A change is applied atomically (up-to-date.ts)
 * - its statements and the record that they ran, together - so one that fails
 * partway leaves nothing of itself behind and is retried whole. `IF NOT EXISTS`
 * on all three statements makes a re-run over a store that somehow already had
 * the table a no-op rather than a failure, which is what every other schema
 * statement here does.
 */
const PANEL_ITEMS: Change = {
  name: '0006-panel-items',
  statements: [
    {
      // The position bound is written out as a number rather than built from a
      // shared constant, for the reason the placement spans above are: a change
      // that has shipped may never be edited, and a constant that later moved
      // would rewrite this statement for the accounts that had not applied it
      // yet. The constraints test is what notices if the two stop agreeing.
      sql: `CREATE TABLE IF NOT EXISTS \`panel_items\` (
	\`tenant_id\` text NOT NULL,
	\`panel_id\` text NOT NULL,
	\`item_id\` text NOT NULL,
	\`position\` integer NOT NULL,
	\`created_at\` text NOT NULL,
	PRIMARY KEY(\`panel_id\`, \`item_id\`),
	FOREIGN KEY (\`panel_id\`) REFERENCES \`panels\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "panel_items_position_is_an_order" CHECK(position >= 0),
	CONSTRAINT "panel_items_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS `panel_items_tenant_panel` ON `panel_items` (`tenant_id`,`panel_id`)',
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS `panel_items_tenant_item` ON `panel_items` (`tenant_id`,`item_id`)',
    },
  ],
};

/**
 * Being finished with an item stops being one of eight statuses and becomes a
 * time ("An item is either yours to deal with or finished with", issue 154).
 *
 * **Additive, because `items` cannot be rebuilt.** `panel_items` and
 * `associations` point at it under RESTRICT, and a `DROP TABLE` performs an
 * implicit delete the foreign key refuses (architecture, "Schema conventions").
 * So `status`, `focus_horizon` and `snoozed_until` stay where they are with the
 * CHECKs they were created with, and nothing reads them again.
 *
 * Its failure modes, per the scoping skill:
 *
 * - **If it stops halfway:** it cannot. `transactionSync` wraps the statements
 *   and the record that they ran together (store.ts), so a failure in the
 *   backfill rolls the column back out with it.
 * - **The second time it runs:** it does not, having been recorded; and if the
 *   first attempt failed it starts from an untouched store. The backfill is
 *   idempotent anyway - it only writes rows whose `completed_at` is still null.
 * - **Rows that already break the new rule:** an item marked done today says so
 *   only in `status`, so it is given `updated_at` as its completion time. That
 *   is when it was last changed, which for a done item is when it was done.
 * - **What is in each environment:** no environment seeds an account's own data
 *   and none can (deployment, "Bootstrap runbook"), so every item anywhere was
 *   made by hand through the app.
 * - **The windows it can be interrupted in.** *Before it runs*: the account is
 *   untouched and the previous release is reading `status`, which still says
 *   what it always did. *After it runs, with the previous release promoted
 *   back*: that release reads `status` and ignores a column it does not name,
 *   so a done item is still done and one finished with in between is not - the
 *   only loss, and it is recovered by rolling forward, because `completed_at`
 *   was written and is still there.
 */
const ITEM_COMPLETED_AT: Change = {
  name: '0007-item-completed-at',
  statements: [
    { sql: 'ALTER TABLE `items` ADD COLUMN `completed_at` text' },
    {
      sql: `UPDATE items
               SET completed_at = updated_at
             WHERE status = 'done'
               AND completed_at IS NULL`,
    },
  ],
};

/**
 * Types, and the column on an item that points at one ("Capture a thought or an
 * action, and see which it is", issue 155).
 *
 * **The table is created whole and the column is added.** `item_types` has no
 * children yet, so it can carry every CHECK it will ever need - including on
 * two columns nothing writes until "Manage the types, and put them in the order
 * you want" (issue 156), because the moment `items.type_id` points at it the
 * table can no longer be told anything (architecture, "Schema conventions").
 * `items` is the other way round: it already has children, so the only thing
 * that can be done to it is add a nullable column, and SQLite allows a
 * REFERENCES clause on one exactly when its default is NULL.
 *
 * **Every account gets Action and Thought**, so no account starts with an empty
 * picker and the first capture has something to be. Their ids are derived from
 * the account's, the way the starting workspace's is, so applying this twice
 * cannot make two of them - and `INSERT OR IGNORE` says so out loud. The two
 * are renamed to *Task* and *Note* by `0012-standard-types`, which is what an
 * account ends up with; this change has shipped, so it still writes the names
 * it shipped with.
 *
 * **The colours are written out rather than built from `ITEM_TYPE_COLORS`**,
 * for the reason the position bound in `0006-panel-items` is: a change that has
 * shipped may never be edited, and a constant that later moved would rewrite
 * this statement for the accounts that had not applied it yet. The constraints
 * test is what notices if the two stop agreeing.
 *
 * Its failure modes: nothing here rewrites a row that already exists, so the
 * only loss available is the change failing partway - which `transactionSync`
 * rules out (store.ts), leaving the account to apply it whole next time.
 */
function itemTypes(accountId: string): Change {
  const at = '2026-09-04T00:00:00.000Z';
  return {
    name: '0008-item-types',
    statements: [
      {
        sql: `CREATE TABLE IF NOT EXISTS \`item_types\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`folded_name\` text DEFAULT '' NOT NULL,
	\`color\` text NOT NULL,
	\`position\` integer DEFAULT 0 NOT NULL,
	\`created_at\` text NOT NULL,
	\`deleted_at\` text,
	CONSTRAINT "item_types_color_is_known" CHECK(color IN ('#6f62b5', '#3a72c8', '#c06a45', '#3f8f78', '#a8548c', '#b58a2f', '#4f8fa8', '#7d8f3f')),
	CONSTRAINT "item_types_position_is_an_order" CHECK(position >= 0),
	CONSTRAINT "item_types_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10))),
	CONSTRAINT "item_types_deleted_at_is_timestamp" CHECK(deleted_at IS NULL OR (datetime(deleted_at) IS NOT NULL AND substr(deleted_at, 11, 1) = 'T' AND substr(deleted_at, -1) = 'Z' AND length(deleted_at) >= 20 AND date(deleted_at) = substr(deleted_at, 1, 10)))
) STRICT`,
      },
      {
        sql: 'CREATE UNIQUE INDEX IF NOT EXISTS `item_types_tenant_live_folded_name` ON `item_types` (`tenant_id`,`folded_name`) WHERE `deleted_at` IS NULL',
      },
      {
        sql: 'ALTER TABLE `items` ADD COLUMN `type_id` text REFERENCES `item_types`(`id`)',
      },
      {
        sql: `INSERT OR IGNORE INTO item_types (id, tenant_id, name, folded_name, color, position, created_at)
              VALUES (?, ?, 'Action', 'action', '#6f62b5', 0, ?)`,
        params: [`${accountId}-type-action`, accountId, at],
      },
      {
        sql: `INSERT OR IGNORE INTO item_types (id, tenant_id, name, folded_name, color, position, created_at)
              VALUES (?, ?, 'Thought', 'thought', '#3a72c8', 1, ?)`,
        params: [`${accountId}-type-thought`, accountId, at],
      },
    ],
  };
}

/**
 * An Item can belong to no Workspace yet, and then shows in every Workspace's
 * Inbox ("Capture something before you know which workspace it belongs to",
 * issue 165).
 *
 * **One statement, and that is the design rather than a coincidence.** The
 * column's `NOT NULL DEFAULT 1` gives every row that already exists the answer
 * it should have - all of them were captured into a Workspace deliberately - so
 * there is no backfill, and therefore nothing that can be half-done. Additive
 * for the reason `0007` was: `panel_items` and `associations` point at `items`
 * under RESTRICT, so it cannot be rebuilt, which is also why the column carries
 * no CHECK holding it to 0 or 1.
 *
 * Its failure modes, per the scoping skill:
 *
 * - **If it stops halfway:** it cannot, twice over. One statement, and
 *   `transactionSync` wraps it with the record that it ran (store.ts), so a
 *   failure leaves neither the column nor the record and it is retried whole.
 *   That matters because SQLite has no `ADD COLUMN IF NOT EXISTS`: a column
 *   left behind could never be re-run over.
 * - **The second time it runs:** it does not, having been recorded. A re-run
 *   over a store that somehow already had the column fails loudly with
 *   `duplicate column name`, which is the outcome to want - it says the ledger
 *   and the schema disagree.
 * - **Rows that already break the new rule:** none. Every existing Item belongs
 *   to the Workspace it was captured into, and the default says so.
 * - **What is in each environment:** the same thing everywhere. No environment
 *   seeds an account's own data and none can (deployment, "Bootstrap runbook"),
 *   and an account applies its outstanding changes inside the first request
 *   that opens it, on a laptop, in staging and in production alike.
 * - **The windows it can be interrupted in.** *Before it runs*: the account is
 *   untouched and the previous release never names the column. *After it runs,
 *   with the previous release promoted back*: that release reads a table with a
 *   column it does not name, which SQLite is happy with because no read names
 *   every column (`itemColumns` in repo.ts) - and an Item belonging to no
 *   Workspace reads as belonging to the one it was captured from, which is
 *   where the old code would have put it anyway. Nothing is lost by rolling
 *   back and nothing has to be repaired by rolling forward.
 */
const ITEM_WORKSPACE_DECIDED: Change = {
  name: '0009-item-workspace-decided',
  statements: [
    { sql: 'ALTER TABLE `items` ADD COLUMN `workspace_decided` integer DEFAULT 1 NOT NULL' },  ],
};

/**
 * The two texts an Item gains beside its title: `captured_message`, written
 * once when the Item is made, and `description`, which the Item's form edits
 * ("Edit an item's title and description on a form of its own", issue 159).
 *
 * **Two added columns and nothing else** - no backfill, no rebuild, and
 * `preview` left exactly where it is. The failure-mode questions the `scoping`
 * skill asks of a change that cannot put state back:
 *
 * - **Interrupted partway.** A change is applied atomically (up-to-date.ts):
 *   its statements and the record that they ran commit together, so a failure
 *   leaves neither column and the whole change is retried next time somebody
 *   opens the account. That transaction is load-bearing here rather than a
 *   nicety, exactly as for `0004-workspace-order`: SQLite has no
 *   `ADD COLUMN IF NOT EXISTS`, so a half-applied change that left one column
 *   behind could never be re-run.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left no column. Nothing is written to any row, so there is nothing a second
 *   run could double.
 * - **Data the new rules reject.** None, and none is moved. Both columns start
 *   null on every row. `preview` is null everywhere already - the capture box
 *   sent a title and nothing else - so there is no text in it to carry over,
 *   and the text existing Items *do* have is in `title`, where the row label
 *   still reads it (`itemLabel`). Backfilling `captured_message` from `title`
 *   would duplicate every existing Item's one text into two columns to no end.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop, in
 *   preview, in staging and in production alike. No seeding step differs.
 * - **The windows it can be interrupted in.** Two, and both are safe because
 *   this is additive. *Before it runs*, the code in front of it is the previous
 *   release, which names neither column. *After it runs, with that release
 *   promoted back*, its reads name a subset of the columns that exist, which
 *   SQLite is happy with. The reverse - a release naming a column that is gone -
 *   is what dropping `preview` would cause, which is why that got a release of
 *   its own (deployment, "Migrations and rollback"; `0014-drop-item-preview`
 *   below).
 */
const ITEM_TEXTS: Change = {
  name: '0009-item-texts',
  statements: [
    { sql: 'ALTER TABLE `items` ADD COLUMN `captured_message` text' },
    { sql: 'ALTER TABLE `items` ADD COLUMN `description` text' },
  ],
};

/**
 * Every workspace repainted in the new palette: near-black chrome over a light
 * sheet, in the workspace's own hue (artboard 2c of "Cockpit Shell
 * Explorations"). The tint is not touched - it is the colour a person already
 * recognises in the tabs, and it is the key every statement here matches on.
 *
 * **Why the rows have to be written rather than left to the client.** A
 * workspace stores all three surfaces resolved, so the palette is a picker
 * rather than a storage format - the reason is on the register migration that
 * added the columns, `migrations/0007_giant_shape.sql`, under "Why columns and
 * not a theme name". Named by file rather than by number because a bare `0007`
 * read here is `0007-item-completed-at`, which is a different history entirely.
 * That means a workspace made before this change carries the old pale surfaces
 * for good unless something writes them, and the chrome's text is a fixed light
 * set now - pale text on a pale bar is unreadable rather than merely wrong.
 *
 * **A workspace whose tint is in no theme is repainted too**, in the default
 * theme's three surfaces, which is the opposite of what `0005-workspace-bar`
 * decided for the same row. The reason the two differ is the reason above: back
 * then an unmatched workspace kept a bar that was merely the wrong hue, and now
 * it would keep a surface its own text cannot be read on. It still keeps its
 * tint, so the one thing about it a person recognises is unchanged.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Interrupted partway.** It cannot be. A change is applied atomically
 *   (up-to-date.ts): the statement and the record that it ran commit together,
 *   so a failure leaves every row exactly as it was and the change is retried
 *   whole next time somebody opens the account.
 * - **Run again.** Only an unfinished change runs again, and this one is an
 *   assignment keyed on the tint either way: a second run writes the same three
 *   values over the same rows.
 * - **Data the new rules reject.** None. There is no constraint on these
 *   columns and no shape to violate; the `ELSE` branch above is what covers the
 *   rows nothing else matches.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop, in
 *   preview, in staging and in production alike.
 * - **The windows it can be interrupted in.** One that matters, and it is not
 *   in the database: a browser holding a stored copy of the workspace from
 *   before the deploy paints the old pale chrome under the new light text until
 *   the read behind it lands, which offline is a while. The shell closes that
 *   itself by falling back to the theme a tint belongs to whenever the three
 *   surfaces it was handed are not a palette theme (pages/Layout.tsx), so this
 *   change is what makes the stored rows right rather than what makes the
 *   screen readable.
 */
const WORKSPACE_INK: Change = {
  name: '0010-workspace-ink',
  statements: [
    {
      // One statement rather than eight, unlike `0005-workspace-bar`, because
      // three columns move together here and eight statements would be
      // twenty-four assignments in a shape that has to stay in step by eye.
      sql: `UPDATE workspaces SET
              header = CASE color
                WHEN '#6f62b5' THEN '#18152b'
                WHEN '#3a72c8' THEN '#151e2b'
                WHEN '#c06a45' THEN '#2b1c15'
                WHEN '#3f8f78' THEN '#152b24'
                WHEN '#a8548c' THEN '#2b1523'
                WHEN '#b58a2f' THEN '#2b2415'
                WHEN '#4f8fa8' THEN '#15252b'
                WHEN '#7d8f3f' THEN '#262b15'
                ELSE '#18152b'
              END,
              bar = CASE color
                WHEN '#6f62b5' THEN '#211d37'
                WHEN '#3a72c8' THEN '#1d2737'
                WHEN '#c06a45' THEN '#37251d'
                WHEN '#3f8f78' THEN '#1d372f'
                WHEN '#a8548c' THEN '#371d2e'
                WHEN '#b58a2f' THEN '#372f1d'
                WHEN '#4f8fa8' THEN '#1d3037'
                WHEN '#7d8f3f' THEN '#31371d'
                ELSE '#211d37'
              END,
              ground = CASE color
                WHEN '#6f62b5' THEN '#edebf7'
                WHEN '#3a72c8' THEN '#ebf0f7'
                WHEN '#c06a45' THEN '#f7efeb'
                WHEN '#3f8f78' THEN '#ebf7f3'
                WHEN '#a8548c' THEN '#f7ebf3'
                WHEN '#b58a2f' THEN '#f7f3eb'
                WHEN '#4f8fa8' THEN '#ebf4f7'
                WHEN '#7d8f3f' THEN '#f4f7eb'
                ELSE '#edebf7'
              END`,
    },
  ],
};

/**
 * Layouts get a name, and it becomes the thing they are picked by ("Pick the
 * layout you are on, by name").
 *
 * A layout used to be identified by the width it was made at, and the app drew
 * whichever one was closest to the screen in front of you. Nobody could tell
 * which they were on, so this gives every layout a name, and the ones that
 * already exist get the label the app was already showing them under.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Interrupted partway.** It cannot be. A change is applied atomically
 *   (up-to-date.ts): its statements and the record that they ran commit
 *   together, so the two `ALTER TABLE`s, the backfill and the index either all
 *   happen or none do. That is the whole reason they are one change rather
 *   than the add-then-backfill pair the register needs (migrations/0007 and
 *   0008), where nothing wraps the files.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left nothing behind. Both `UPDATE`s are guarded on the empty string all
 *   the same, so neither would rewrite a name somebody has since chosen.
 * - **Data the new rules reject.** Two layouts of one dashboard made at the
 *   same width - which nothing stopped - would take the same name and fail the
 *   unique index, taking the whole change and the account's first request with
 *   it. The backfill numbers them instead, so the second becomes `1440 px (2)`.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop, in
 *   preview, in staging and in production alike. Nothing seeds layouts, so
 *   preview has none until somebody arranges a dashboard.
 * - **The windows it can be interrupted in.** One, and it is the deploy rather
 *   than the database: for the seconds both versions of the Worker are serving,
 *   old code can still create a layout and knows nothing of these columns, so
 *   its insert takes the `''` default. Following `0005-workspace-bar`, that
 *   collides with *another* unnamed layout on the same dashboard rather than
 *   escaping the index - the second such create in that window is refused, and
 *   a refusal during a deploy is recoverable where a duplicate name is not.
 *   Layouts are only created by arranging a dashboard for the first time, so
 *   the window is narrower than that one's. A row it does leave behind keeps
 *   its empty name, and is drawn as the width it was made for
 *   (apps/web/src/panels/arrangement.ts) rather than as a blank entry.
 */
const LAYOUT_NAMES: Change = {
  name: '0011-layout-names',
  statements: [
    { sql: `ALTER TABLE layouts ADD name text DEFAULT '' NOT NULL` },
    { sql: `ALTER TABLE layouts ADD folded_name text DEFAULT '' NOT NULL` },
    {
      // The label every layout was already listed under, so nothing a person
      // recognises changes on the day this lands. Numbered within the width
      // rather than globally: `1440 px` and `1440 px (2)` say the two are the
      // same size and different arrangements, which is what they are.
      //
      // `ROW_NUMBER` rather than a correlated count, because the ordering has
      // to be stable across the two writers below and a count would have to be
      // written twice. `created_at, id` and not `created_at` alone: two layouts
      // made in the same millisecond would otherwise tie and could take the
      // same number.
      sql: `UPDATE layouts AS l
              SET name = CAST(l.screen_width AS TEXT) || ' px'
                || CASE WHEN d.rn = 1 THEN '' ELSE ' (' || d.rn || ')' END
              FROM (
                SELECT id, ROW_NUMBER() OVER (
                  PARTITION BY tenant_id, dashboard_id, screen_width
                  ORDER BY created_at, id
                ) AS rn
                FROM layouts
              ) AS d
              WHERE l.id = d.id AND l.name = ''`,
    },
    {
      // Folded from the name just written rather than computed a second time,
      // which is what `0005-workspace-bar` does and for the same reason: two
      // expressions that have to agree are one expression too many. `lower()`
      // is enough for what the statement above can produce - digits, a space
      // and ASCII letters - though it is not case folding in general, which is
      // why `foldName` exists in the application (src/domain/names.ts).
      sql: `UPDATE layouts SET folded_name = lower(name) WHERE folded_name = ''`,
    },
    {
      // Not partial on a tombstone, unlike the other three name indexes: a
      // layout is deleted for real rather than tombstoned, so there is no dead
      // row to exclude.
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS layouts_dashboard_folded_name
              ON layouts (tenant_id, dashboard_id, folded_name)`,
    },
  ],
};

/**
 * A dashboard's arrangement becomes a list of rows ("Rows of panels, not a grid
 * that wraps").
 *
 * Panels used to flow left to right and wrap at twelve columns, so which of
 * them shared a line was decided by CSS at the moment of drawing and written
 * down nowhere. Rows write it down: a row holds the panels across it, they
 * divide its width in proportion to their spans, and they share its height.
 *
 * **The conversion replays the wrap, and that is the whole of why it is not one
 * row per panel.** Which panels shared a line is something a person arranged -
 * three across, then two - and in the old shape it exists only as a consequence
 * of the widths and the order. Flattening would leave every dashboard a single
 * column; replaying keeps every arrangement looking as it did.
 *
 * **The table is rebuilt rather than altered**, which is not a preference:
 * SQLite refuses `DROP COLUMN` for a column named in a CHECK, and both of the
 * columns going are. So the new shape is created beside the old one, filled,
 * and swapped in. It is safe here for the reason 0002 said it was not for
 * `items`: nothing references `panel_placements`, so there is no child under
 * RESTRICT to make the drop refuse.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Interrupted partway.** It cannot be. A change is applied atomically
 *   (up-to-date.ts), so the new table, the conversion, the swap and the scratch
 *   table's removal commit together or not at all. That matters more here than
 *   in any change before it: half of this one is a table that exists under two
 *   names.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left nothing behind - including the scratch table, which is why it needs no
 *   `IF NOT EXISTS`.
 * - **Rows the new rules reject.** None. The spans are the widths already
 *   stored and are read as proportions, so nothing is rescaled; a row of six
 *   narrow panels converts to a row of six rather than being split, because
 *   four across is what the gestures refuse and not what the table does
 *   (`cellInputSchema`).
 * - **What each environment does.** The same thing: an account converts inside
 *   the first request that opens it, on a laptop, in preview, in staging and in
 *   production alike. Nothing seeds layouts.
 * - **The windows it can be interrupted in.** One, and it is the deploy rather
 *   than the database: for the seconds both versions of the Worker are serving,
 *   old code can still save an arrangement and writes `column_span` and
 *   `row_span`, which are gone. Its command fails whole and says so - a refusal
 *   during a deploy is recoverable, where a layout half in each shape would not
 *   be - and it cannot leave half an arrangement behind, because every
 *   placement of a save is written in one transaction.
 */
const PANEL_ROWS: Change = {
  name: '0013-panel-rows',
  statements: [
    {
      // The numbers are written out rather than interpolated from the shared
      // constants, for the reason `0005-panels` gives: a change that has
      // shipped may never be edited, so a constant that later moves would
      // rewrite this statement for the accounts that have not applied it yet.
      //
      // Which is what makes *lowering* `MIN_ROW_HEIGHT` a change of its own
      // rather than an edit here: every store converted by this one keeps the
      // CHECK below, so a floor the contract has dropped to would be refused by
      // the database with a constraint error instead of a sentence. Raising it
      // needs nothing - the old CHECK is merely looser than the new contract.
      sql: `CREATE TABLE \`layout_rows\` (
	\`tenant_id\` text NOT NULL,
	\`layout_id\` text NOT NULL,
	\`row_index\` integer NOT NULL,
	\`height\` integer,
	PRIMARY KEY (\`layout_id\`, \`row_index\`),
	FOREIGN KEY (\`layout_id\`) REFERENCES \`layouts\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "layout_rows_row_index_is_an_order" CHECK(row_index >= 0),
	CONSTRAINT "layout_rows_height_is_a_height" CHECK(height IS NULL OR height BETWEEN 160 AND 720)
) STRICT`,
    },
    {
      sql: 'CREATE INDEX `layout_rows_tenant_layout` ON `layout_rows` (`tenant_id`,`layout_id`)',
    },
    {
      /*
       * Where the wrap is worked out, once. A scratch table rather than the
       * same recursive query written twice - the rows and their heights both
       * come out of it, and two copies of a walk this fiddly are two things
       * that have to agree.
       */
      sql: `CREATE TABLE \`panel_rows_conversion\` (
	\`tenant_id\` text NOT NULL,
	\`layout_id\` text NOT NULL,
	\`panel_id\` text NOT NULL,
	\`row_index\` integer NOT NULL,
	\`position\` integer NOT NULL,
	\`span\` integer NOT NULL,
	\`row_span\` integer NOT NULL
) STRICT`,
    },
    {
      /*
       * The wrap, replayed: a running total of the widths in the order the
       * panels were drawn, and a panel whose width would take that total past
       * the twelve-column grid starts a new row.
       *
       * **Recursive because wrapping is sequential.** Dividing the cumulative
       * width by twelve would be wrong wherever a panel did not fit - it moved
       * wholly to the next line rather than being cut, so where each row ends
       * depends on where the one before it ended.
       *
       * `ordered` numbers each layout's placements from one so the walk has a
       * "next" to join on, and it is a CTE of its own because SQLite forbids
       * window functions inside the recursive half. Ties on `position` break on
       * `panel_id`, so a layout that somehow holds two panels at one position
       * converts the same way twice rather than differently.
       *
       * `position` comes out as the place *within* the row, which is what it
       * means from here on.
       */
      sql: `WITH RECURSIVE ordered AS (
              SELECT tenant_id, layout_id, panel_id, column_span, row_span,
                     ROW_NUMBER() OVER (PARTITION BY layout_id ORDER BY position, panel_id) AS n
              FROM panel_placements
            ),
            walk AS (
              SELECT tenant_id, layout_id, panel_id, n, column_span, row_span,
                     0 AS row_index, 0 AS at, column_span AS used
              FROM ordered WHERE n = 1
              UNION ALL
              SELECT o.tenant_id, o.layout_id, o.panel_id, o.n, o.column_span, o.row_span,
                     CASE WHEN w.used + o.column_span > 12 THEN w.row_index + 1 ELSE w.row_index END,
                     CASE WHEN w.used + o.column_span > 12 THEN 0 ELSE w.at + 1 END,
                     CASE WHEN w.used + o.column_span > 12 THEN o.column_span ELSE w.used + o.column_span END
              FROM ordered o
              JOIN walk w ON o.layout_id = w.layout_id AND o.n = w.n + 1
            )
            INSERT INTO panel_rows_conversion
              (tenant_id, layout_id, panel_id, row_index, position, span, row_span)
            SELECT tenant_id, layout_id, panel_id, row_index, at, column_span, row_span FROM walk`,
    },
    {
      /*
       * Every row the walk found, at the height of the tallest panel in it, so
       * nothing on screen changes size on the day this lands: eighty pixels a
       * grid row and four between them, which is what the board drew
       * (components/PanelCard.tsx). Clamped to what a row may now be set to,
       * since two grid rows measured 164 and the floor is 160.
       */
      sql: `INSERT INTO layout_rows (tenant_id, layout_id, row_index, height)
            SELECT tenant_id, layout_id, row_index,
                   CASE
                     WHEN MAX(row_span) * 84 - 4 < 160 THEN 160
                     WHEN MAX(row_span) * 84 - 4 > 720 THEN 720
                     ELSE MAX(row_span) * 84 - 4
                   END
            FROM panel_rows_conversion
            GROUP BY tenant_id, layout_id, row_index`,
    },
    {
      sql: `CREATE TABLE \`panel_placements_new\` (
	\`tenant_id\` text NOT NULL,
	\`layout_id\` text NOT NULL,
	\`panel_id\` text NOT NULL,
	\`row_index\` integer NOT NULL,
	\`position\` integer NOT NULL,
	\`span\` integer NOT NULL,
	PRIMARY KEY (\`layout_id\`, \`panel_id\`),
	FOREIGN KEY (\`layout_id\`) REFERENCES \`layouts\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`panel_id\`) REFERENCES \`panels\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "panel_placements_span_fits_the_grid" CHECK(span BETWEEN 1 AND 12),
	CONSTRAINT "panel_placements_position_is_an_order" CHECK(position >= 0),
	CONSTRAINT "panel_placements_row_index_is_an_order" CHECK(row_index >= 0)
) STRICT`,
    },
    {
      sql: `INSERT INTO panel_placements_new
              (tenant_id, layout_id, panel_id, row_index, position, span)
            SELECT tenant_id, layout_id, panel_id, row_index, position, span
            FROM panel_rows_conversion`,
    },
    { sql: 'DROP TABLE `panel_placements`' },
    { sql: 'ALTER TABLE `panel_placements_new` RENAME TO `panel_placements`' },
    {
      sql: 'CREATE INDEX `panel_placements_tenant_layout` ON `panel_placements` (`tenant_id`,`layout_id`)',
    },
    { sql: 'DROP TABLE `panel_rows_conversion`' },
  ],
};

/**
 * The two types every account starts with become *Task* and *Note* ("Call the
 * two standard types Task and Note", issue 194).
 *
 * **Two updates and nothing else**, because a type's name is data an account
 * owns rather than an enum the code reads: `item_types` is a table, `type_id`
 * points at it, and nothing anywhere names either word. So the rename keeps the
 * rows - their ids, colours, positions, created times and every Item pointing
 * at them - and only the label changes.
 *
 * **`folded_name` moves with the display name**, which is what gives the old
 * name back: *Action* is free to create afterwards and *Task* is refused as a
 * duplicate, exactly as `rename_item_type` leaves things.
 *
 * **Matched by id and nothing else.** The two ids are derived from the
 * account's, the way `0008-item-types` wrote them, so this renames the rows
 * that change shipped whatever they currently say - including one somebody has
 * renamed by hand, and including one they have deleted, whose name is not shown
 * anywhere.
 *
 * Its failure modes, per the scoping skill. The answer to most of them is that
 * a name here is data and not code, so the change is safe in both directions:
 *
 * - **If it stops halfway:** it cannot. A change's statements and the record
 *   that they ran commit in one `transactionSync` (store.ts), so a failure
 *   leaves both names as they were and the change is retried whole next time
 *   somebody opens the account.
 * - **The second time it runs:** it does not, having been recorded; and if the
 *   first attempt failed it starts from untouched names. Idempotent anyway -
 *   it sets a literal on a row named by its primary key.
 * - **Rows that already break the new rule:** an account holding a live type it
 *   named *Task* or *Note* itself. `item_types_tenant_live_folded_name` refuses
 *   the update and the change fails, taking the account's first request with
 *   it. That is the chosen outcome rather than `UPDATE OR IGNORE`, which would
 *   leave the store and the code quietly disagreeing about what the standard
 *   types are called; it is recoverable by rolling the release back, which
 *   never runs this change, renaming the colliding type on the types page and
 *   rolling forward.
 * - **What is in each environment:** the same thing everywhere. No environment
 *   seeds an account's own data and none can (deployment, "Bootstrap runbook"),
 *   so the only stores holding these two rows are ones a person has opened.
 * - **The windows it can be interrupted in.** *Before it runs*: the account is
 *   untouched and the previous release reads *Action* and *Thought*, which is
 *   what it has always shown. *After it runs, with the previous release
 *   promoted back*: that release reads the same two rows under new names and
 *   shows them, because no code names either word. Nothing is lost by rolling
 *   back and nothing has to be repaired by rolling forward.
 */
function standardTypes(accountId: string): Change {
  return {
    name: '0012-standard-types',
    statements: [
      {
        sql: `UPDATE item_types SET name = 'Task', folded_name = 'task' WHERE id = ?`,
        params: [`${accountId}-type-action`],
      },
      {
        sql: `UPDATE item_types SET name = 'Note', folded_name = 'note' WHERE id = ?`,
        params: [`${accountId}-type-thought`],
      },
    ],
  };
}

/**
 * The text an Item used to carry beside its title, taken away now that its
 * title, the message it was captured from and its description are three columns
 * of their own ("Drop the preview column, once nothing reads it", issue 161).
 *
 * **The one destructive change in the list, and the reason it is a release
 * later than the one that stopped using the column.** `0009-item-texts` left
 * `preview` where it was; `itemColumns` (repo.ts) names every column it reads,
 * so a release that dropped it while any deployed release still named it would
 * fail every Item read outright. Expand-then-contract, and this is the contract
 * half (deployment, "Migrations and rollback").
 *
 * **SQLite will drop this particular column.** `ALTER TABLE ... DROP COLUMN`
 * (3.35+, and D1 runs 3.37+) refuses one carried by an index, a primary key or
 * a CHECK, and `preview` is in none: `items_tenant_workspace_status` names
 * three other columns and every CHECK on `items` names another column. So the
 * table is altered rather than rebuilt, which `items` could not be anyway -
 * `associations` and `panel_items` point at it under RESTRICT.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Interrupted partway.** It cannot be. A change's statements and the record
 *   that they ran commit in one `transactionSync` (store.ts), so a failure
 *   leaves the column and no record, and the whole change is retried next time
 *   somebody opens the account. That transaction is load-bearing rather than a
 *   nicety here, exactly as for the changes that add a column: SQLite has no
 *   `DROP COLUMN IF EXISTS`, so a drop recorded without having run could never
 *   be re-run over.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left the column alone. A re-run over a store that somehow no longer had it
 *   fails loudly with `no such column`, which is the outcome to want: it says
 *   the ledger and the schema disagree.
 * - **Rows the new rule rejects.** None, and nothing is lost that was not
 *   already null. `preview` was only ever written from a `body` field on
 *   `capture_item` that no front door sent - "Edit an item's title and
 *   description on a form of its own" (issue 159) replaced it with `message`,
 *   which goes to `captured_message` - and `seed.sql` creates no items. That is
 *   a claim read off the code rather than off the data, so the count is taken
 *   over production's accounts before this is promoted (deployment, "Migrations
 *   and rollback"); rows that exist are somebody's text and need a decision,
 *   not a drop.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop, in
 *   staging and in production alike. No seeding step differs.
 * - **The windows it can be interrupted in.** One that matters, and it is the
 *   deploy rather than the database. *Before it runs*: the account is untouched
 *   and every deployed release reads a subset of the columns it has. *After it
 *   runs, with a release older than `0009-item-texts` promoted back*: that
 *   code's `itemColumns` names `preview` and every Item read fails. Which is
 *   what makes the rollback floor real - a promotion back past "Edit an item's
 *   title and description on a form of its own" (issue 159) is not recoverable
 *   by promotion, and needs a restore (deployment, "Migrations and rollback").
 * - **A backup taken before this.** Restored intact: `restore.ts` replays the
 *   changes the backup recorded, so `items` is recreated with `preview` and the
 *   rows go back in as they were. The store then applies this change the next
 *   time it is opened, which is the same thing it does to every account.
 */
const DROP_ITEM_PREVIEW: Change = {
  name: '0014-drop-item-preview',
  statements: [{ sql: 'ALTER TABLE `items` DROP COLUMN `preview`' }],
};

/**
 * What a panel is made of, the text one of text holds, and whether that text is
 * read rather than written in ("Put a panel of text on a dashboard, and write
 * in it", issue 250).
 *
 * **Three columns, each with the default that is what every panel already
 * was**, which is the whole of why this is additive: a panel written before
 * this, and a panel written by the old Worker during the deploy, both read as a
 * panel of items holding nothing and open to be written in - which is what
 * makes "nothing a person recognises changes on the day this lands" true.
 *
 * **The CHECKs come with the columns rather than in a rebuild.** SQLite refuses
 * to add a CHECK to a table that already has children (architecture, "A CHECK
 * cannot be added to a table that already has children") - `panels` has three -
 * but `ALTER TABLE ... ADD COLUMN` carries its own, and it is only ever asked
 * about rows written afterwards. Every row already there holds the default,
 * which satisfies both.
 *
 * Its failure modes, per the scoping skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): three `ADD COLUMN`s, and not one statement that writes to a
 *   row.
 * - **If it stops halfway:** it cannot be left half applied. A change's
 *   statements and the record that they ran commit in one `transactionSync`
 *   (store.ts), so a failure leaves nothing of itself behind and it is retried
 *   whole.
 * - **The second time it runs:** it does not, having been recorded. `ADD
 *   COLUMN` is not idempotent on its own - a second run would fail on the
 *   duplicate name - and the record is what stops it, exactly as it is for
 *   every other change here.
 * - **Rows that already break the new rule:** there can be none. Every panel
 *   takes the defaults and every default satisfies its CHECK.
 * - **What is in each environment:** every panel gains three columns and none
 *   is rewritten, so what production and staging show the morning after is what
 *   they showed the night before.
 */
const TEXT_PANELS: Change = {
  name: '0016-text-panels',
  statements: [
    {
      sql: `ALTER TABLE \`panels\` ADD COLUMN \`kind\` text DEFAULT 'items' NOT NULL CHECK (kind IN ('items', 'text'))`,
    },
    { sql: `ALTER TABLE \`panels\` ADD COLUMN \`body\` text DEFAULT '' NOT NULL` },
    {
      sql: 'ALTER TABLE `panels` ADD COLUMN `read_only` integer DEFAULT 0 NOT NULL CHECK (read_only IN (0, 1))',
    },
  ],
};

/**
 * Whether a panel of text's words are drawn as the characters that were typed
 * or as what they mean ("Format what a panel says, without making every
 * dashboard pay for an editor", issue 251).
 *
 * **One column, defaulting to what every panel of text already was.** Nothing
 * is rewritten and nothing changes on screen the day this lands: a panel drawn
 * as characters yesterday is drawn as characters tomorrow, until somebody asks
 * otherwise from its own menu.
 *
 * Its failure modes, per the scoping skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** it cannot. One statement, and a change's
 *   statements and the record that they ran commit in one `transactionSync`
 *   (store.ts).
 * - **The second time it runs:** it does not, having been recorded - which is
 *   what an `ADD COLUMN` needs, being no more idempotent here than in
 *   `0016-text-panels`.
 * - **Rows that already break the new rule:** there can be none. Every panel
 *   takes the default and the default satisfies the CHECK.
 * - **What is in each environment:** every panel gains a column and none is
 *   rewritten.
 */
const PANEL_TEXT_FORMAT: Change = {
  name: '0017-panel-text-format',
  statements: [
    {
      sql: `ALTER TABLE \`panels\` ADD COLUMN \`format\` text DEFAULT 'plain' NOT NULL CHECK (format IN ('plain', 'rich'))`,
    },
  ],
};

/**
 * What a captured message would be if it were a title: one line, trimmed, and
 * cut to the 200 characters `itemTitleSchema` allows. The same rule as
 * `textsFromCapture` in packages/shared/src/domain/item.ts, written twice
 * because SQLite has no regular expressions and this one runs where that one
 * cannot be called - and read against it whenever either moves.
 *
 * **A run of them is one space, not one space each.** `\r\n` and a blank line
 * are the everyday runs, and replacing each character on its own put two spaces
 * in the middle of a backfilled title where a fresh capture of the same note
 * puts one - a mismatch written permanently into the rows this touches. So the
 * breaks become a token first, runs of the token collapse, and the token
 * becomes the space. Twenty halvings, which reaches one from any run a stored
 * message could hold: `capture_item` caps it at 60,000 characters and 2^20 is
 * past a million.
 *
 * **The token is `char(1)`, which is safe by being unsafe.** It is a control
 * character, so a message holding one is a message `textsFromCapture` would
 * also have turned into a space - being mistaken for a token is the behaviour
 * to want rather than a collision to avoid.
 *
 * The two still differ in two ways, both harmless. `replace` names the line
 * breaks and the tab rather than the whole `\p{Cc}` class, so an exotic control
 * character survives here and becomes a space there; a title holding one
 * renders oddly rather than breaking, the read model being permissive on
 * purpose (`itemSchema`). And SQLite counts characters where the cap counts
 * UTF-16 units, so a title of 200 emoji is stored longer than the cap; also
 * permissive on the way out, and never split in half, which is the failure that
 * would matter.
 */
const AS_A_TITLE = (() => {
  const token = 'char(1)';
  const breaks = ['char(10)', 'char(13)', 'char(9)', 'char(8232)', 'char(8233)'];
  let text = breaks.reduce((so_far, mark) => `replace(${so_far}, ${mark}, ${token})`, 'captured_message');
  for (let halving = 0; halving < 20; halving += 1) {
    text = `replace(${text}, ${token} || ${token}, ${token})`;
  }
  return `substr(trim(replace(${text}, ${token}, ' ')), 1, 200)`;
})();

/**
 * A title for every Item captured before capture wrote one.
 *
 * Nothing reads the captured message as a label any more (`itemLabel`), so
 * without this every Item captured before today would read *Untitled*. The
 * naming rule this repeats in SQL, and why an Item has both texts, are on
 * `textsFromCapture` in packages/shared/src/domain/item.ts.
 *
 * **The whole message goes to the description where it did not fit the title**,
 * so the 201st character onwards is not left only in a text nobody can edit.
 * Written first, because the second statement is what stops it matching.
 *
 * **`updated_at` is deliberately not touched.** It is what every handler
 * measures staleness by (`isStale`), so bumping it would refuse changes made on
 * a device between its last read and this - and nothing a person did happened
 * here anyway.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Interrupted partway.** It cannot be. A change's statements and the record
 *   that they ran commit in one `transactionSync` (store.ts), so a failure
 *   leaves neither write and the whole change is retried next time somebody
 *   opens the account.
 * - **Run again.** Only an unfinished change runs again, and it is idempotent
 *   regardless: after it, no row matches `trim(title) = ''` any more except one
 *   whose captured message is nothing but blanks, which both statements leave
 *   as they found it.
 * - **Rows the new rule rejects.** None is refused and none is dropped. A row
 *   that already has a title keeps it, exactly as it is - a person's own name
 *   for something is never overwritten by what was captured. A row that already
 *   has a description keeps that too, which is why the first statement asks for
 *   `description IS NULL`: an Item captured before this and then written about
 *   would otherwise lose what was written.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop, in
 *   staging and in production alike. No seeding step differs.
 * - **The windows it can be interrupted in.** Three. *Before it runs*: nothing
 *   is touched, and the release in front of it still reads the captured message
 *   as a label, so the Items look exactly as they did. *After it runs, with the
 *   previous release promoted back*: that release prefers the title over the
 *   captured message (`itemLabel`), so it shows the titles this wrote - the same
 *   text, cut at 200 rather than at 150. Neither needs repairing.
 *
 *   *Capturing while that older release is running* does. It writes an empty
 *   title, this change is recorded as applied so it never runs again
 *   (`bringUpToDate`), and rolling forward leaves those Items reading
 *   *Untitled* - their text intact under *What was captured*, and their name
 *   gone. **So this puts a floor under promotion the way a contract half does**
 *   (deployment, "Migrations and rollback"), and a softer one: the repair is
 *   another change carrying these same two statements rather than a restore,
 *   since both are idempotent and would find exactly the rows that window made.
 * - **A backup taken before this.** Restored intact: `restore.ts` replays the
 *   changes the backup recorded and puts the rows back as they were, and the
 *   store then applies this the next time it is opened.
 */
const TITLE_FROM_CAPTURED_MESSAGE: Change = {
  name: '0018-title-from-captured-message',
  statements: [
    {
      sql: `UPDATE items
               SET description = captured_message
             WHERE trim(title) = ''
               AND captured_message IS NOT NULL
               AND description IS NULL
               AND ${AS_A_TITLE} <> captured_message`,
    },
    {
      sql: `UPDATE items
               SET title = ${AS_A_TITLE}
             WHERE trim(title) = ''
               AND captured_message IS NOT NULL`,
    },
  ],
};

/**
 * The account gains a list of screen sizes, and a layout gains a place to say
 * which one it is for ("Give the account a list of screen sizes, before
 * anything reads it", issue 262).
 *
 * **The expand half, and nothing else.** No command writes either, and nothing
 * drawn on screen reads them, so every account ends this change with an empty
 * list and every layout keeping NULL. That is what lets "Draw a dashboard
 * against the screen sizes its account has" (issue 263) be a change of
 * behaviour rather than of shape, and the contract half a release later again
 * drop the `name`, `folded_name` and `screen_width` a layout no longer needs.
 *
 * **`screen_size_id` is nullable and carries no CHECK.** Nullable because
 * every layout that exists predates it and nothing backfills one - which size
 * an old layout was for is a question "Draw a dashboard against the screen sizes its account has" (issue 263) answers by not
 * drawing it. No
 * CHECK because the foreign key is the constraint that matters and a width
 * bound belongs on the size, not on the pointer to it.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Interrupted partway.** It cannot be. A change's statements and the record
 *   that they ran commit in one `transactionSync` (store.ts), so the table, the
 *   column and the indexes arrive together or not at all.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left neither the table nor the column - which is why neither needs `IF NOT
 *   EXISTS`, and why a re-run over a store that somehow had them would fail
 *   loudly rather than quietly agreeing.
 * - **Rows the new rules reject.** None, and none is possible: the table is new
 *   and the column is nullable, so every row that was legal stays legal.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop, in
 *   staging and in production alike. `seed.sql` creates no layouts and no sizes.
 * - **The windows it can be interrupted in.** None that matter. The column set
 *   only grows, so every deployed release - before this and after it - reads a
 *   subset of the columns present, and a release promoted back over it reads
 *   the store it always did.
 */
const SCREEN_SIZES: Change = {
  name: '0019-screen-sizes',
  statements: [
    {
      // The numbers are written out rather than interpolated from the shared
      // constants, for the reason `0005-panels` gives: a change that has
      // shipped may never be edited, so a constant that later moves would
      // rewrite this statement for the accounts that have not applied it yet.
      sql: `CREATE TABLE \`screen_sizes\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`folded_name\` text NOT NULL,
	\`width\` integer NOT NULL,
	\`created_at\` text NOT NULL,
	CONSTRAINT "screen_sizes_width_is_a_width" CHECK(width BETWEEN 1 AND 100000),
	CONSTRAINT "screen_sizes_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE UNIQUE INDEX `screen_sizes_folded_name` ON `screen_sizes` (`tenant_id`,`folded_name`)',
    },
    {
      // The action spelled out, like every other foreign key here: SQLite's
      // default is NO ACTION, which is not what `schema.ts` declares, and
      // nothing in the constraints test compares the two - it reads the target
      // table and not the action.
      sql: 'ALTER TABLE `layouts` ADD COLUMN `screen_size_id` text REFERENCES `screen_sizes`(`id`) ON UPDATE no action ON DELETE restrict',
    },
  ],
};

/**
 * A layout's own `name`, `folded_name` and `screen_width` come off, and
 * `screen_size_id` stops being nullable - the contract half of "Draw a
 * dashboard against the screen sizes its account has" (issue 263), promised in
 * `SCREEN_SIZES` above and built once nothing reads them any more ("Take the
 * width and the name off a layout, now that its size carries them", issue 264).
 *
 * **`layouts` is dropped and rebuilt rather than altered**, and that is forced
 * rather than chosen: SQLite refuses `DROP COLUMN` for a column named in a
 * CHECK, and `screen_width` is in one, so the only way to remove it is to build
 * the table again - and a Durable Object's SQLite refuses to drop a table that
 * rows elsewhere still point at under RESTRICT, `PRAGMA foreign_keys = OFF`
 * accepted and ignored.
 *
 * **`layout_rows` and `panel_placements` are copied out before either is
 * touched, and refilled once `layouts` exists again** - deployed data is real
 * (CLAUDE.md), and a plain empty-then-rebuild would take every arrangement
 * with it rather than only the ones the new rule actually rejects, which is
 * the shape of the incident behind pull request 69. Neither table's own
 * columns change, so the copy is a bare snapshot; the refill excludes only the
 * rows naming a Layout that did not survive the rebuild.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Interrupted partway.** It cannot be, and it matters more here than in any
 *   change so far: mid-change a table exists under two names, or not at all.
 *   A change's statements and the record that they ran commit in one
 *   `transactionSync` (store.ts).
 * - **Run again.** Only an unfinished change re-runs, and an unfinished one
 *   left nothing behind - including any scratch table, which is why none needs
 *   `IF NOT EXISTS`.
 * - **Rows the new rule rejects.** A Layout with `screen_size_id IS NULL` -
 *   written by an older Worker during the previous release's deploy window,
 *   and every row that predates it - is not carried into the rebuilt table,
 *   and its rows and placements are excluded from the refill with it. Every
 *   Layout that already names a real screen size, and everything it arranges,
 *   survives untouched. **Counted over production before promoting rather
 *   than assumed** - that is the question pull request 69 got wrong.
 * - **What is actually in each environment.** The same conversion on first
 *   open. `seed.sql` creates no Layouts.
 * - **The windows it can be interrupted in.** *Before it runs*: every deployed
 *   release reads a subset of the columns present. *After it runs, with a
 *   release older than "Draw a dashboard against the screen sizes its account
 *   has" promoted back*: that code's `listLayoutsInWorkspace` selects `name`
 *   and every Workspace read fails. **The rollback floor is that issue** -
 *   going back past it needs a restore, not a promotion.
 * - **A backup taken before this.** Restored intact: `restore.ts` replays the
 *   changes the backup recorded, so the tables come back in their old shape and
 *   the store applies this one the next time it is opened.
 */
const DROP_LAYOUT_NAME_AND_WIDTH: Change = {
  name: '0020-drop-layout-name-and-width',
  statements: [
    // A bare snapshot of each, taken before either is touched - neither
    // table's own columns change, so what comes back out is exactly what went
    // in, minus what the WHERE below excludes.
    { sql: 'CREATE TABLE `panel_placements_scratch` AS SELECT * FROM `panel_placements`' },
    { sql: 'CREATE TABLE `layout_rows_scratch` AS SELECT * FROM `layout_rows`' },
    // Emptied, which is what lets `layouts` be dropped under RESTRICT - see
    // the class comment. Refilled from the scratch copies once it exists
    // again, below.
    { sql: 'DELETE FROM `panel_placements`' },
    { sql: 'DELETE FROM `layout_rows`' },
    {
      sql: `CREATE TABLE \`layouts_new\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`dashboard_id\` text NOT NULL,
	\`screen_size_id\` text NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`dashboard_id\`) REFERENCES \`dashboards\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`screen_size_id\`) REFERENCES \`screen_sizes\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "layouts_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10)))
) STRICT`,
    },
    {
      // Only a Layout the new rule can actually represent - see "Rows the new
      // rule rejects" above.
      sql: `INSERT INTO layouts_new (id, tenant_id, dashboard_id, screen_size_id, created_at)
            SELECT id, tenant_id, dashboard_id, screen_size_id, created_at
            FROM layouts
            WHERE screen_size_id IS NOT NULL`,
    },
    { sql: 'DROP TABLE `layouts`' },
    { sql: 'ALTER TABLE `layouts_new` RENAME TO `layouts`' },
    {
      sql: 'CREATE INDEX `layouts_tenant_dashboard` ON `layouts` (`tenant_id`,`dashboard_id`)',
    },
    {
      // Excludes only a row naming a Layout that did not survive the rebuild
      // above - every other row comes back exactly as it went out.
      sql: `INSERT INTO panel_placements
            SELECT * FROM panel_placements_scratch
            WHERE layout_id IN (SELECT id FROM layouts)`,
    },
    {
      sql: `INSERT INTO layout_rows
            SELECT * FROM layout_rows_scratch
            WHERE layout_id IN (SELECT id FROM layouts)`,
    },
    { sql: 'DROP TABLE `panel_placements_scratch`' },
    { sql: 'DROP TABLE `layout_rows_scratch`' },
  ],
};

/** The workspace an account nobody has opened is given, its dashboard, and its panel. */
const FIRST_WORKSPACE_ID = 'ws-1';
const FIRST_DASHBOARD_ID = `${FIRST_WORKSPACE_ID}-dashboard-1`;
/**
 * A literal rather than a derived id, unlike the two above, because five
 * commands take a `panelId` as a uuid: a derived one would leave this panel
 * unable to be renamed, deleted or filed into. The same literal in every
 * account is no more a collision than `ws-1` is - each account is its own store.
 */
const FIRST_PANEL_ID = '01920000-0000-7000-8000-000000000001';

/**
 * What an account nobody has opened starts with: one workspace, its dashboard,
 * and that dashboard's panel, all three wearing the numbered names that are how
 * the app marks what it handed you and nobody has named yet.
 *
 * **It replaces `0002-starting-workspaces`**, which gave every account Work,
 * Atlas Copco and Personal - a development fixture that reached users, one of
 * them a stranger's customer, and three names most people would have to delete
 * before they could start. That entry's own comment said it was waiting for an
 * onboarding flow to replace it; this is that replacement.
 *
 * **Removed from the list rather than edited in place.** An account that
 * already ran it keeps its three workspaces and is never revisited, which is
 * the intent: what somebody already has is theirs. Editing `0002` would not
 * have worked anyway - it runs before `0003-dashboards` and `0005-panels`
 * create their tables, so it has nowhere to put the two rows below.
 *
 * **Last in the list, and guarded, because it is not really a schema change.**
 * Every account that is ever opened runs it once, so the guard is what decides
 * whether it does anything: a store with a workspace already - the three, or
 * any made since - gets nothing at all, and only one with none gets the set.
 * **Deleted ones count**, because they are tombstones rather than gone: an
 * account that deleted every workspace is offered the screen that makes one
 * (pages/FirstWorkspacePage.tsx) rather than being handed another.
 *
 * **Each statement is guarded on the row it would write**, not merely on its
 * parent existing. Guarding the dashboard on "the workspace is there" was
 * written first and is wrong in one real case: a *restored* account replays the
 * changes its backup recorded and then takes this one, holding both `ws-1` and
 * its dashboard already - so the insert collided on the dashboards index and
 * left the account not up to date. Found by
 * tests/integration/accounts/restore.test.ts rather than by reading.
 *
 * Its failure modes, per the scoping skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): these are inserts, into a store that holds no workspaces.
 * - **If it stops halfway:** it cannot. A change's statements and the record
 *   that they ran commit in one `transactionSync` (store.ts), so a failure
 *   leaves nothing of itself behind and it is retried whole.
 * - **The second time it runs:** it does not, having been recorded. Idempotent
 *   regardless - every insert is guarded on the row it would duplicate.
 * - **Rows that already break the new rule:** an account holding workspaces,
 *   which is every account that existed before this. They are skipped, never
 *   refused and never dropped: this is bootstrap data for a store with none,
 *   not a rule being enforced on rows that already exist.
 * - **What is in each environment:** only accounts nobody has opened change,
 *   and no row anywhere is rewritten.
 */
function firstWorkspace(accountId: string): Change {
  return {
    name: '0015-first-workspace',
    statements: [
      {
        // The tint, bar, ground and header of the palette's first theme
        // (`WORKSPACE_THEMES`), written out rather than left to the column
        // defaults, so the workspace wears a set that belongs together.
        // **The names are bound, not written into the statement.** They are
        // compile-time constants rather than anything a person types, so this
        // is not about injection - it is that a name with an apostrophe in it
        // would reshape the SQL, and nothing about editing a name should make
        // somebody think about quoting.
        sql: `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, bar, ground, header, position, created_at)
                SELECT '${FIRST_WORKSPACE_ID}', ?, ?, ?, '#6f62b5', '#211d37', '#edebf7', '#18152b', 0, '2026-09-07T00:00:00.000Z'
                WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE tenant_id = ?)`,
        params: [accountId, FIRST_WORKSPACE_NAME, foldName(FIRST_WORKSPACE_NAME), accountId],
      },
      {
        // Its id is the workspace's own plus a suffix, which is what
        // `firstDashboardId` in src/domain/dashboards.ts does - the same rule in
        // both places, so a workspace's first dashboard has one id whether this
        // made it or `create_workspace` did.
        sql: `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
                SELECT '${FIRST_DASHBOARD_ID}', ?, '${FIRST_WORKSPACE_ID}', ?, ?, '2026-09-07T00:00:00.000Z'
                WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = '${FIRST_WORKSPACE_ID}' AND tenant_id = ?)
                  AND NOT EXISTS (SELECT 1 FROM dashboards WHERE id = '${FIRST_DASHBOARD_ID}' AND tenant_id = ?)`,
        params: [
          accountId,
          FIRST_DASHBOARD_NAME,
          foldName(FIRST_DASHBOARD_NAME),
          accountId,
          accountId,
        ],
      },
      {
        sql: `INSERT INTO panels (id, tenant_id, dashboard_id, name, folded_name, created_at)
                SELECT '${FIRST_PANEL_ID}', ?, '${FIRST_DASHBOARD_ID}', ?, ?, '2026-09-07T00:00:00.000Z'
                WHERE EXISTS (SELECT 1 FROM dashboards WHERE id = '${FIRST_DASHBOARD_ID}' AND tenant_id = ?)
                  AND NOT EXISTS (SELECT 1 FROM panels WHERE id = '${FIRST_PANEL_ID}' AND tenant_id = ?)`,
        params: [accountId, FIRST_PANEL_NAME, foldName(FIRST_PANEL_NAME), accountId, accountId],
      },
    ],
  };
}

/**
 * The screen size the seeded Layouts below are arranged at. **Not
 * `DEFAULT_SCREEN_SIZE_NAME`**, which `save_layout` creates by itself the first
 * time somebody arranges a Dashboard (command-service.ts): a guest may have
 * done exactly that before this change ever runs, and `screen_sizes` is unique
 * on the folded name with no tombstone to fall back on.
 */
const DEMO_SCREEN_SIZE_ID = 'guest-screen-desktop';
const DEMO_SCREEN_SIZE_NAME = 'Desktop';
const DEMO_SCREEN_WIDTH = 1440;

/**
 * The ids the demonstration's Panels, Items and Associations carry.
 *
 * **Real uuids rather than readable strings**, for the reason `FIRST_PANEL_ID`
 * above is one: five Panel commands and every Item and Association command take
 * their id as `z.uuid()`, so a seeded row with a readable id would be a row
 * nobody could rename, file or delete. Workspaces, Dashboards and Layouts take
 * no such schema, so those keep names you can read in a query.
 *
 * Counted rather than random: the whole dataset has to come out the same every
 * time it is applied.
 */
const demoId = (prefix: string, nth: number) =>
  `${prefix}-0000-7000-8000-${String(nth).padStart(12, '0')}`;
const DEMO_PANEL = '0a000000';
const DEMO_ITEM = '0b000000';
const DEMO_ASSOCIATION = '0c000000';

/** A readable, stable id for the things whose ids are not uuids: `Day to day` -> `day-to-day`. */
function demoSlug(name: string): string {
  return foldName(name)
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** Every Association one seeded Item carries, its Dashboard's Project included. */
function demoAssociations(
  item: SeedItem,
  dashboard: SeedDashboard,
): { kind: AssociationKind; label: string }[] {
  return [
    ...(dashboard.project ? [{ kind: 'project' as const, label: dashboard.project }] : []),
    ...(item.people ?? []).map((label) => ({ kind: 'person' as const, label })),
    ...(item.topics ?? []).map((label) => ({ kind: 'topic' as const, label })),
  ];
}

/**
 * What the shared guest account holds when somebody opens it: three Workspaces
 * of a contractor's week, their Dashboards arranged in rows, and the Items
 * filed on their Panels ("Seed the guest account with a full demo dataset",
 * issue 355). The content itself is in guest-seed-data.ts; this turns it into
 * rows.
 *
 * **A no-op for every other account**, decided on the account's own name rather
 * than on a flag: there is exactly one guest account and it is named in one
 * place (auth/register.ts). Everybody else applies a change with no statements,
 * which still records itself and so never runs again.
 *
 * **Generated from a structure, unlike every change above it.** That file's
 * header rule - the SQL is written out, not generated - is about *schema*:
 * there is no migration tool that can emit a Durable Object's DDL, and a
 * generated `CREATE TABLE` would be hand-edited anyway. This is bootstrap data,
 * the same kind `itemTypes` already builds from a parameter, and three hundred
 * rows written out by hand would be three hundred rows nobody re-reads.
 *
 * **Every insert is guarded twice: on the row it would write, and on the row it
 * hangs off.** The second guard is the one that matters, and it is what stops a
 * name collision breaking guest sign-in for everybody. The guest account is
 * shared and already live, so by the time this runs a visitor may have made a
 * Workspace called `Personal` of their own - and `workspaces` is unique on the
 * live folded name. That Workspace is then skipped, and because its Dashboards,
 * Panels and Items are all guarded on it existing, its whole subtree is skipped
 * with it rather than failing a foreign key and taking the transaction - and
 * the rest of the demonstration still lands. `screen_sizes` is the other table
 * a collision is possible in, which is why the size is called `Desktop` and
 * every Layout resolves its id by a subquery rather than naming the literal:
 * a Layout hangs off whichever row is actually there.
 *
 * **Nothing already in the account is touched.** The `Workspace 1` that
 * `0015-first-workspace` hands every account stays exactly where it is, beside
 * these three - additive, with nothing to overwrite.
 *
 * Its failure modes, per the scoping skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). Inserts only, and only into one account.
 * - **If it stops halfway:** it cannot. A change's statements and the record
 *   that they ran commit in one `transactionSync` (store.ts), so a failure
 *   leaves none of these rows and the whole thing is retried next time the
 *   guest account is opened.
 * - **The second time it runs:** it does not, having been recorded. Idempotent
 *   regardless - every insert is guarded on the row it would duplicate.
 * - **Rows that already break the new rule:** there is no new rule. A guest's
 *   own Workspace wearing one of these names keeps it, and is never renamed or
 *   tombstoned to make room.
 * - **What is in each environment:** the guest account is offered in
 *   development and in production and refused in staging (`GUEST_SIGN_IN`,
 *   wrangler.jsonc), so this writes rows only where somebody can reach them;
 *   every other account applies an empty change everywhere.
 * - **The windows it can be interrupted in.** *Before it runs*: the guest
 *   account holds its ordinary starter and the previous release draws it.
 *   *After it runs, with the previous release promoted back*: every row here is
 *   an ordinary Workspace, Dashboard, Panel, Layout, Item or Association in
 *   columns that release already reads, so it draws the demonstration exactly
 *   as this one does. Nothing is lost either way.
 */
function guestDemoSeed(accountId: string): Change {
  const name = '0026-guest-demo-seed';
  if (accountId !== GUEST_ACCOUNT_NAME) return { name, statements: [] };

  const at = SEEDED_AT;
  const folded = foldName(DEMO_SCREEN_SIZE_NAME);
  const taskType = `${accountId}-type-action`;
  const noteType = `${accountId}-type-thought`;
  const statements: Statement[] = [
    {
      sql: `INSERT INTO screen_sizes (id, tenant_id, name, folded_name, width, created_at)
              SELECT ?, ?, ?, ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM screen_sizes WHERE tenant_id = ? AND folded_name = ?)`,
      params: [
        DEMO_SCREEN_SIZE_ID,
        accountId,
        DEMO_SCREEN_SIZE_NAME,
        folded,
        DEMO_SCREEN_WIDTH,
        at,
        accountId,
        folded,
      ],
    },
  ];

  let panelsSoFar = 0;
  let itemsSoFar = 0;
  let associationsSoFar = 0;

  GUEST_DEMO.forEach((workspace, index) => {
    const workspaceId = `guest-ws-${demoSlug(workspace.name)}`;
    const theme = themeOf(workspace.tint);
    statements.push({
      sql: `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, bar, ground, header, position, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM workspaces WHERE tenant_id = ? AND folded_name = ? AND deleted_at IS NULL)`,
      params: [
        workspaceId,
        accountId,
        workspace.name,
        foldName(workspace.name),
        theme.tint,
        theme.bar,
        theme.ground,
        theme.header,
        // After the one `0015-first-workspace` gives every account, which
        // holds 0. A guest who has made Workspaces of their own may already
        // hold these numbers, which the column allows: `created_at` breaks the
        // tie, so the tabs still come back in one stable order.
        index + 1,
        at,
        accountId,
        foldName(workspace.name),
      ],
    });

    for (const dashboard of workspace.dashboards) {
      const under = `${demoSlug(workspace.name)}-${demoSlug(dashboard.name)}`;
      const dashboardId = `guest-db-${under}`;
      const layoutId = `guest-layout-${under}`;
      statements.push({
        sql: `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
                SELECT ?, ?, ?, ?, ?, ?
                WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND tenant_id = ?)
                  AND NOT EXISTS (SELECT 1 FROM dashboards WHERE id = ?)`,
        params: [
          dashboardId,
          accountId,
          workspaceId,
          dashboard.name,
          foldName(dashboard.name),
          at,
          workspaceId,
          accountId,
          dashboardId,
        ],
      });
      statements.push({
        sql: `INSERT INTO layouts (id, tenant_id, dashboard_id, screen_size_id, created_at)
                SELECT ?, ?, ?,
                       (SELECT id FROM screen_sizes WHERE tenant_id = ? AND folded_name = ? LIMIT 1), ?
                WHERE EXISTS (SELECT 1 FROM dashboards WHERE id = ? AND tenant_id = ?)
                  AND NOT EXISTS (SELECT 1 FROM layouts WHERE id = ?)`,
        params: [layoutId, accountId, dashboardId, accountId, folded, at, dashboardId, accountId, layoutId],
      });

      dashboard.rows.forEach((row, rowIndex) => {
        statements.push({
          // A null height is "as tall as what is in it", which is every row
          // here and is why `SeedRow` carries no number to bind.
          sql: `INSERT INTO layout_rows (tenant_id, layout_id, row_index, height)
                  SELECT ?, ?, ?, NULL
                  WHERE EXISTS (SELECT 1 FROM layouts WHERE id = ? AND tenant_id = ?)
                    AND NOT EXISTS (SELECT 1 FROM layout_rows WHERE layout_id = ? AND row_index = ?)`,
          params: [accountId, layoutId, rowIndex, layoutId, accountId, layoutId, rowIndex],
        });

        // The cells of a row divide it in proportion to their spans, so an
        // equal share each is the grid over however many Panels are on it.
        const span = Math.floor(GRID_COLUMNS / row.panels.length);

        row.panels.forEach((panel, position) => {
          panelsSoFar += 1;
          const panelId = demoId(DEMO_PANEL, panelsSoFar);
          statements.push({
            sql: `INSERT INTO panels (id, tenant_id, dashboard_id, name, folded_name, created_at)
                    SELECT ?, ?, ?, ?, ?, ?
                    WHERE EXISTS (SELECT 1 FROM dashboards WHERE id = ? AND tenant_id = ?)
                      AND NOT EXISTS (SELECT 1 FROM panels WHERE id = ?)`,
            params: [
              panelId,
              accountId,
              dashboardId,
              panel.name,
              foldName(panel.name),
              at,
              dashboardId,
              accountId,
              panelId,
            ],
          });
          statements.push({
            sql: `INSERT INTO panel_placements (tenant_id, layout_id, panel_id, row_index, position, span)
                    SELECT ?, ?, ?, ?, ?, ?
                    WHERE EXISTS (SELECT 1 FROM layouts WHERE id = ? AND tenant_id = ?)
                      AND EXISTS (SELECT 1 FROM panels WHERE id = ? AND tenant_id = ?)
                      AND NOT EXISTS (SELECT 1 FROM panel_placements WHERE layout_id = ? AND panel_id = ?)`,
            params: [
              accountId,
              layoutId,
              panelId,
              rowIndex,
              position,
              span,
              layoutId,
              accountId,
              panelId,
              accountId,
              layoutId,
              panelId,
            ],
          });

          panel.items.forEach((item, filedAt) => {
            itemsSoFar += 1;
            const itemId = demoId(DEMO_ITEM, itemsSoFar);
            statements.push({
              // `source` is `internal` because these were captured inside
              // Cockpit rather than synced from anywhere, and `status` carries
              // `DEAD_STATUS_VALUE` (schema.ts) because the column is NOT NULL
              // with a CHECK and nothing reads it. `focus_horizon` is left
              // alone: it is dead too, and what this demonstrates in its place
              // is a due date and a priority, which are live.
              sql: `INSERT INTO items (id, tenant_id, workspace_id, captured_message, source, title, description,
                                       type_id, priority, due_date, status, created_at, updated_at)
                      SELECT ?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, 'to_process', ?, ?
                      WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND tenant_id = ?)
                        AND NOT EXISTS (SELECT 1 FROM items WHERE id = ?)`,
              params: [
                itemId,
                accountId,
                workspaceId,
                item.title,
                item.title,
                item.description ?? null,
                item.note ? noteType : taskType,
                item.priority ?? null,
                item.due ?? null,
                at,
                at,
                workspaceId,
                accountId,
                itemId,
              ],
            });
            statements.push({
              sql: `INSERT INTO panel_items (tenant_id, panel_id, item_id, position, created_at)
                      SELECT ?, ?, ?, ?, ?
                      WHERE EXISTS (SELECT 1 FROM panels WHERE id = ? AND tenant_id = ?)
                        AND EXISTS (SELECT 1 FROM items WHERE id = ? AND tenant_id = ?)
                        AND NOT EXISTS (SELECT 1 FROM panel_items WHERE panel_id = ? AND item_id = ?)`,
              params: [
                accountId,
                panelId,
                itemId,
                filedAt,
                at,
                panelId,
                accountId,
                itemId,
                accountId,
                panelId,
                itemId,
              ],
            });

            for (const association of demoAssociations(item, dashboard)) {
              associationsSoFar += 1;
              const associationId = demoId(DEMO_ASSOCIATION, associationsSoFar);
              statements.push({
                sql: `INSERT INTO associations (id, tenant_id, item_id, kind, label, created_at)
                        SELECT ?, ?, ?, ?, ?, ?
                        WHERE EXISTS (SELECT 1 FROM items WHERE id = ? AND tenant_id = ?)
                          AND NOT EXISTS (SELECT 1 FROM associations WHERE id = ?)`,
                params: [
                  associationId,
                  accountId,
                  itemId,
                  association.kind,
                  association.label,
                  at,
                  itemId,
                  accountId,
                  associationId,
                ],
              });
            }
          });
        });
      });
    }
  });

  return { name, statements };
}
