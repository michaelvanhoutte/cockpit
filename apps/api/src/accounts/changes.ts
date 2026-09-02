import type { Change } from './up-to-date.js';

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
  return [ACCOUNT_SCHEMA, startingWorkspaces(accountId), DASHBOARDS, WORKSPACE_ORDER, PANELS];
}

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
 * The workspaces an account starts with - the same three `seed.sql` used to
 * create, moved here because nothing can reach a Durable Object from the
 * outside to seed it: `wrangler d1 execute` speaks to D1, and an account's
 * store does not exist until a request opens it.
 *
 * It is a change rather than a special case so that it is applied exactly once
 * per account and recorded like anything else. That it is *bootstrap data* in a
 * list of schema changes is deliberate and temporary, and it is the same
 * temporary thing docs/deployment.md's bootstrap runbook already records: the
 * application has no onboarding flow, and when it grows one, this entry is
 * replaced by whatever that flow creates rather than being carried forward.
 */
function startingWorkspaces(accountId: string): Change {
  return {
    name: '0002-starting-workspaces',
    statements: [
      {
        sql: `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, ground, header, created_at) VALUES
                ('ws-work', ?, 'Work', 'work', '#6f62b5', '#e3e1f2', '#d2cdea', '2026-08-12T00:00:01.000Z'),
                ('ws-atlas', ?, 'Atlas Copco', 'atlas copco', '#3a72c8', '#d8e5f7', '#bed6f2', '2026-08-12T00:00:02.000Z'),
                ('ws-personal', ?, 'Personal', 'personal', '#c06a45', '#f2e5d4', '#ead2b3', '2026-08-12T00:00:03.000Z')`,
        params: [accountId, accountId, accountId],
      },
    ],
  };
}

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
 *   that opens it, whether that account is on a laptop, in preview, in staging
 *   or in production. There is no per-environment seeding step to differ,
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
 *   no backfill, so preview (re-seeded every deploy), staging (deliberately
 *   never) and production (seeded once by hand) all get the same three empty
 *   tables. Every account applies this the next time it is opened, which is the
 *   price the account storage decision records.
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
