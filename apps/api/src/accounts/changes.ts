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
    startingWorkspaces(accountId),
    DASHBOARDS,
    WORKSPACE_ORDER,
    PANELS,
    WORKSPACE_BAR,
    PANEL_ITEMS,
    ITEM_COMPLETED_AT,
    itemTypes(accountId),
    // Last, because it is the only one here that has not shipped: the two above
    // are applied in accounts already, and a change that has shipped can never
    // be reordered any more than it can be edited.
    ITEM_TEXTS,
  ];
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
 *   is what dropping `preview` would cause, which is why that waits for its own
 *   release (deployment, "Migrations and rollback"; issue 161).
 */
const ITEM_TEXTS: Change = {
  name: '0009-item-texts',
  statements: [
    { sql: 'ALTER TABLE `items` ADD COLUMN `captured_message` text' },
    { sql: 'ALTER TABLE `items` ADD COLUMN `description` text' },
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
 * the account's, the way the starting workspaces' are, so applying this twice
 * cannot make two of them - and `INSERT OR IGNORE` says so out loud.
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
