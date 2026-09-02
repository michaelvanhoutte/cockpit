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
  return [ACCOUNT_SCHEMA, startingWorkspaces(accountId), DASHBOARDS, WORKSPACE_BAR];
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
  name: '0004-workspace-bar',
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
