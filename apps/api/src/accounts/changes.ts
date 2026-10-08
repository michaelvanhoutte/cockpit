import {
  FIRST_DASHBOARD_NAME,
  FIRST_PANEL_NAME,
  FIRST_WORKSPACE_NAME,
  GRID_COLUMNS,
  MOST_ACROSS,
  NAME_MAX_LENGTH,
  demoAddress,
  filterGroupingSchema,
  filterMatchSchema,
  panelFilterSchema,
  themeOf,
} from '@cockpit/shared';
import type { AssociationKind } from '@cockpit/shared';
import { GUEST_ACCOUNT_NAME } from '../auth/register.js';
import { foldName } from '../domain/names.js';
import {
  GUEST_DEMO,
  GUEST_DEMO_AGENTS,
  GUEST_DEMO_CONNECTIONS,
  GUEST_DEMO_PLACEHOLDER_CREDENTIAL,
  isFilter,
  type SeedDashboard,
  type SeedInboxItem,
  type SeedItem,
  type SeedWorkspace,
} from './guest-seed-data.js';
import {
  GETTING_STARTED_PANEL_NAME,
  GETTING_STARTED_TASKS,
  INBOX_TASK,
  type GuideTask,
} from './getting-started-data.js';
import { DEAD_STATUS_VALUE } from './schema.js';
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
    ITEM_TEXTS_PROPOSED,
    TEXT_CORRECTIONS,
    ITEM_MEANINGS,
    ACCOUNT_TEXT_RULES,
    firstWorkspace(accountId),
    DUPLICATE_SETTLEMENTS,
    PINNED_TEXT_EXAMPLES,
    ITEMS_TENANT_ID,
    ATTACHMENTS,
    REWRITE_HISTORY,
    PANEL_FILTERS,
    ITEM_DUE_DATE_SET_AT,
    CONNECTOR_ACCOUNTS,
    ITEM_FORM_PRESENTATION,
    ITEM_SOURCE_CONNECTOR,
    DASHBOARD_ORDER,
    PANEL_SORT,
    ITEM_MEANINGS_READ_AT,
    ITEM_STARTED_AT,
    CONNECTOR_ACCOUNTS_LAST_TESTED_AT,
    AGENTS,
    HIDDEN_DASHBOARD_AGENTS,
    ACCOUNT_AGENT_SETTINGS,
    AGENT_RUNS,
    CONNECTION_FAILURES,
    CLAUDE_CODE_HOOKS,
    DROP_WORKSPACE_ROUTING_SUMMARY,
    REWRITE_HISTORY_LOOKS_AT,
    REWRITE_HISTORY_PANEL_BEFORE,
    ONE_LAYOUT_PER_DASHBOARD,
    GMAIL_CONVERSATIONS,
    GMAIL_CONVERSATIONS_LISTED_IN,
    GMAIL_FOLLOWED_MARK,
    PANEL_NEVER_PROPOSE,
    gettingStarted(accountId),
    END_RUNS_ON_CLOSED_ITEMS,
    PULLED_CONNECTIONS,
    LAYOUT_ROW_TITLES,
    PULLED_OPEN_WANTED,
    gmailItemsUnderTheirConnector(accountId),
    PULLED_LINK_CHOICE,
    gmailItemsUnderTheirConnectorAgain(accountId),
    // Always last, so the demonstration is written into every column the
    // changes above leave - a Filter's conditions and an Item's start among
    // them. Append new changes above this line. The one exception to never
    // reordering a shipped change, and safe for the reason that rule exists:
    // every account but the guest applied it with no statements, so its place
    // changes nothing in them, and the guest account is dropped and rebuilt
    // from this list every night (`resetGuest`, store.ts).
    guestDemoSeed(accountId),
  ];
}

/**
 * What the generic host keeps for each connection of a source Cockpit pulls
 * from, and which Item each of its source ids became ("Check a pulled
 * connector on its cadence through the generic host", issue 891) - see
 * `schema.ts` for what each column carries.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): `CREATE` statements only. No existing row is read,
 *   rewritten or moved.
 * - **If it stops halfway:** it cannot. The statements and the record that
 *   they ran commit in one `transactionSync` (store.ts), so a store has both
 *   tables or neither, and the next request retries.
 * - **The second time it runs:** it does not, having been recorded; and every
 *   statement is `IF NOT EXISTS`, so a retry over a table somehow there is a
 *   no-op.
 * - **Rows that already break the new rule:** none - both tables start empty.
 * - **What is in each environment:** real Items, connections and Gmail rows in
 *   staging and production, none of which this touches.
 * - **Rolled back after it has run:** an older release never names either
 *   table and queues no check; the Items already filed stay as ordinary Items.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const PULLED_CONNECTIONS: Change = {
  name: '0059-pulled-connections',
  statements: [
    {
      sql: `CREATE TABLE IF NOT EXISTS \`pulled_connections\` (
	\`source_account_id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`state\` text,
	\`due_at\` text NOT NULL,
	\`queued_at\` text,
	\`run_id\` text,
	\`lease_until\` text,
	CONSTRAINT "pulled_connections_state_is_json" CHECK(state IS NULL OR json_valid(state)),
	CONSTRAINT "pulled_connections_due_at_is_timestamp" CHECK(due_at IS NULL OR (datetime(due_at) IS NOT NULL AND substr(due_at, 11, 1) = 'T' AND substr(due_at, -1) = 'Z' AND length(due_at) >= 20 AND date(due_at) = substr(due_at, 1, 10))),
	CONSTRAINT "pulled_connections_queued_at_is_timestamp" CHECK(queued_at IS NULL OR (datetime(queued_at) IS NOT NULL AND substr(queued_at, 11, 1) = 'T' AND substr(queued_at, -1) = 'Z' AND length(queued_at) >= 20 AND date(queued_at) = substr(queued_at, 1, 10))),
	CONSTRAINT "pulled_connections_lease_until_is_timestamp" CHECK(lease_until IS NULL OR (datetime(lease_until) IS NOT NULL AND substr(lease_until, 11, 1) = 'T' AND substr(lease_until, -1) = 'Z' AND length(lease_until) >= 20 AND date(lease_until) = substr(lease_until, 1, 10)))
) STRICT`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS \`pulled_links\` (
	\`tenant_id\` text NOT NULL,
	\`workspace_id\` text NOT NULL,
	\`connector_id\` text NOT NULL,
	\`external_account_key\` text NOT NULL,
	\`source_id\` text NOT NULL,
	\`item_id\` text NOT NULL,
	\`linked_at\` text NOT NULL,
	PRIMARY KEY(\`workspace_id\`, \`connector_id\`, \`external_account_key\`, \`source_id\`),
	FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "pulled_links_linked_at_is_timestamp" CHECK(linked_at IS NULL OR (datetime(linked_at) IS NOT NULL AND substr(linked_at, 11, 1) = 'T' AND substr(linked_at, -1) = 'Z' AND length(linked_at) >= 20 AND date(linked_at) = substr(linked_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE UNIQUE INDEX IF NOT EXISTS `pulled_links_one_per_item` ON `pulled_links` (`item_id`)',
    },
  ],
};

/**
 * A Section's title on a Layout's row ("Add, rename and delete a titled Section
 * on a Dashboard", issue 896) - one nullable column on `layout_rows`, null on
 * every row of Panels; `schema.ts` says what it carries.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** it cannot. One statement, committed with the
 *   record that it ran in one `transactionSync` (store.ts).
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** none can. Every existing row
 *   takes NULL, which the CHECK accepts, and reads as the row of Panels it was.
 * - **What is in each environment:** staging and production Layouts are real
 *   and keep their rows; nothing is rewritten.
 * - **Rolled back after it has run:** an older release reads rows by explicit
 *   column and drops a row with no placements, so a Section is not drawn; its
 *   next save of that Dashboard replaces the rows whole and the titles go.
 *   Accepted, since only titles are lost.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const LAYOUT_ROW_TITLES: Change = {
  name: '0060-layout-row-titles',
  statements: [
    {
      sql: `ALTER TABLE \`layout_rows\` ADD COLUMN \`title\` text CONSTRAINT "layout_rows_title_is_a_title" CHECK(title IS NULL OR length(title) BETWEEN 1 AND ${NAME_MAX_LENGTH})`,
    },
  ],
};

/**
 * What Cockpit wants a pulled source to show of an Item's open state, kept on
 * the link the host holds for the Item ("Mirror an Item's open state back to
 * a pulled source through the generic host", issue 893) - one column on
 * `pulled_links`; `schema.ts` says what it carries.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** the statement landed or did not; the change is
 *   recorded only once it has, in the same `transactionSync` (store.ts).
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** none. Every existing link takes
 *   null, which the CHECK accepts: nothing is waiting for any source.
 * - **What is in each environment:** no environment holds a pulled link
 *   outside tests yet; any that does keeps its rows whole.
 * - **Rolled back after it has run:** an older release names the columns it
 *   reads, ignores this one, and mirrors nothing - which loses nothing, the
 *   source being read afresh on its next check.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const PULLED_OPEN_WANTED: Change = {
  name: '0061-pulled-open-wanted',
  statements: [
    {
      sql: 'ALTER TABLE `pulled_links` ADD COLUMN `open_wanted` integer CONSTRAINT "pulled_links_open_wanted_is_flag" CHECK(open_wanted IS NULL OR open_wanted IN (0, 1))',
    },
  ],
};

/**
 * Every Gmail Item names its connector, `gmail`, in `source_connector` ("Store
 * Gmail Items under their connector id", issue 926), the way `asStored`
 * (domain/items.ts) writes a new one. `source` keeps `mail`, so its CHECK -
 * frozen, the Items table having children under RESTRICT - is never touched.
 * Scoped to the account's own rows, though a store holds no other.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `UPDATE` of one column, and only where it is empty.
 *   `pnpm backup:export` runs before the deploy that carries it.
 * - **If it stops halfway:** it cannot. One statement, committed with the
 *   record that it ran in one `transactionSync` (store.ts), so an account has
 *   every Gmail Item rewritten or none.
 * - **The second time it runs:** it does not, having been recorded; and its
 *   `WHERE` matches nothing once applied, so a retry changes nothing.
 * - **Rows that already break the rule:** a `mail` row already naming another
 *   connector is left as it is, reading as that connector as it already does;
 *   `leavesAlone` counts them and the store logs the count.
 * - **What is in each environment:** real Gmail Items in staging and
 *   production, rewritten in place on each account's first open after the
 *   deploy; no parameter count grows with them.
 * - **The windows it can be interrupted in.** *Before it runs*: nothing has
 *   changed. *After it*: the read serves a Gmail Item as `mail` still
 *   (`itemColumns`, repo.ts), so every installed client reads it as before.
 * - **Rolled back after it has run:** a release from "Read a connector id as
 *   an Item's source" (issue 925, merge 2fd8efb9) on reads the rewritten rows
 *   as `gmail` - which a client built before that release refuses, so roll
 *   back no further than this release while such clients remain. A release
 *   before it cannot read `gmail` at all: 2fd8efb9 is the earliest rollback
 *   target. **A rollback also leaves rows this never revisits**, being
 *   recorded (deployment.md, "Migrations and rollback", on one-shot
 *   backfills): a Gmail Item captured meanwhile is stored `mail` with no
 *   connector, and one edited under 2fd8efb9 as `internal` naming `gmail`.
 *   Both serve `mail` through the alias, so "Take source names out of the
 *   shared contract" (issue 927) carries these statements again, and covers
 *   the `internal` form, before it removes it.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
function gmailItemsUnderTheirConnector(accountId: string): Change {
  return {
    name: '0062-gmail-items-under-their-connector',
    leavesAlone: {
      count: {
        sql: `SELECT count(*) AS n FROM items
               WHERE tenant_id = ? AND source = 'mail' AND source_connector IS NOT NULL AND source_connector <> 'gmail'`,
        params: [accountId],
      },
      because: 'Gmail Items already naming another connector were left as they are',
    },
    statements: [
      {
        sql: `UPDATE items SET source_connector = 'gmail'
               WHERE tenant_id = ? AND source = 'mail' AND source_connector IS NULL`,
        params: [accountId],
      },
    ],
  };
}

/**
 * The choice a pulled connector's Item came in under, kept on its link
 * ("Close a pulled connector's Items its complete listing no longer sees",
 * issue 938) - one nullable column on `pulled_links`; `schema.ts` says what it
 * carries.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** the statement landed or did not; the change is
 *   recorded only once it has, in the same `transactionSync` (store.ts).
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** none. Every existing link takes
 *   null, which no complete listing closes: they behave as they did.
 * - **What is in each environment:** no environment holds a pulled link
 *   outside tests yet; any that does keeps its rows whole.
 * - **Rolled back after it has run:** an older release names the columns it
 *   reads and ignores this one; links filed meanwhile keep their choice for
 *   when the newer release serves again.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const PULLED_LINK_CHOICE: Change = {
  name: '0063-pulled-link-choice',
  statements: [{ sql: 'ALTER TABLE `pulled_links` ADD COLUMN `choice` text' }],
};

/**
 * Every Gmail Item stored the one way `asStored` (domain/items.ts) writes it,
 * `mail` naming `gmail`, before the read stops serving Gmail as `mail` ("Take
 * source names out of the shared contract", issue 927). The contract step of
 * `0062-gmail-items-under-their-connector`, which is recorded and so never
 * revisits a row written after it: this carries its rewrite again, for a
 * Gmail Item the previous release captured with no connector while 0062's
 * deploy rolled out, and turns one written as `internal` naming `gmail` - the
 * form a release from 2fd8efb9 to before 0062 writes on an edit - into the same
 * `mail`. Two forms would each be a read path; one is.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): two `UPDATE`s of one column each, each only where its own
 *   `WHERE` says the row is Gmail's. `pnpm backup:export` runs before the
 *   deploy that carries it.
 * - **If it stops halfway:** it cannot. Both statements commit with the record
 *   that they ran in one `transactionSync` (store.ts), so an account has every
 *   Gmail Item in the one form or none rewritten.
 * - **The second time it runs:** it does not, having been recorded; and
 *   neither `WHERE` matches a row once applied, so a retry changes nothing.
 * - **Rows that already break the rule:** a `mail` row naming another
 *   connector is left as it is, reading as that connector as it already does;
 *   `leavesAlone` counts them and the store logs the count, as 0062's does.
 *   An `internal` row naming any connector but `gmail` is a Teams or app Item,
 *   which neither statement reaches.
 * - **What is in each environment:** real Gmail Items in staging and
 *   production, nearly all already rewritten by 0062; each account rewrites
 *   what is left on its first open after the deploy. No parameter count grows
 *   with the rows.
 * - **The windows it can be interrupted in.** *Before it runs*: the release
 *   before this one still serves every Gmail form as `mail`. *After it*: every
 *   Gmail Item reads `gmail`, the same whichever form it was in.
 * - **Rolled back after it has run:** to 0062's release, a rewritten row reads
 *   as `mail` through its alias, as every row 0062 rewrote does; no further
 *   than 2fd8efb9, for 0062's reason. A Gmail Item edited under a release from
 *   2fd8efb9 to before 0062 is written `internal` naming `gmail` again, and
 *   reads as `gmail` under this one, so nothing is lost; a row written that way
 *   is not rewritten again, being recorded.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
function gmailItemsUnderTheirConnectorAgain(accountId: string): Change {
  return {
    name: '0064-gmail-items-under-their-connector-again',
    leavesAlone: {
      count: {
        sql: `SELECT count(*) AS n FROM items
               WHERE tenant_id = ? AND source = 'mail' AND source_connector IS NOT NULL AND source_connector <> 'gmail'`,
        params: [accountId],
      },
      because: 'Items stored as mail but naming a connector other than gmail were left as they are',
    },
    statements: [
      {
        sql: `UPDATE items SET source_connector = 'gmail'
               WHERE tenant_id = ? AND source = 'mail' AND source_connector IS NULL`,
        params: [accountId],
      },
      {
        sql: `UPDATE items SET source = 'mail'
               WHERE tenant_id = ? AND source = 'internal' AND source_connector = 'gmail'`,
        params: [accountId],
      },
    ],
  };
}

/**
 * Ends every run still open on an Item that is Done or dismissed ("End the
 * agent runs left open on Items already done or dismissed", issue 834). Once
 * an Item's Status ends its run ("End an Item's agent run from its Status",
 * issue 833) nothing else could end these, and their chips would stay.
 *
 * **Stamped with when the Item was closed**: its completion or its dismissal,
 * the earlier where it has both, and the run's own start where the Item was
 * closed before the run began, so no run ends before it started. Compared by
 * `julianday` rather than as text, since two valid timestamps of different
 * precision sort wrongly by bytes. Every value written is one the
 * `agent_runs_ended_at_is_timestamp` CHECK already accepts: `started_at` is
 * held by its own CHECK, `deleted_at` likewise, and `completed_at` carries
 * none but is only ever written with the same value into the CHECKed
 * `updated_at` (`applySetDone`), or copied from it by `0007-item-completed-at`.
 * A writer that sets it alone has to keep to that format, or this statement
 * fails on any account not yet opened since and that account will not open.
 * Setting `ended_at` takes a run out of `agent_runs_one_open_per_item`, so the
 * index cannot refuse it.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `UPDATE` that stamps an end time, and only on a run
 *   that had none. `pnpm backup:export` runs before the deploy that carries it.
 * - **If it stops halfway:** it cannot. One statement, committed with the
 *   record that it ran in one `transactionSync` (store.ts), so either every
 *   matching run is ended or none is.
 * - **The second time it runs:** it finds no open run on a closed Item and
 *   changes nothing.
 * - **Rows that already break the new rule:** they are the ones it targets.
 *   A run already ended keeps its end, and a run on an open Item stays open.
 * - **What is in each environment:** real runs in staging and production,
 *   ended in place on each account's first open after the deploy.
 * - **The windows it can be interrupted in.** *Before it runs*: the store is
 *   unchanged and the older code still serves. *After it*: the code that ends
 *   a run from the Item's Status serves. Each account applies it on its own
 *   first request, so no account is half-migrated.
 * - **Rolled back after it has run:** the older release reads these runs as
 *   ended, which is what its own **Agent finished** would have recorded. It
 *   is a one-shot backfill (docs/deployment.md, "Migrations and rollback"):
 *   a run left open on an Item closed while that older release serves is not
 *   ended once the newer one is back, and is repaired by another change
 *   carrying the same statement.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const END_RUNS_ON_CLOSED_ITEMS: Change = {
  name: '0058-end-runs-on-closed-items',
  statements: [
    {
      sql: `UPDATE agent_runs
               SET ended_at = CASE
                                WHEN julianday(closed.at) < julianday(agent_runs.started_at)
                                  THEN agent_runs.started_at
                                ELSE closed.at
                              END
              FROM (SELECT id,
                           CASE
                             WHEN completed_at IS NULL THEN deleted_at
                             WHEN deleted_at IS NULL THEN completed_at
                             WHEN julianday(deleted_at) < julianday(completed_at) THEN deleted_at
                             ELSE completed_at
                           END AS at
                      FROM items
                     WHERE completed_at IS NOT NULL OR deleted_at IS NOT NULL) AS closed
             WHERE closed.id = agent_runs.item_id
               AND agent_runs.ended_at IS NULL`,
    },
  ],
};

/**
 * Every Dashboard keeps the one Layout made for its widest Screen size, and
 * Screen sizes go ("Convert every Dashboard to its widest Layout and retire
 * Screen sizes", issue 713). `layouts` is rebuilt without `screen_size_id` and
 * unique on its Dashboard, and `screen_sizes` is dropped.
 *
 * **The survivor is the Layout the client was already drawing**: widest size,
 * ties to the size made earliest, then the lowest size id, then the lowest
 * Layout id - the ordering `widestLayout` held in `@cockpit/shared` until this
 * change ("Draw a Dashboard on its one Layout, with nothing to choose it by",
 * issue 712), so what a Dashboard showed before is what it shows after.
 * SQLite compares text by bytes and JavaScript by UTF-16 units; both agree on
 * the ASCII ids and ISO timestamps these columns hold.
 *
 * **Rebuilt with the arrangement copied out first**, as
 * `0020-drop-layout-name-and-width` is and for its reason: a Durable Object's
 * SQLite refuses to drop a table rows still point at under RESTRICT. The refill
 * leaves out only the rows and placements of a Layout that was not kept.
 *
 * **One release with the code that stops reading Screen sizes**, against
 * deployment.md's "Migrations and rollback", on the engineer's decision ("Give
 * a Dashboard one arrangement, and retire Layouts and Screen sizes as things
 * you choose", issue 706): the rollback floor is this release.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **It discards real rows, on purpose.** Every Layout but each Dashboard's
 *   widest, with its rows and placements, and every Screen size. Panels,
 *   filings and Items are untouched. How many Dashboards hold more than one
 *   Layout, and how many have as their only one a Layout made below 480 px, is
 *   counted over a production `pnpm backup:export` before promoting.
 * - **If it stops halfway:** it cannot. A change's statements and the record
 *   that they ran commit in one `transactionSync` (store.ts).
 * - **The second time it runs:** only an unfinished change re-runs, and an
 *   unfinished one left no scratch table, so none uses `IF NOT EXISTS`.
 * - **Rows that already break the new rule:** a Dashboard with several Layouts
 *   keeps one; the survivor cannot break "one per Dashboard" by construction.
 * - **What is in each environment:** real rows in staging and production,
 *   converted in place on first open; nothing is wiped or re-seeded.
 * - **Rolled back after it has run:** every Workspace read of an earlier
 *   release names `screen_sizes` and fails, so only a restore goes back past
 *   this release.
 * - **A backup taken before it:** restored intact - `restore.ts` replays the
 *   changes the backup recorded, so the old shape comes back, and the store
 *   converts on the restore's own bring-up-to-date.
 */
const ONE_LAYOUT_PER_DASHBOARD: Change = {
  name: '0053-one-layout-per-dashboard',
  statements: [
    { sql: 'CREATE TABLE `panel_placements_scratch` AS SELECT * FROM `panel_placements`' },
    { sql: 'CREATE TABLE `layout_rows_scratch` AS SELECT * FROM `layout_rows`' },
    // Emptied, which is what lets `layouts` be dropped under RESTRICT.
    { sql: 'DELETE FROM `panel_placements`' },
    { sql: 'DELETE FROM `layout_rows`' },
    {
      sql: `CREATE TABLE \`layouts_new\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`dashboard_id\` text NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`dashboard_id\`) REFERENCES \`dashboards\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "layouts_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10)))
) STRICT`,
    },
    {
      // Each Dashboard's widest - see the ordering above.
      sql: `INSERT INTO layouts_new (id, tenant_id, dashboard_id, created_at)
            SELECT id, tenant_id, dashboard_id, created_at
            FROM (
              SELECT l.id, l.tenant_id, l.dashboard_id, l.created_at,
                     ROW_NUMBER() OVER (
                       PARTITION BY l.dashboard_id
                       ORDER BY s.width DESC, s.created_at, s.id, l.id
                     ) AS place
              FROM layouts AS l
              JOIN screen_sizes AS s ON s.id = l.screen_size_id
            )
            WHERE place = 1`,
    },
    { sql: 'DROP TABLE `layouts`' },
    { sql: 'ALTER TABLE `layouts_new` RENAME TO `layouts`' },
    {
      // Unique, which is the rule: a Dashboard has at most one Layout. Leads
      // with `tenant_id` so it also serves every read of a Dashboard's Layout.
      sql: 'CREATE UNIQUE INDEX `layouts_one_per_dashboard` ON `layouts` (`tenant_id`,`dashboard_id`)',
    },
    {
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
    // Last, once nothing points at it.
    { sql: 'DROP TABLE `screen_sizes`' },
  ],
};

/*
 * What a smart refinement looked at, and the suggested Panel it started from
 * ("Rename Rewrite history to Smart refinements, and show each field's
 * change", issue 614) - two nullable columns on `rewrite_history`, the second
 * referencing `panels` as `proposed_panel_id` beside it does. Each is a change
 * of its own, so each is one statement tracked on its own.
 *
 * Their failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): two `ADD COLUMN`s, and no statement that writes to a row.
 * - **If it stops halfway:** the first column exists and the second does not.
 *   The first is recorded as applied, so the next open applies only the
 *   outstanding second.
 * - **The second time it runs:** neither re-runs once recorded.
 * - **Rows that already break the new rule:** there can be none. Every
 *   existing row reads NULL in both, which is exactly "recorded before this
 *   shipped", and the window says so.
 * - **What each environment does:** staging and production hold real history
 *   rows; additive only, nothing is rewritten or dropped.
 * - **The windows it can be interrupted in.** *Before it runs*: the code then
 *   deployed names neither column. *Run, with the older code still writing*
 *   (deploy skew or a rollback): its rows carry NULL in both and read as
 *   recorded before this shipped, which is true of what they hold. *Run,
 *   with this code*: the full behaviour.
 */
const REWRITE_HISTORY_LOOKS_AT: Change = {
  name: '0051-rewrite-history-looks-at',
  statements: [{ sql: 'ALTER TABLE `rewrite_history` ADD COLUMN `looks_at` text' }],
};

/** The second of the two columns above, under the same failure modes. */
const REWRITE_HISTORY_PANEL_BEFORE: Change = {
  name: '0052-rewrite-history-panel-before',
  statements: [
    {
      // The action spelled out, for the reason `0019-screen-sizes` gives.
      sql: 'ALTER TABLE `rewrite_history` ADD COLUMN `panel_before_id` text REFERENCES `panels`(`id`) ON UPDATE no action ON DELETE restrict',
    },
  ],
};

/**
 * Which Item each Gmail conversation became, and where bringing in each
 * connection's labelled conversations has got to ("Bring in the conversations
 * already labelled Cockpit as tasks", issue 725) - see `schema.ts` for what
 * each column carries and why the second table has no foreign key.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): `CREATE` statements only, and none that writes to a row.
 *   No existing row is rewritten, and no Item is linked but by the Gmail
 *   connector bringing it in.
 * - **If it stops halfway:** it cannot leave a half-built table behind, for
 *   the reason `0044-agents` gives.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none - both tables
 *   are new and start empty.
 * - **Rolled back after it has run:** an older release never names either
 *   table and arms no check, so nothing is brought in until the release goes
 *   forward again; the Items already brought in stay, as ordinary Items from
 *   Gmail. An alarm a newer release armed fires into the older one's object,
 *   which has no `alarm` and so does nothing.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const GMAIL_CONVERSATIONS: Change = {
  name: '0054-gmail-conversations',
  statements: [
    {
      sql: `CREATE TABLE IF NOT EXISTS \`gmail_conversations\` (
	\`tenant_id\` text NOT NULL,
	\`workspace_id\` text NOT NULL,
	\`mailbox_key\` text NOT NULL,
	\`thread_id\` text NOT NULL,
	\`item_id\` text NOT NULL,
	\`label_wanted\` integer,
	\`linked_at\` text NOT NULL,
	PRIMARY KEY(\`workspace_id\`, \`mailbox_key\`, \`thread_id\`),
	FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "gmail_conversations_label_wanted_is_flag" CHECK(label_wanted IS NULL OR label_wanted IN (0, 1)),
	CONSTRAINT "gmail_conversations_linked_at_is_timestamp" CHECK(linked_at IS NULL OR (datetime(linked_at) IS NOT NULL AND substr(linked_at, 11, 1) = 'T' AND substr(linked_at, -1) = 'Z' AND length(linked_at) >= 20 AND date(linked_at) = substr(linked_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE UNIQUE INDEX IF NOT EXISTS `gmail_conversations_one_per_item` ON `gmail_conversations` (`item_id`)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS \`gmail_checks\` (
	\`source_account_id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`history_id\` text NOT NULL,
	\`page_token\` text,
	\`started_at\` text NOT NULL,
	\`listed_at\` text,
	CONSTRAINT "gmail_checks_started_at_is_timestamp" CHECK(started_at IS NULL OR (datetime(started_at) IS NOT NULL AND substr(started_at, 11, 1) = 'T' AND substr(started_at, -1) = 'Z' AND length(started_at) >= 20 AND date(started_at) = substr(started_at, 1, 10))),
	CONSTRAINT "gmail_checks_listed_at_is_timestamp" CHECK(listed_at IS NULL OR (datetime(listed_at) IS NOT NULL AND substr(listed_at, 11, 1) = 'T' AND substr(listed_at, -1) = 'Z' AND length(listed_at) >= 20 AND date(listed_at) = substr(listed_at, 1, 10)))
) STRICT`,
    },
  ],
};

/**
 * Which full reconcile last found each Gmail conversation labelled ("Close a
 * Gmail task when its label comes off, and reopen it when it goes back", issue
 * 727) - one nullable column on `gmail_conversations`; `schema.ts` says what
 * it carries.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** one statement, so it cannot.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** none. Every existing link reads
 *   NULL, found by no listing yet, so the checks after it read each open one
 *   before marking any done.
 * - **Rolled back after it has run:** an older release never names the
 *   column, and closes nothing.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const GMAIL_CONVERSATIONS_LISTED_IN: Change = {
  name: '0055-gmail-conversations-listed-in',
  statements: [{ sql: 'ALTER TABLE `gmail_conversations` ADD COLUMN `listed_in` text' }],
};

/**
 * The mark each Gmail connection follows, and the one each conversation came
 * in under ("Connect Gmail by star, and bring in conversations starred from
 * then on", issue 822) - a column on `connector_accounts` and one on
 * `gmail_conversations`, each defaulting to the label; `schema.ts` says what
 * each carries.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): two `ADD COLUMN`s, and no statement that writes to a row.
 *   Every existing connection and link reads the label, which is what each
 *   followed.
 * - **If it stops halfway:** it cannot. Both statements and the record that
 *   they ran commit in one `transactionSync` (store.ts).
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** none. The default is a value
 *   the CHECK accepts, and SQLite tests it against every existing row.
 * - **Rolled back after it has run:** an older release never names either
 *   column, and checks every connection as following the label - so a star
 *   connection brings in what is labelled `Cockpit`, or fails for want of the
 *   label, until the release goes forward again. Its Items stay.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const GMAIL_FOLLOWED_MARK: Change = {
  name: '0056-gmail-followed-mark',
  statements: [
    {
      sql: `ALTER TABLE \`connector_accounts\` ADD COLUMN \`follows\` text DEFAULT 'label' NOT NULL CONSTRAINT "connector_accounts_follows_is_mark" CHECK(follows IN ('label', 'star'))`,
    },
    {
      sql: `ALTER TABLE \`gmail_conversations\` ADD COLUMN \`mark\` text DEFAULT 'label' NOT NULL CONSTRAINT "gmail_conversations_mark_is_mark" CHECK(mark IN ('label', 'star'))`,
    },
  ],
};

/**
 * Whether a Panel of items is kept out of routing proposals ("Keep a Panel out
 * of proposals with Never propose", issue 848) - one column on `panels`,
 * defaulting to unflagged; `schema.ts` says what it carries.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** the statement landed or did not; the change is
 *   recorded only once it has, in the same `transactionSync` (store.ts).
 * - **The second time it runs:** it does not, having been recorded; a store
 *   that failed before recording retries a statement that did not land.
 * - **Rows that already break the new rule:** none. Every existing Panel takes
 *   the default, unflagged, which the CHECK accepts, so proposals behave
 *   exactly as before until somebody sets it.
 * - **What is in each environment:** staging and production Panels are real
 *   and keep their rows; nothing is rewritten.
 * - **Rolled back after it has run:** an older release reads Panels by
 *   explicit column (`panelColumns`, repo.ts), ignores this one and proposes
 *   every Panel again - the flag is inert until the release returns, which
 *   loses nothing.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const PANEL_NEVER_PROPOSE: Change = {
  name: '0057-panel-never-propose',
  statements: [
    {
      sql: 'ALTER TABLE `panels` ADD COLUMN `never_propose` integer DEFAULT 0 NOT NULL CONSTRAINT "panels_never_propose_is_a_flag" CHECK(never_propose IN (0, 1))',
    },
  ],
};

/**
 * The contract half of `0025-workspace-routing-summary` ("Drop the
 * workspace_routing_summary table", issue 401): nothing has read the table
 * since "Cap the routing prompt to the last 50 decisions on panels that still
 * exist, and drop the correction override" (issue 450), and nothing has written
 * it since "Remove the two learning settings screens, and the commands that
 * write to them" (issue 452).
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **It deletes real data, on purpose.** `correction` is a sentence somebody
 *   wrote, and after this it exists only in a backup - so a production
 *   `pnpm backup:export` is taken and its `workspace_routing_summary` rows are
 *   read before this is promoted (deployment, "Migrations and rollback").
 * - **If it stops halfway:** it cannot. One statement, and nothing rides
 *   beside it; the table's index goes with the table.
 * - **The second time it runs:** `IF EXISTS`, so a store whose table is
 *   already gone records it and carries on rather than failing every request
 *   that opens the account.
 * - **Rows that already break the new rule:** every row goes, which is the
 *   first line of this list.
 * - **Rolled back after it has run:** no release since issue 450 names the
 *   table, so promotion can go back that far and no further (deployment,
 *   "Migrations and rollback").
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, putting the table and its rows back, then brings the account up
 *   to date - which drops them again. The file keeps them.
 */
const DROP_WORKSPACE_ROUTING_SUMMARY: Change = {
  name: '0050-drop-workspace-routing-summary',
  statements: [{ sql: 'DROP TABLE IF EXISTS `workspace_routing_summary`' }],
};

/**
 * How a Panel of items is sorted ("Sort a panel of items by the fields you
 * choose", issue 526) - see `schema.ts` for what the column carries. One
 * nullable column and nothing else, the shape `PANEL_FILTERS` is.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** it cannot. One statement, and a change's
 *   statements and the record that they ran commit in one `transactionSync`
 *   (store.ts) - SQLite has no `ADD COLUMN IF NOT EXISTS` for a half-applied
 *   change to re-run over.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none. Every Panel
 *   takes NULL, which is Manual - the order it was already drawn in.
 * - **Rolled back after it has run:** an older release never reads the column,
 *   so a sorted Panel is drawn in the order you set until the release goes
 *   forward again; the filings were never touched.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const PANEL_SORT: Change = {
  name: '0040-panel-sort',
  statements: [{ sql: 'ALTER TABLE `panels` ADD COLUMN `sort_criteria` text' }],
};

/**
 * An index on when a note was read, so the change stream's poll answers "any
 * reading newer than my cursor?" by range rather than by visiting every reading
 * the account holds (`collectInvalidations`, events.ts). Every open tab asks
 * every three seconds, and `item_meanings_tenant_item` narrows by `tenant_id`
 * alone for that question.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `CREATE INDEX`, and no statement that writes to a row.
 * - **If it stops halfway:** it cannot. One statement, and a change's
 *   statements and the record that they ran commit in one `transactionSync`
 *   (store.ts).
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none. The index is
 *   on a non-unique column, so it cannot reject a row.
 * - **Rolled back after it has run:** an older release never names the index,
 *   and the table it sits on is one it already reads, so nothing changes but
 *   the polls costing what they did.
 * - **What it costs to build:** one pass over the account's readings, inside the
 *   request that first opens the account after a deploy. Bounded by what one
 *   poll cost before it.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes and brings the account up to date, so this one applies then.
 */
const ITEM_MEANINGS_READ_AT: Change = {
  name: '0041-item-meanings-read-at',
  statements: [
    {
      sql: 'CREATE INDEX `item_meanings_tenant_read_at` ON `item_meanings` (`tenant_id`,`read_at`)',
    },
  ],
};

/**
 * When work on an Item started, so it can be In progress rather than only To
 * do or Done ("Mark an item In progress, and see since when", issue 568) -
 * see `schema.ts` for what the column carries.
 *
 * **One `ADD COLUMN` and no backfill.** Every existing Item already reads as
 * To do or Done exactly as it did before this shipped - `itemStatus`
 * (`@cockpit/shared`) only calls something In progress once this column holds
 * a time, and nothing here can have written one yet.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** it cannot. One statement, and a change's
 *   statements and the record that they ran commit in one `transactionSync`
 *   (store.ts).
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none - every
 *   existing Item reads with no start time, which is To do or Done exactly as
 *   it is today.
 * - **Rolled back after it has run:** an older release never names the
 *   column, so a row an In progress Item wrote reads there as an ordinary To
 *   do Item until the next release, and loses nothing.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes and brings the account up to date, so this one applies then.
 */
const ITEM_STARTED_AT: Change = {
  name: '0042-item-started-at',
  statements: [{ sql: 'ALTER TABLE `items` ADD COLUMN `started_at` text' }],
};

/**
 * When a connected source account was last proven to still work ("Connect a
 * workspace to Claude Code", issue 569) - see `schema.ts` for what the column
 * carries and why it has no CHECK, the shape `PANEL_SORT` above uses for the
 * same reason.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** it cannot. One statement, and a change's
 *   statements and the record that they ran commit in one `transactionSync`
 *   (store.ts).
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none. Every
 *   connected source account takes NULL, which the window reads as "not
 *   tested since this shipped" until its next connect, reconnect or Test
 *   again.
 * - **Rolled back after it has run:** an older release never reads the
 *   column, so a connection tested under the new release simply looks
 *   untested again until the release goes forward.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const CONNECTOR_ACCOUNTS_LAST_TESTED_AT: Change = {
  name: '0043-connector-accounts-last-tested-at',
  statements: [
    { sql: 'ALTER TABLE `connector_accounts` ADD COLUMN `last_tested_at` text' },
  ],
};

/**
 * Every Agent an account has made ("Keep your agents in a dock, and choose
 * which each dashboard shows", issue 570) - see `schema.ts` for what each
 * column carries and why it is created whole, with `position` and
 * `deleted_at` already on it, the same reason `0008-item-types` gives.
 *
 * The colour and engine lists are written out rather than built from
 * `AGENT_COLORS`/`AGENT_ENGINES`, for the reason `0006-panel-items`'s own
 * position bound is: a change that has shipped may never be edited, and a
 * constant that later moved would rewrite this statement for the accounts
 * that had not applied it yet. The constraints test is what notices if the
 * two stop agreeing.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): two `CREATE` statements, and no statement that writes to
 *   a row.
 * - **If it stops halfway:** it cannot leave a half-built table behind - a
 *   change's statements and the record that they ran commit in one
 *   `transactionSync` (store.ts), and both statements are `IF NOT EXISTS`.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none - the table
 *   is new and starts empty.
 * - **Rolled back after it has run:** an older release never names the
 *   table, so an Agent made under the new release is simply unread until the
 *   release goes forward again.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const AGENTS: Change = {
  name: '0044-agents',
  statements: [
    {
      sql: `CREATE TABLE IF NOT EXISTS \`agents\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`folded_name\` text NOT NULL,
	\`color\` text NOT NULL,
	\`engine\` text NOT NULL,
	\`message\` text NOT NULL,
	\`asks_for_prompt\` integer NOT NULL,
	\`starts_in_progress\` integer NOT NULL,
	\`position\` integer DEFAULT 0 NOT NULL,
	\`created_at\` text NOT NULL,
	\`deleted_at\` text,
	CONSTRAINT "agents_color_is_known" CHECK(color IN ('#6f62b5', '#3a72c8', '#c06a45', '#3f8f78', '#a8548c', '#b58a2f', '#4f8fa8', '#7d8f3f')),
	CONSTRAINT "agents_engine_is_known" CHECK(engine IN ('claude-code')),
	CONSTRAINT "agents_position_is_an_order" CHECK(position >= 0),
	CONSTRAINT "agents_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10))),
	CONSTRAINT "agents_deleted_at_is_timestamp" CHECK(deleted_at IS NULL OR (datetime(deleted_at) IS NOT NULL AND substr(deleted_at, 11, 1) = 'T' AND substr(deleted_at, -1) = 'Z' AND length(deleted_at) >= 20 AND date(deleted_at) = substr(deleted_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE UNIQUE INDEX IF NOT EXISTS `agents_tenant_live_folded_name` ON `agents` (`tenant_id`,`folded_name`) WHERE `deleted_at` IS NULL',
    },
  ],
};

/**
 * Which Agents are hidden on which Dashboard ("Hiding and showing are per
 * dashboard", issue 570) - see `schema.ts` for why neither `dashboards` nor
 * `agents` needs cleaning up after by this table's own RESTRICT.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored**: two `CREATE`
 *   statements, and no statement that writes to a row.
 * - **If it stops halfway:** it cannot leave a half-built table behind, for
 *   the reason `0044-agents` above gives.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none - the table
 *   is new and starts empty.
 * - **Rolled back after it has run:** an older release never names the
 *   table, so a hide made under the new release is simply unread until the
 *   release goes forward again - every Agent shows on every Dashboard again
 *   in the meantime, which is the safe direction for this to fail towards.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const HIDDEN_DASHBOARD_AGENTS: Change = {
  name: '0045-hidden-dashboard-agents',
  statements: [
    {
      sql: `CREATE TABLE IF NOT EXISTS \`hidden_dashboard_agents\` (
	\`tenant_id\` text NOT NULL,
	\`dashboard_id\` text NOT NULL,
	\`agent_id\` text NOT NULL,
	\`hidden_at\` text NOT NULL,
	PRIMARY KEY(\`dashboard_id\`, \`agent_id\`),
	FOREIGN KEY (\`dashboard_id\`) REFERENCES \`dashboards\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`agent_id\`) REFERENCES \`agents\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "hidden_dashboard_agents_hidden_at_is_timestamp" CHECK(hidden_at IS NULL OR (datetime(hidden_at) IS NOT NULL AND substr(hidden_at, 11, 1) = 'T' AND substr(hidden_at, -1) = 'Z' AND length(hidden_at) >= 20 AND date(hidden_at) = substr(hidden_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS `hidden_dashboard_agents_tenant_dashboard` ON `hidden_dashboard_agents` (`tenant_id`,`dashboard_id`)',
    },
  ],
};

/**
 * Every run an Agent has had on an Item ("Drop an agent on an item to start a
 * Claude Code session on it", issue 571) - see `schema.ts` for what each
 * column carries and why `agent_id` has no foreign key.
 *
 * The status list is written out rather than built from `AGENT_RUN_STATUSES`,
 * for the reason `0044-agents` gives for its own colour list.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): `CREATE` statements only, and none that writes to a row.
 * - **If it stops halfway:** it cannot leave a half-built table behind, for
 *   the reason `0044-agents` gives.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none - the table
 *   is new and starts empty.
 * - **Rolled back after it has run:** an older release never names the
 *   table, so a run started under the new release is simply unread - its
 *   Claude Code session goes on at claude.ai, and the row shows no chip -
 *   until the release goes forward again.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const AGENT_RUNS: Change = {
  name: '0047-agent-runs',
  statements: [
    {
      sql: `CREATE TABLE IF NOT EXISTS \`agent_runs\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`workspace_id\` text NOT NULL,
	\`item_id\` text NOT NULL,
	\`agent_id\` text NOT NULL,
	\`status\` text NOT NULL,
	\`session_url\` text,
	\`reason\` text,
	\`started_at\` text NOT NULL,
	\`settled_at\` text,
	\`ended_at\` text,
	FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_runs_status_is_known" CHECK(status IN ('starting', 'working', 'link_lost', 'unknown', 'failed')),
	CONSTRAINT "agent_runs_started_at_is_timestamp" CHECK(started_at IS NULL OR (datetime(started_at) IS NOT NULL AND substr(started_at, 11, 1) = 'T' AND substr(started_at, -1) = 'Z' AND length(started_at) >= 20 AND date(started_at) = substr(started_at, 1, 10))),
	CONSTRAINT "agent_runs_settled_at_is_timestamp" CHECK(settled_at IS NULL OR (datetime(settled_at) IS NOT NULL AND substr(settled_at, 11, 1) = 'T' AND substr(settled_at, -1) = 'Z' AND length(settled_at) >= 20 AND date(settled_at) = substr(settled_at, 1, 10))),
	CONSTRAINT "agent_runs_ended_at_is_timestamp" CHECK(ended_at IS NULL OR (datetime(ended_at) IS NOT NULL AND substr(ended_at, 11, 1) = 'T' AND substr(ended_at, -1) = 'Z' AND length(ended_at) >= 20 AND date(ended_at) = substr(ended_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE UNIQUE INDEX IF NOT EXISTS `agent_runs_one_open_per_item` ON `agent_runs` (`item_id`) WHERE `ended_at` IS NULL',
    },
    {
      sql: 'CREATE INDEX IF NOT EXISTS `agent_runs_tenant_workspace_open` ON `agent_runs` (`tenant_id`,`workspace_id`,`ended_at`)',
    },
  ],
};

/**
 * Why Claude last refused a Claude Code connection (issue 571) - see
 * `schema.ts` for why it is a table of its own with no foreign key.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored**: one `CREATE TABLE`,
 *   and no statement that writes to a row.
 * - **If it stops halfway:** it cannot. One statement, committed with the
 *   record that it ran.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none - the table
 *   is new and starts empty.
 * - **Rolled back after it has run:** an older release never names the
 *   table, so every connection reads as not failing until the release goes
 *   forward again.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const CONNECTION_FAILURES: Change = {
  name: '0048-connection-failures',
  statements: [
    {
      sql: `CREATE TABLE IF NOT EXISTS \`connection_failures\` (
	\`source_account_id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`reason\` text NOT NULL,
	\`failed_at\` text NOT NULL,
	CONSTRAINT "connection_failures_failed_at_is_timestamp" CHECK(failed_at IS NULL OR (datetime(failed_at) IS NOT NULL AND substr(failed_at, 11, 1) = 'T' AND substr(failed_at, -1) = 'Z' AND length(failed_at) >= 20 AND date(failed_at) = substr(failed_at, 1, 10)))
) STRICT`,
    },
  ],
};

/**
 * What Claude Code hooks have said ("See on the item when Claude is waiting on
 * you", issue 572): whether each run's session is waiting on you, and when a
 * hook last reached each connection - see `schema.ts` for why both are tables
 * of their own with no foreign key.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): `CREATE TABLE` statements only, and none that writes to a
 *   row.
 * - **If it stops halfway:** it cannot leave a half-built table behind, for
 *   the reason `0044-agents` gives.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none - both tables
 *   are new and start empty.
 * - **Rolled back after it has run:** an older release never names either
 *   table, so every run reads as working and hooks are refused as an unknown
 *   address until the release goes forward again.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const CLAUDE_CODE_HOOKS: Change = {
  name: '0049-claude-code-hooks',
  statements: [
    {
      sql: `CREATE TABLE IF NOT EXISTS \`agent_run_activity\` (
	\`run_id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`waiting\` integer NOT NULL,
	\`reported_at\` text NOT NULL,
	CONSTRAINT "agent_run_activity_waiting_is_flag" CHECK(waiting IN (0, 1)),
	CONSTRAINT "agent_run_activity_reported_at_is_timestamp" CHECK(reported_at IS NULL OR (datetime(reported_at) IS NOT NULL AND substr(reported_at, 11, 1) = 'T' AND substr(reported_at, -1) = 'Z' AND length(reported_at) >= 20 AND date(reported_at) = substr(reported_at, 1, 10)))
) STRICT`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS \`claude_code_hook_arrivals\` (
	\`source_account_id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`arrived_at\` text NOT NULL,
	CONSTRAINT "claude_code_hook_arrivals_arrived_at_is_timestamp" CHECK(arrived_at IS NULL OR (datetime(arrived_at) IS NOT NULL AND substr(arrived_at, 11, 1) = 'T' AND substr(arrived_at, -1) = 'Z' AND length(arrived_at) >= 20 AND date(arrived_at) = substr(arrived_at, 1, 10)))
) STRICT`,
    },
  ],
};

/**
 * The account-wide switch for the Agent that was built in rather than made
 * (issue 570) - one row per account. Nothing reads it any more; dropping the
 * table is its own, contract, change.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored**: one `CREATE TABLE`,
 *   and no statement that writes to a row.
 * - **If it stops halfway:** it cannot. One statement, and a change's
 *   statements and the record that they ran commit in one `transactionSync`
 *   (store.ts).
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none - the table
 *   is new and starts empty.
 * - **Rolled back after it has run:** an older release never names the
 *   table, so a switch thrown under the new release is simply unread until
 *   the release goes forward again.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const ACCOUNT_AGENT_SETTINGS: Change = {
  name: '0046-account-agent-settings',
  statements: [
    {
      sql: `CREATE TABLE IF NOT EXISTS \`account_agent_settings\` (
	\`tenant_id\` text PRIMARY KEY NOT NULL,
	\`ask_claude_enabled\` integer NOT NULL
) STRICT`,
    },
  ],
};

/**
 * Where a dashboard sits in its workspace's bar ("Reorder a workspace's
 * dashboards by dragging their tabs", issue 503) - see `schema.ts` for what the
 * column carries and why.
 *
 * **One `ADD COLUMN` and no backfill**, which is the one thing this does not
 * copy from `0004-workspace-order`; `schema.ts` carries what that costs the
 * read.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** it cannot. One statement, and a change's statements
 *   and the record that they ran commit in one `transactionSync` (store.ts) -
 *   load-bearing rather than a nicety, SQLite having no
 *   `ADD COLUMN IF NOT EXISTS` for a half-applied change to re-run over.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none. Every dashboard
 *   takes 0, which the read treats as "nobody has moved these yet".
 * - **Rolled back after it has run:** an older release names neither the column
 *   nor the command, and orders the bar by `created_at` alone - so an order
 *   somebody chose is simply unread until the release goes forward again.
 * - **A backup restored from before it:** the restore replays the changes that
 *   backup recorded - which do not include this one - and then brings the
 *   account up to date at the end of the restore itself (`restoreFrom`,
 *   store.ts), so the column is back before the next request. The exception is
 *   a backup that recorded no changes at all, which is left untouched on
 *   purpose and takes them on its first open.
 */
const DASHBOARD_ORDER: Change = {
  name: '0039-dashboard-order',
  statements: [
    { sql: 'ALTER TABLE `dashboards` ADD COLUMN `position` integer DEFAULT 0 NOT NULL' },
  ],
};

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
 * The append-only decision history a routing proposal reads from, bounded
 * rather than whole ("Learn where notes belong from where you actually file
 * them", issue 299) - see `schema.ts` for what each column carries and why.
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
 * One new, additive table, since dropped by `0050-drop-workspace-routing-summary`
 * ("Drop the workspace_routing_summary table", issue 401); this is its
 * failure-mode account, per the scoping skill, for "Show what the system
 * learned, in a sentence you can correct", issue 301:
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
 * When Cockpit proposed an Item's texts, so a real proposal can be told apart
 * from the mechanical write `capture_item` makes to the same two columns
 * ("Learn how you write from the titles you correct", issue 394;
 * `docs/text-learning.md`, "What is stored") - the same shape
 * `0021-item-texts-settled` is.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It adds a column and writes to no row.
 * - **Interrupted partway.** It cannot be: a change's statement and the record
 *   that it ran commit together (up-to-date.ts), so a failure leaves no column
 *   and the change is retried whole.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left no column. Nothing is written to any row, so a second run doubles
 *   nothing.
 * - **Data the new rules reject.** None. The column starts null on every row -
 *   the honest answer for every Item captured before this ships, since
 *   Cockpit does not know whether it proposed that Item's texts, and this
 *   column says so by staying empty rather than guessing.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop,
 *   in staging and in production alike.
 * - **The windows it can be interrupted in.** Two, and both are safe because
 *   this is additive. *Before it runs*, the code in front of it is the
 *   previous release, which does not name the column. *After it runs, with
 *   that release promoted back*, its reads name a subset of the columns that
 *   exist, and its writes never reach this one - so the worst a rollback costs
 *   is a proposal from after it going unrecorded as a proposal until the
 *   release goes forward again.
 */
const ITEM_TEXTS_PROPOSED: Change = {
  name: '0026-item-texts-proposed',
  statements: [{ sql: 'ALTER TABLE `items` ADD COLUMN `texts_proposed_at` text' }],
};

/**
 * The store a title or description proposal reads back ("Learn how you write
 * from the titles you correct", issue 394) - see `schema.ts` for what each
 * column carries and why.
 *
 * **A brand new table, created whole with its CHECKs**, the same shape
 * `DECISION_HISTORY` above uses and for the same reason: a table created here
 * can carry a CHECK from the start, unlike a column added to `items`, which
 * cannot be rebuilt while other tables point at it under RESTRICT.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It adds a table and writes to no existing row.
 * - **Interrupted partway.** It cannot be: the statements and the record that
 *   they ran commit together (`up-to-date.ts`), so a failure leaves neither
 *   the table nor the index and the change is retried whole.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left nothing behind.
 * - **Data the new rules reject.** None: the table starts empty, and nothing
 *   sweeps past edits into it. History accumulates from this shipping
 *   forward, the same precedent `DECISION_HISTORY` set.
 * - **What each environment does.** The same thing everywhere: an account
 *   applies its outstanding changes inside the first request that opens it.
 */
const TEXT_CORRECTIONS: Change = {
  name: '0027-text-corrections',
  statements: [
    {
      sql: `CREATE TABLE \`text_corrections\` (
	\`item_id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`captured_message\` text NOT NULL,
	\`proposed_title\` text NOT NULL,
	\`proposed_description\` text,
	\`settled_title\` text NOT NULL,
	\`settled_description\` text,
	\`recorded_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "text_corrections_recorded_at_is_timestamp" CHECK(recorded_at IS NULL OR (datetime(recorded_at) IS NOT NULL AND substr(recorded_at, 11, 1) = 'T' AND substr(recorded_at, -1) = 'Z' AND length(recorded_at) >= 20 AND date(recorded_at) = substr(recorded_at, 1, 10))),
	CONSTRAINT "text_corrections_updated_at_is_timestamp" CHECK(updated_at IS NULL OR (datetime(updated_at) IS NOT NULL AND substr(updated_at, 11, 1) = 'T' AND substr(updated_at, -1) = 'Z' AND length(updated_at) >= 20 AND date(updated_at) = substr(updated_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX `text_corrections_tenant_recorded` ON `text_corrections` (`tenant_id`,`recorded_at`)',
    },
  ],
};

/**
 * What each Item means, and which Items mean the same thing ("Flag a captured
 * note that says what another one already said", issue 407) - see `schema.ts`
 * for what each column carries and why.
 *
 * **Two brand new tables, created whole with their CHECKs** - the same shape
 * `DECISION_HISTORY` and `WORKSPACE_ROUTING_SUMMARY` above use, and for the
 * reason this file gives for both: a table created here carries its CHECKs from
 * the start, unlike a column added to `items`, which cannot be rebuilt while
 * other tables point at it under RESTRICT. `item_duplicates_is_one_unordered_pair`
 * is the one that matters - it is what makes a pair one row rather than two.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It creates two tables and writes to no existing row.
 * - **Interrupted partway.** It cannot be: the statements and the record that
 *   they ran commit together (up-to-date.ts), so a failure leaves neither table
 *   and the change is retried whole.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left nothing behind.
 * - **Data the new rules reject.** None: both tables start empty. Every Item
 *   captured before this shipped therefore has no reading and takes part in
 *   nothing until the operator's own command reads them ("Give every item
 *   already there a vector", issue 409) - the same precedent issue 296 set for
 *   title cleanup.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop, in
 *   staging and in production alike.
 * - **The windows it can be interrupted in.** Two, and both are safe because
 *   this is additive. *Before it runs*, the code in front of it is the previous
 *   release, which names neither table. *After it runs, with that release
 *   promoted back*, its reads name neither table either - so the worst a
 *   rollback costs is a set of readings nobody looks at until the release goes
 *   forward again.
 */
const ITEM_MEANINGS: Change = {
  name: '0028-item-meanings',
  statements: [
    {
      sql: `CREATE TABLE \`item_meanings\` (
	\`item_id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`model\` text NOT NULL,
	\`reading\` text NOT NULL,
	\`read_at\` text NOT NULL,
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "item_meanings_read_at_is_timestamp" CHECK(read_at IS NULL OR (datetime(read_at) IS NOT NULL AND substr(read_at, 11, 1) = 'T' AND substr(read_at, -1) = 'Z' AND length(read_at) >= 20 AND date(read_at) = substr(read_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX `item_meanings_tenant_item` ON `item_meanings` (`tenant_id`,`item_id`)',
    },
    {
      sql: `CREATE TABLE \`item_duplicates\` (
	\`tenant_id\` text NOT NULL,
	\`item_id\` text NOT NULL,
	\`other_item_id\` text NOT NULL,
	\`how_alike\` real NOT NULL,
	\`found_at\` text NOT NULL,
	PRIMARY KEY(\`item_id\`, \`other_item_id\`),
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`other_item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "item_duplicates_is_one_unordered_pair" CHECK(item_id < other_item_id),
	CONSTRAINT "item_duplicates_found_at_is_timestamp" CHECK(found_at IS NULL OR (datetime(found_at) IS NOT NULL AND substr(found_at, 11, 1) = 'T' AND substr(found_at, -1) = 'Z' AND length(found_at) >= 20 AND date(found_at) = substr(found_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX `item_duplicates_tenant_item` ON `item_duplicates` (`tenant_id`,`item_id`)',
    },
    {
      sql: 'CREATE INDEX `item_duplicates_tenant_other` ON `item_duplicates` (`tenant_id`,`other_item_id`)',
    },
  ],
};

/**
 * The account-scoped box for the rules an account writes for how Cockpit
 * writes a title and a message ("Show what Cockpit is told, and say how you
 * want it changed", issue 398) - see `schema.ts` for what the column carries
 * and why.
 *
 * **Numbered `0029`, not `0028`**, despite being written against the same
 * base as `ITEM_MEANINGS` above: that change merged to `main` first, so its
 * name is already shipped and cannot be touched, and a second, different
 * `0028` name here would only be untidy in a way this file's own comment
 * warns is not worth the risk of an edit - a *duplicate* name is the fault
 * that actually breaks an account, not a shared number, but this one was
 * still free to avoid before either shipped.
 *
 * **A brand new table, created whole with its CHECK**, the same shape
 * `TEXT_CORRECTIONS` above uses and for the same reason: a table created here
 * can carry a CHECK from the start, unlike a column added to an existing
 * table.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It adds a table and writes to no existing row.
 * - **Interrupted partway.** It cannot be: the statement and the record that
 *   it ran commit together (`up-to-date.ts`), so a failure leaves neither the
 *   table nor the row and the change is retried whole.
 * - **Run again.** Only an unfinished change runs again, and an unfinished
 *   one left nothing behind.
 * - **Data the new rules reject.** None: the table starts empty, and nothing
 *   sweeps past text into it. An account's rules exist only from the moment
 *   it writes them.
 * - **What each environment does.** The same thing everywhere: an account
 *   applies its outstanding changes inside the first request that opens it.
 */
const ACCOUNT_TEXT_RULES: Change = {
  name: '0029-account-text-rules',
  statements: [
    {
      sql: `CREATE TABLE \`account_text_rules\` (
	\`tenant_id\` text PRIMARY KEY NOT NULL,
	\`rules\` text,
	\`rules_set_at\` text,
	CONSTRAINT "account_text_rules_rules_set_at_is_timestamp" CHECK(rules_set_at IS NULL OR (datetime(rules_set_at) IS NOT NULL AND substr(rules_set_at, 11, 1) = 'T' AND substr(rules_set_at, -1) = 'Z' AND length(rules_set_at) >= 20 AND date(rules_set_at) = substr(rules_set_at, 1, 10)))
) STRICT`,
    },
  ],
};

/**
 * A pair somebody has said is not a duplicate ("Say a flagged pair is not a
 * duplicate", issue 408) - see `schema.ts` for what each column carries and
 * why.
 *
 * **Numbered `0030`**, for the same reason `ACCOUNT_TEXT_RULES` above is
 * `0029` rather than `0028`: that number was free when this change was
 * written and taken by `ACCOUNT_TEXT_RULES` merging to `main` first.
 *
 * **A brand new table, created whole with its CHECKs**, the same shape
 * `ITEM_MEANINGS` above uses and for the same reason: a table created here
 * carries its CHECKs from the start, unlike a column added to `items` or to
 * `item_duplicates`, which cannot be rebuilt while other tables point at them
 * under RESTRICT.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It creates one table and writes to no existing row.
 * - **Interrupted partway.** It cannot be: the statements and the record that
 *   they ran commit together (up-to-date.ts), so a failure leaves neither the
 *   table nor its indexes and the change is retried whole.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left nothing behind.
 * - **Data the new rules reject.** None: the table starts empty, and nothing
 *   sweeps a settling into it after the fact - it is only ever written by the
 *   command that settles a pair, from this release forward.
 * - **What each environment does.** The same thing: an account applies its
 *   outstanding changes inside the first request that opens it, on a laptop,
 *   in staging and in production alike.
 * - **The windows it can be interrupted in.** Two, and both are safe because
 *   this is additive. *Before it runs*, the code in front of it is the
 *   previous release, which names neither the table nor the command. *After
 *   it runs, with that release promoted back*, its reads name neither either
 *   - so the worst a rollback costs is a settling nobody reads until the
 *   release goes forward again.
 */
const DUPLICATE_SETTLEMENTS: Change = {
  name: '0030-duplicate-settlements',
  statements: [
    {
      sql: `CREATE TABLE \`duplicate_settlements\` (
	\`tenant_id\` text NOT NULL,
	\`item_id\` text NOT NULL,
	\`other_item_id\` text NOT NULL,
	\`settled_at\` text NOT NULL,
	PRIMARY KEY(\`item_id\`, \`other_item_id\`),
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`other_item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "duplicate_settlements_is_one_unordered_pair" CHECK(item_id < other_item_id),
	CONSTRAINT "duplicate_settlements_settled_at_is_timestamp" CHECK(settled_at IS NULL OR (datetime(settled_at) IS NOT NULL AND substr(settled_at, 11, 1) = 'T' AND substr(settled_at, -1) = 'Z' AND length(settled_at) >= 20 AND date(settled_at) = substr(settled_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX `duplicate_settlements_tenant_item` ON `duplicate_settlements` (`tenant_id`,`item_id`)',
    },
    {
      sql: 'CREATE INDEX `duplicate_settlements_tenant_other` ON `duplicate_settlements` (`tenant_id`,`other_item_id`)',
    },
  ],
};

/**
 * The account's own pinned examples of how a note should be written ("Pin
 * an example of how you want a note written", issue 397) - see `schema.ts`
 * for what each column carries and why.
 *
 * **Numbered `0031`, not `0030`**, for the same reason `ACCOUNT_TEXT_RULES`
 * above is `0029` rather than `0028`: `0030` was free when this change was
 * first written and taken by `DUPLICATE_SETTLEMENTS` above merging to
 * `main` first.
 *
 * **A brand new table, created whole with its CHECKs**, the same shape
 * `TEXT_CORRECTIONS` and `ACCOUNT_TEXT_RULES` above use and for the same
 * reason: a table created here can carry a CHECK from the start, unlike a
 * column added to an existing table.
 *
 * The failure-mode questions the `scoping` skill asks of a change that
 * cannot put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md,
 *   "Deployed data is real"). It adds a table and writes to no existing row.
 * - **Interrupted partway.** It cannot be: the statements and the record
 *   that they ran commit together (`up-to-date.ts`), so a failure leaves
 *   neither the table nor the index and the change is retried whole.
 * - **Run again.** Only an unfinished change runs again, and an unfinished
 *   one left nothing behind.
 * - **Data the new rules reject.** None: the table starts empty, and
 *   nothing sweeps past existing text into it. An account's pinned examples
 *   exist only from the moment it adds one.
 * - **What each environment does.** The same thing everywhere: an account
 *   applies its outstanding changes inside the first request that opens it.
 */
const PINNED_TEXT_EXAMPLES: Change = {
  name: '0031-pinned-text-examples',
  statements: [
    {
      sql: `CREATE TABLE \`pinned_text_examples\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`note\` text NOT NULL,
	\`title\` text NOT NULL,
	\`description\` text,
	\`created_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	CONSTRAINT "pinned_text_examples_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10))),
	CONSTRAINT "pinned_text_examples_updated_at_is_timestamp" CHECK(updated_at IS NULL OR (datetime(updated_at) IS NOT NULL AND substr(updated_at, 11, 1) = 'T' AND substr(updated_at, -1) = 'Z' AND length(updated_at) >= 20 AND date(updated_at) = substr(updated_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX `pinned_text_examples_tenant_created` ON `pinned_text_examples` (`tenant_id`,`created_at`)',
    },
  ],
};

/**
 * A second index on `items`, ordered so `itemsToRead` (repo.ts) can walk it by
 * cursor without a scan ("Give every item already there a vector", issue 409).
 *
 * **`items_tenant_workspace_status` does not serve this query.** Every row of
 * an account is one tenant, so `tenant_id` alone picks nothing out, and that
 * index's next column is `workspace_id` - which `itemsToRead` does not filter
 * on - so SQLite has no way to use it for `id > ?` or for the walk's own
 * order. Without `(tenant_id, id)`, every batch reads and sorts every open
 * Item in the account regardless of the cursor, which turns a resumable walk
 * into one that costs the same whether it has ten Items left or ten thousand.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It adds an index and writes to no row.
 * - **Interrupted partway.** It cannot be: a change's statement and the record
 *   that it ran commit together (`up-to-date.ts`), so a failure leaves no
 *   index and the change is retried whole.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left no index behind to conflict with a fresh `CREATE INDEX`.
 * - **Data the new rules reject.** None - an index changes nothing about which
 *   rows exist or what they hold.
 * - **What each environment does.** The same thing everywhere: an account
 *   applies its outstanding changes inside the first request that opens it.
 */
const ITEMS_TENANT_ID: Change = {
  name: '0032-items-tenant-id',
  statements: [{ sql: 'CREATE INDEX `items_tenant_id` ON `items` (`tenant_id`,`id`)' }],
};

/**
 * The account's own attachments on its Items ("Attach a file to an item",
 * issue 441) - see `schema.ts` for what each column carries and why.
 *
 * **A brand new table, created whole with its one CHECK**, the same shape
 * `PINNED_TEXT_EXAMPLES` above uses and for the same reason.
 *
 * The failure-mode questions the `scoping` skill asks of a change that
 * cannot put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md,
 *   "Deployed data is real"). It adds a table and writes to no existing row.
 * - **Interrupted partway.** It cannot be: the statements and the record
 *   that they ran commit together (`up-to-date.ts`), so a failure leaves
 *   neither the table nor the index and the change is retried whole.
 * - **Run again.** Only an unfinished change runs again, and an unfinished
 *   one left nothing behind.
 * - **Data the new rules reject.** None: the table starts empty, and
 *   nothing sweeps past existing Items into it. An account's attachments
 *   exist only from the moment it adds one.
 * - **What each environment does.** The same thing everywhere: an account
 *   applies its outstanding changes inside the first request that opens it.
 */
const ATTACHMENTS: Change = {
  name: '0033-attachments',
  statements: [
    {
      sql: `CREATE TABLE \`attachments\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`item_id\` text NOT NULL,
	\`r2_key\` text NOT NULL,
	\`filename\` text NOT NULL,
	\`size\` integer NOT NULL,
	\`content_type\` text NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "attachments_size_is_positive" CHECK(size > 0),
	CONSTRAINT "attachments_created_at_is_timestamp" CHECK(created_at IS NULL OR (datetime(created_at) IS NOT NULL AND substr(created_at, 11, 1) = 'T' AND substr(created_at, -1) = 'Z' AND length(created_at) >= 20 AND date(created_at) = substr(created_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX `attachments_tenant_item` ON `attachments` (`tenant_id`,`item_id`)',
    },
  ],
};

/**
 * The append-only rewrite history a rewrite-history table reads whole per
 * item, or per workspace most recent first ("See the history of what Cockpit
 * proposed for the Inbox's items", issue 444) - see `schema.ts` for what each
 * column carries and why.
 *
 * **A brand new table, created whole with its CHECK** - the same shape
 * `DECISION_HISTORY` above uses, for the same reason: a table created here
 * carries its CHECK from the start, unlike a column added to `items`.
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It adds a table and writes to no existing row.
 * - **Interrupted partway.** It cannot be: the statements and the record that
 *   they ran commit together (`up-to-date.ts`), so a failure leaves neither
 *   the table nor its indexes and the change is retried whole.
 * - **Run again.** Only an unfinished change runs again, and an unfinished one
 *   left nothing behind.
 * - **Data the new rules reject.** None: the table starts empty, and nothing
 *   sweeps past titles into it - history accumulates from this shipping
 *   forward, the same precedent issue 296 set for title cleanup itself.
 * - **What each environment does.** The same thing everywhere: an account
 *   applies its outstanding changes inside the first request that opens it.
 */
const REWRITE_HISTORY: Change = {
  name: '0034-rewrite-history',
  statements: [
    {
      sql: `CREATE TABLE \`rewrite_history\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`workspace_id\` text NOT NULL,
	\`item_id\` text NOT NULL,
	\`title_before\` text NOT NULL,
	\`title_after\` text,
	\`description_before\` text,
	\`description_after\` text,
	\`proposed_panel_id\` text,
	\`proposed_panel_reason\` text,
	\`status\` text NOT NULL,
	\`message\` text,
	\`attempted_at\` text NOT NULL,
	FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`item_id\`) REFERENCES \`items\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (\`proposed_panel_id\`) REFERENCES \`panels\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rewrite_history_attempted_at_is_timestamp" CHECK(attempted_at IS NULL OR (datetime(attempted_at) IS NOT NULL AND substr(attempted_at, 11, 1) = 'T' AND substr(attempted_at, -1) = 'Z' AND length(attempted_at) >= 20 AND date(attempted_at) = substr(attempted_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX `rewrite_history_tenant_workspace_attempted` ON `rewrite_history` (`tenant_id`,`workspace_id`,`attempted_at`)',
    },
    {
      sql: 'CREATE INDEX `rewrite_history_tenant_item_attempted` ON `rewrite_history` (`tenant_id`,`item_id`,`attempted_at`)',
    },
  ],
};

/**
 * What a Filter gathers ("Add a Filter panel that shows every filed item due in
 * a window", issue 463).
 *
 * **One nullable column, and nothing else.** Being set is what makes a Panel a
 * Filter — see `STORED_PANEL_KINDS` in the contract for why the `kind` column's
 * own CHECK is not widened instead, which would have meant rebuilding a table
 * that filings, placements and an Item's proposed Panel all point at under
 * RESTRICT.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** it cannot. One statement, and a change's
 *   statements and the record that they ran commit in one `transactionSync`
 *   (store.ts) — which is load-bearing rather than a nicety, SQLite having no
 *   `ADD COLUMN IF NOT EXISTS` for a half-applied change to re-run over.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none. Every Panel
 *   takes NULL, which is "not a Filter", and no row is rewritten.
 * - **Rolled back after it has run:** an older release reads a Filter as an
 *   empty Panel of items and will accept a filing onto it. That filing is why
 *   the client counts a filing onto a Filter as no filing at all
 *   (`filingsThatFile`, apps/web/src/filing.ts): the Item stays in the Inbox
 *   rather than leaving it for a Panel that draws it nowhere.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const PANEL_FILTERS: Change = {
  name: '0035-panel-filters',
  statements: [{ sql: 'ALTER TABLE `panels` ADD COLUMN `filter_conditions` text' }],
};

/**
 * When an Item's due date was last set ("Colour an action's own deadline as
 * it approaches, and mark it red once passed", issue 473) - one nullable
 * column and nothing else, the same shape `PANEL_FILTERS` above is.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **If it stops halfway:** it cannot. One statement, and a change's
 *   statements and the record that they ran commit in one `transactionSync`
 *   (store.ts) — SQLite has no `ADD COLUMN IF NOT EXISTS` for a half-applied
 *   change to re-run over.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none. Every Item
 *   takes NULL, which is what an Item that carried a due date before this
 *   shipped gets too — the ramp falls back to `createdAt` for those rather
 *   than a backfill.
 * - **Rolled back after it has run:** an older release reads the column back
 *   out of existence and colours nothing; `set_due_date` writes to it are
 *   simply unread until the release goes forward again.
 */
const ITEM_DUE_DATE_SET_AT: Change = {
  name: '0036-item-due-date-set-at',
  statements: [{ sql: 'ALTER TABLE `items` ADD COLUMN `due_date_set_at` text' }],
};

/**
 * The source accounts a Workspace has connected ("Connect a Microsoft Teams
 * source account", issue 485) - see `schema.ts` for what each column carries
 * and why, the two sealed ones especially.
 *
 * **A brand new table, created whole with its CHECKs and both indexes**, the
 * same shape `ATTACHMENTS` above uses and for the same reason: a table
 * created here carries them from the start, where a column added to an
 * existing one cannot.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It adds a table and writes to no existing row.
 * - **If it stops halfway:** it cannot. The statements and the record that
 *   they ran commit together (`up-to-date.ts`), so a failure leaves neither
 *   the table nor its indexes and the change is retried whole.
 * - **The second time it runs:** it does not, having been recorded - and an
 *   unfinished run left nothing for a fresh `CREATE TABLE` to conflict with.
 * - **Rows that already break the new rule:** there can be none. The table
 *   starts empty, and nothing sweeps anything into it; a Workspace has the
 *   connections it made from this shipping forward.
 * - **Rolled back after it has run:** an older release names none of these
 *   columns and offers no way to connect anything, so the table simply sits
 *   there unread. The reverse - a release naming a table that is gone - is
 *   what dropping this would cause, which is why that would need a release of
 *   its own (deployment, "Migrations and rollback").
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const CONNECTOR_ACCOUNTS: Change = {
  name: '0037-connector-accounts',
  statements: [
    {
      sql: `CREATE TABLE \`connector_accounts\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`tenant_id\` text NOT NULL,
	\`workspace_id\` text NOT NULL,
	\`connector_id\` text NOT NULL,
	\`external_account_key\` text NOT NULL,
	\`display_name\` text NOT NULL,
	\`encrypted_credential\` text NOT NULL,
	\`credential_nonce\` text NOT NULL,
	\`connected_at\` text NOT NULL,
	\`updated_at\` text NOT NULL,
	FOREIGN KEY (\`workspace_id\`) REFERENCES \`workspaces\`(\`id\`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "connector_accounts_connected_at_is_timestamp" CHECK(connected_at IS NULL OR (datetime(connected_at) IS NOT NULL AND substr(connected_at, 11, 1) = 'T' AND substr(connected_at, -1) = 'Z' AND length(connected_at) >= 20 AND date(connected_at) = substr(connected_at, 1, 10))),
	CONSTRAINT "connector_accounts_updated_at_is_timestamp" CHECK(updated_at IS NULL OR (datetime(updated_at) IS NOT NULL AND substr(updated_at, 11, 1) = 'T' AND substr(updated_at, -1) = 'Z' AND length(updated_at) >= 20 AND date(updated_at) = substr(updated_at, 1, 10)))
) STRICT`,
    },
    {
      sql: 'CREATE INDEX `connector_accounts_tenant_workspace` ON `connector_accounts` (`tenant_id`,`workspace_id`,`connected_at`)',
    },
    {
      sql: 'CREATE UNIQUE INDEX `connector_accounts_one_per_account` ON `connector_accounts` (`tenant_id`,`workspace_id`,`connector_id`,`external_account_key`)',
    },
  ],
};

/**
 * Whether the account has the Item's form drawn centered or docked to the
 * side ("Let the item's form dock to the side of the screen instead of
 * opening as a dialog", issue 481) - see `schema.ts` for what the column
 * carries and why. The same shape `ACCOUNT_TEXT_RULES` above is.
 *
 * Its failure modes, per the `scoping` skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"). It adds a table and writes to no existing row.
 * - **If it stops halfway:** it cannot. The statement and the record that it
 *   ran commit together (`up-to-date.ts`), so a failure leaves neither the
 *   table nor the row and the change is retried whole.
 * - **The second time it runs:** only an unfinished change runs again, and an
 *   unfinished one left nothing behind.
 * - **Rows that already break the new rule:** none. The table starts empty,
 *   and reads a missing row as centered (`getItemFormPresentation`) - the only
 *   presentation there was before this issue, and what every account already
 *   has.
 * - **Rolled back after it has run:** an older release reads and writes
 *   neither the table nor the command, so the worst a rollback costs is a
 *   choice nobody reads until the release goes forward again.
 */
const ITEM_FORM_PRESENTATION: Change = {
  name: '0037-item-form-presentation',
  statements: [
    {
      sql: `CREATE TABLE \`account_item_form_presentation\` (
	\`tenant_id\` text PRIMARY KEY NOT NULL,
	\`presentation\` text,
	CONSTRAINT "account_item_form_presentation_is_known" CHECK(presentation IN ('centered', 'docked'))
) STRICT`,
    },
  ],
};

/**
 * Which connector an Item came in through, for an Item the store's own
 * `source` column cannot name ("Save a Teams message to Cockpit", issue 486).
 *
 * **One added column instead of a wider CHECK**, which is the same wall issue
 * 463 hit on `panels`: `items_source_is_known` holds `source` to the five
 * values it was created with, and widening a CHECK means rebuilding a table
 * that filings, associations, attachments and an Item's proposed Panel all
 * point at under RESTRICT. So a message saved from Teams keeps `internal` in
 * `source`, names `teams` here, and the read coalesces the two
 * (`itemColumns`, repo.ts).
 *
 * The failure-mode questions the `scoping` skill asks of a change that cannot
 * put state back:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): one `ADD COLUMN`, and no statement that writes to a row.
 * - **Interrupted partway.** It cannot be. One statement, and a change's
 *   statements and the record that they ran commit in one `transactionSync`
 *   (store.ts) - load-bearing rather than a nicety, SQLite having no
 *   `ADD COLUMN IF NOT EXISTS` for a half-applied change to re-run over.
 * - **The second time it runs:** it does not, having been recorded.
 * - **Rows that already break the new rule:** there can be none. Every Item
 *   takes NULL, which means "it came in as its `source` column says".
 * - **Rolled back after it has run:** an older release reads a saved Teams
 *   message as an ordinary capture that happens to carry a link, a sender and
 *   a time - nothing it has not been able to read since `0001-account-schema`.
 * - **A backup restored from before it:** the restore replays the recorded
 *   changes, so this one applies the next time the account is opened.
 */
const ITEM_SOURCE_CONNECTOR: Change = {
  name: '0038-item-source-connector',
  statements: [{ sql: 'ALTER TABLE `items` ADD `source_connector` text' }],
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
/**
 * The ids of the two types every account is given below - *Task* and *Note*
 * since `0012-standard-types` renamed them, under the ids `0008-item-types`
 * first wrote. Named here because four places derive them and a fifth reads
 * them back in a test; the strings are the ones already in every account, so
 * this is the same value said once rather than an edit to a shipped change.
 */
export const taskTypeId = (accountId: string) => `${accountId}-type-action`;
export const noteTypeId = (accountId: string) => `${accountId}-type-thought`;

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
        params: [taskTypeId(accountId), accountId, at],
      },
      {
        sql: `INSERT OR IGNORE INTO item_types (id, tenant_id, name, folded_name, color, position, created_at)
              VALUES (?, ?, 'Thought', 'thought', '#3a72c8', 1, ?)`,
        params: [noteTypeId(accountId), accountId, at],
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
        params: [taskTypeId(accountId)],
      },
      {
        sql: `UPDATE item_types SET name = 'Note', folded_name = 'note' WHERE id = ?`,
        params: [noteTypeId(accountId)],
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
 * What an account nobody has used arrives with to explain Cockpit ("Give a new
 * account a Getting started panel and an Inbox item that explain Cockpit",
 * issue 769): a Panel called *Getting started* on *Dashboard 1*, before
 * *Panel 1*, holding the steps of getting-started-data.ts as open Tasks in
 * order, and one Task in the Inbox. The words are in that file.
 *
 * **Guarded on the account being exactly as `0015-first-workspace` made it**:
 * the store's only Workspace, Dashboard and Panel are *Workspace 1*,
 * *Dashboard 1* and *Panel 1* under their own ids and names and none deleted,
 * it holds no Item at all - a dismissed one included - and no action has ever
 * been recorded (`commands`), so a Panel renamed and renamed back still counts
 * as used. Anything else, however small, is somebody's account and gets
 * nothing. Counted over every row rather than this account's alone, so a store
 * holding anything unexpected is left alone too. **The guest account is skipped
 * by name**, as `guestDemoSeed` decides by it: it applies this with no
 * statements, so its demonstration is exactly as before.
 *
 * **Only the Panel's statement asks that question.** It cannot be asked again
 * once the Panel is in - the store then holds two Panels - so every Item and
 * filing after it is guarded on the guide's own Panel existing instead, the
 * way `guestDemoSeed` guards a row on the one it hangs off. That Panel's id is
 * fresh, so it exists only if this run wrote it, and the guide lands whole or
 * not at all.
 *
 * **Fresh random ids**, uuids of the kind every Panel and Item command takes,
 * so the guide can be renamed, ticked off, filed and deleted like anything
 * else. Built afresh each time the list is, which is harmless: only the run
 * that applies this change writes them, and nothing refers to them afterwards.
 *
 * **Placed before *Panel 1* by being dated a second before it.** A Dashboard
 * nobody has arranged draws its Panels in the order they were made, a phone
 * included (`stackedOnPhone`, apps/web/src/panels/arrangement.ts), so the date
 * is what puts *Getting started* first on every screen; writing a Layout would
 * have done it on a desk alone. *Panel 1*'s own row is untouched.
 *
 * **Written as Items, never through capture**: no captured message, so nothing
 * proposes a title, a description or a Panel for them, and nothing appears
 * under *What Cockpit changed*.
 *
 * Its failure modes, per the scoping skill:
 *
 * - **Nothing is deleted, re-seeded, wiped or restored** (CLAUDE.md, "Deployed
 *   data is real"): inserts only, into accounts nobody has used.
 * - **If it stops halfway:** it cannot. A change's statements and the record
 *   that they ran commit in one `transactionSync` (store.ts), so a failure
 *   leaves no Panel and no Task, and the whole change is retried.
 * - **The second time it runs:** it does not, having been recorded. A retry
 *   after a failure starts from an untouched account.
 * - **Rows that already break the new rule:** every account anybody has used,
 *   skipped and never changed - this is bootstrap data, not a rule.
 * - **What is in each environment:** staging and production hold used
 *   accounts, all skipped; only an account nobody has used changes, an
 *   account opened before this release and never used among them.
 * - **A backup restored:** its replay writes a guide only to empty it with
 *   every other row, so the account ends with the guide the backup held, or -
 *   from a backup taken before this change - gets one from the bring-up-to-date
 *   that follows, if its rows are untouched.
 * - **The windows it can be interrupted in.** *Between the first workspace's
 *   change and this one*: an account is not served until every change has
 *   run. *After it, with the previous release promoted back*: the guide is an
 *   ordinary Panel and ordinary Items that release reads.
 */
function gettingStarted(accountId: string): Change {
  const name = '0056-getting-started';
  if (accountId === GUEST_ACCOUNT_NAME) return { name, statements: [] };

  const panelId = crypto.randomUUID();
  // **Dated an hour back, not now.** A change to an Item is applied only when
  // the browser's clock says it is newer than the Item (`isStale`,
  // domain/items.ts), so a guide dated by the server's clock would silently
  // refuse the first ticks of a browser running behind it. An hour is far past
  // ordinary drift and still under the day an Item's row starts showing how
  // long it has waited (`waitedSince`, apps/web/src/waited.ts).
  const now = new Date(Date.now() - GUIDE_DATED_BEFORE_MS).toISOString();
  const taskType = taskTypeId(accountId);
  const statements: Statement[] = [
    {
      sql: `INSERT INTO panels (id, tenant_id, dashboard_id, name, folded_name, created_at)
              SELECT ?, ?, '${FIRST_DASHBOARD_ID}', ?, ?, '2026-09-06T23:59:59.000Z'
              WHERE (SELECT count(*) FROM workspaces) = 1
                AND EXISTS (SELECT 1 FROM workspaces
                            WHERE id = '${FIRST_WORKSPACE_ID}' AND tenant_id = ? AND name = ?
                              AND deleted_at IS NULL)
                AND (SELECT count(*) FROM dashboards) = 1
                AND EXISTS (SELECT 1 FROM dashboards
                            WHERE id = '${FIRST_DASHBOARD_ID}' AND tenant_id = ?
                              AND workspace_id = '${FIRST_WORKSPACE_ID}' AND name = ?
                              AND deleted_at IS NULL)
                AND (SELECT count(*) FROM panels) = 1
                AND EXISTS (SELECT 1 FROM panels
                            WHERE id = '${FIRST_PANEL_ID}' AND tenant_id = ?
                              AND dashboard_id = '${FIRST_DASHBOARD_ID}' AND name = ?
                              AND deleted_at IS NULL)
                AND NOT EXISTS (SELECT 1 FROM items)
                AND NOT EXISTS (SELECT 1 FROM commands)`,
      params: [
        panelId,
        accountId,
        GETTING_STARTED_PANEL_NAME,
        foldName(GETTING_STARTED_PANEL_NAME),
        accountId,
        FIRST_WORKSPACE_NAME,
        accountId,
        FIRST_DASHBOARD_NAME,
        accountId,
        FIRST_PANEL_NAME,
      ],
    },
  ];

  const writeTask = (task: GuideTask): string => {
    const itemId = crypto.randomUUID();
    statements.push({
      sql: `INSERT INTO items (id, tenant_id, workspace_id, workspace_decided, captured_message, source,
                               title, description, type_id, status, created_at, updated_at)
              SELECT ?, ?, '${FIRST_WORKSPACE_ID}', 1, NULL, 'internal', ?, ?, ?, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM panels WHERE id = ? AND tenant_id = ?)`,
      params: [
        itemId,
        accountId,
        task.title,
        task.description,
        taskType,
        DEAD_STATUS_VALUE,
        now,
        now,
        panelId,
        accountId,
      ],
    });
    return itemId;
  };

  GETTING_STARTED_TASKS.forEach((task, position) => {
    const itemId = writeTask(task);
    statements.push({
      sql: `INSERT INTO panel_items (tenant_id, panel_id, item_id, position, created_at)
              SELECT ?, ?, ?, ?, ?
              WHERE EXISTS (SELECT 1 FROM items WHERE id = ? AND tenant_id = ?)`,
      params: [accountId, panelId, itemId, position, now, itemId, accountId],
    });
  });
  writeTask(INBOX_TASK);

  return { name, statements };
}

/** How long before it is written the guide is dated, for the reason `gettingStarted` gives. */
const GUIDE_DATED_BEFORE_MS = 60 * 60 * 1000;

/**
 * The ids the demonstration's Layouts, Panels, Items and Associations carry.
 *
 * **Real uuids rather than readable strings**, for the reason `FIRST_PANEL_ID`
 * above is one: `save_layout` takes a `layoutId` as `z.uuid()`, five Panel
 * commands and every Item and Association command take
 * theirs the same way, so a seeded row with a readable id would be a row nobody
 * could rearrange, rename, file or delete. Workspaces and Dashboards are named
 * in no such schema, so those keep ids you can read in a query.
 *
 * Counted rather than random: the whole dataset has to come out the same every
 * time it is applied.
 */
const demoId = (prefix: string, nth: number) =>
  `${prefix}-0000-7000-8000-${String(nth).padStart(12, '0')}`;
const DEMO_PANEL = '0a000000';
const DEMO_ITEM = '0b000000';
const DEMO_ASSOCIATION = '0c000000';
const DEMO_LAYOUT = '0d000000';
const DEMO_CONNECTION = '0e000000';
const DEMO_AGENT = '0f000000';
const DEMO_RUN = '10000000';

/** A readable, stable id for the things whose ids are not uuids: `Day to day` -> `day-to-day`. */
function demoSlug(name: string): string {
  return foldName(name)
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/**
 * What the demonstration has to be true of before it can be turned into rows,
 * checked once so that a future edit to guest-seed-data.ts fails loudly instead
 * of failing the guest account.
 *
 * Every one of these is a live constraint somewhere below, and every one of
 * them takes the *whole* change with it if it is broken - the statements commit
 * in one transaction, so a single refused insert leaves the guest account
 * unopenable rather than one Panel short. A thrown error here is a red test and
 * a cold start that says what is wrong; the same mistake unchecked is a 500 to
 * whoever presses "Continue as guest".
 *
 * Exported so each refusal can be asked for directly: the data it guards is
 * correct, which leaves nothing else that could make it say no.
 */
export function checkedGuestDemo(demo: readonly SeedWorkspace[]): readonly SeedWorkspace[] {
  const wrong = (why: string): never => {
    throw new Error(`the guest demonstration data cannot be seeded: ${why}`);
  };
  const workspaceIds = new Set<string>();
  const dashboardIds = new Set<string>();
  for (const workspace of demo) {
    const slug = demoSlug(workspace.name);
    // Two names folding to one slug would be two Workspaces racing for one id:
    // the second insert is guarded on the id, so it would silently not happen.
    if (!slug) wrong(`the workspace "${workspace.name}" leaves no id behind`);
    if (workspaceIds.has(slug)) wrong(`two workspaces share the id "${slug}"`);
    workspaceIds.add(slug);
    // An Inbox Item's suggestion is a foreign key to a Panel, found by name
    // across every Dashboard of its Workspace - so the name has to find
    // exactly one, and one that takes Items.
    for (const item of workspace.inbox) {
      if (!item.suggest) continue;
      const named = workspace.dashboards
        .flatMap((dashboard) => dashboard.rows.flatMap((row) => row.panels))
        .filter((panel) => foldName(panel.name) === foldName(item.suggest!.panel));
      if (named.length !== 1 || isFilter(named[0]!)) {
        wrong(
          `"${item.title}" suggests "${item.suggest.panel}", which is not one Panel of items in "${workspace.name}"`,
        );
      }
    }
    for (const dashboard of workspace.dashboards) {
      const under = `${slug}-${demoSlug(dashboard.name)}`;
      if (dashboardIds.has(under)) wrong(`two dashboards share the id "${under}"`);
      dashboardIds.add(under);
      // `panels_dashboard_live_folded_name` is unique, and it is the live
      // index rather than a guard this change could write around.
      const panelNames = new Set<string>();
      for (const row of dashboard.rows) {
        // A row of none divides by zero and a row of more than `MOST_ACROSS`
        // is narrower than a Panel is meant to be read at - and past twelve,
        // `panel_placements_span_fits_the_grid` refuses the span outright.
        if (row.panels.length < 1 || row.panels.length > MOST_ACROSS) {
          wrong(
            `a row of "${dashboard.name}" holds ${row.panels.length} panels, and a row holds 1 to ${MOST_ACROSS}`,
          );
        }
        for (const panel of row.panels) {
          const folded = foldName(panel.name);
          if (panelNames.has(folded)) {
            wrong(`"${dashboard.name}" has two panels called "${panel.name}"`);
          }
          panelNames.add(folded);
          // A Filter the app cannot read draws as one with nothing chosen
          // (`panelFilterFrom`), one with no conditions demonstrates nothing,
          // and a `match` or `groupBy` it cannot read is quietly All or None -
          // each a typo here rather than a choice.
          if (isFilter(panel)) {
            const read = panelFilterSchema.safeParse(panel.filter);
            if (
              !read.success ||
              read.data.conditions.length === 0 ||
              !filterMatchSchema.safeParse(panel.filter.match).success ||
              !filterGroupingSchema.safeParse(panel.filter.groupBy).success
            ) {
              wrong(`the Filter "${panel.name}" has no conditions the app can read`);
            }
          }
        }
      }
    }
  }
  return demo;
}

/** Every Association one seeded Item carries, its Dashboard's Project included where it has one. */
function demoAssociations(
  item: SeedItem,
  dashboard?: SeedDashboard,
): { kind: AssociationKind; label: string }[] {
  return [
    ...(dashboard?.project ? [{ kind: 'project' as const, label: dashboard.project }] : []),
    ...(item.people ?? []).map((label) => ({ kind: 'person' as const, label })),
    ...(item.topics ?? []).map((label) => ({ kind: 'topic' as const, label })),
  ];
}

/**
 * What the shared guest account holds when somebody opens it: three Workspaces
 * of a contractor's week, their Dashboards arranged in rows, the Items filed on
 * their Panels, the Filters gathering them and what is still in each Inbox
 * ("Seed the guest account with a full demo dataset", issue 355). The content
 * itself is in guest-seed-data.ts; this turns it into rows.
 *
 * **Dated from the day it is written.** guest-seed-data.ts says when an Item is
 * due or was started in days from that day, so the guest account - rebuilt
 * every night - always has something overdue, something due today and a week
 * ahead to fill a Filter with. When it was made is spread back over the weeks
 * before, so how long each has waited reads like a real list rather than one
 * moment, and always before the day it is written, so nothing waits a negative
 * time.
 *
 * **No Item carries a captured message.** Filing one re-asks the model about
 * every Inbox Item that has one (`reproposePanels`) - including a filed one a
 * visitor has moved back - which on a shared account anybody can drive all day
 * would be a model call per Item per filing. The Inbox's suggestions are
 * written here instead, so the chip still shows; the only other reader is the
 * form's Details tab, where it would repeat the title.
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
 * the rest of the demonstration still lands. A Layout is guarded on its
 * Dashboard having none yet as well, since a Dashboard holds at most one.
 *
 * **Nothing already in the account is touched.** The `Workspace 1` that
 * `0015-first-workspace` hands every account keeps its row and its position
 * untouched - additive, with nothing to overwrite. These three simply take
 * positions below it, so a guest lands on the demonstration rather than on the
 * empty starter; the note beside that number says why it is negative.
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
 * - **A night the reset fails:** the account keeps what it held, its dates a
 *   day older, and the next night's reset writes them afresh.
 */
function guestDemoSeed(accountId: string): Change {
  const name = '0026-guest-demo-seed';
  if (accountId !== GUEST_ACCOUNT_NAME) return { name, statements: [] };
  const day = new Date().toISOString().slice(0, 10);
  if (seeded?.day !== day) seeded = { day, statements: guestDemoStatements(GUEST_ACCOUNT_NAME, day) };
  return { name, statements: seeded.statements };
}

/**
 * The statements themselves, built once per isolate per day.
 *
 * `accountChanges` is called on every read an account serves, so without this
 * the demonstration's five hundred statements were rebuilt for every request
 * the guest account answered, long after the change itself had been recorded
 * as applied. Building them once a day is also what makes `checkedGuestDemo`
 * free enough to run always - and the day, not once, because an isolate that
 * lives past midnight would otherwise write yesterday's dates.
 */
let seeded: { readonly day: string; readonly statements: readonly Statement[] } | undefined;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long before the day it is written the nth seeded Item was made, in hours:
 * between two and forty days for a filed one and under four for one still in
 * the Inbox, counted rather than random so the dataset comes out the same each
 * time. Never after it was started, nor after the date it is overdue for.
 */
function demoAgeInHours(item: SeedItem, nth: number, inInbox: boolean): number {
  const days = inInbox ? (nth * 3) % 4 : 2 + ((nth * 7) % 38);
  const floor = Math.max(item.started ?? -1, -(item.due ?? 0)) + 1;
  return Math.max(days, floor) * 24 + 1 + ((nth * 5) % 11);
}

export function guestDemoStatements(accountId: string, day: string): readonly Statement[] {
  const demo = checkedGuestDemo(GUEST_DEMO);
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  const dateIn = (days: number) => new Date(midnight + days * DAY_MS).toISOString().slice(0, 10);
  const hoursBefore = (hours: number) => new Date(midnight - hours * 60 * 60 * 1000).toISOString();
  // The Workspaces, Dashboards and Panels predate every Item on them.
  const at = hoursBefore(60 * 24);
  const taskType = taskTypeId(accountId);
  const noteType = noteTypeId(accountId);
  const statements: Statement[] = [];

  let layoutsSoFar = 0;
  let panelsSoFar = 0;
  let itemsSoFar = 0;
  let associationsSoFar = 0;
  let connectionsSoFar = 0;
  let runsSoFar = 0;

  // The guest's dock ("Show agents at work in the guest demo, with simulated
  // runs", issue 774). Account-wide, so written once, ahead of every Workspace.
  // Guarded on the live name as well as the id: `agents_tenant_live_folded_name`
  // is unique, and a guest's own Agent that took the name first must skip this
  // one rather than fail the whole change.
  const agentIds = new Map<string, string>();
  GUEST_DEMO_AGENTS.forEach((agent, position) => {
    const agentId = demoId(DEMO_AGENT, position + 1);
    agentIds.set(agent.name, agentId);
    statements.push({
      sql: `INSERT INTO agents (id, tenant_id, name, folded_name, color, engine, message, asks_for_prompt, starts_in_progress, position, created_at)
              SELECT ?, ?, ?, ?, ?, 'claude-code', ?, 0, ?, ?, ?
              WHERE NOT EXISTS (SELECT 1 FROM agents WHERE id = ?)
                AND NOT EXISTS (SELECT 1 FROM agents WHERE tenant_id = ? AND folded_name = ? AND deleted_at IS NULL)`,
      params: [
        agentId,
        accountId,
        agent.name,
        foldName(agent.name),
        agent.color,
        agent.message,
        agent.startsInProgress ? 1 : 0,
        position,
        at,
        agentId,
        accountId,
        foldName(agent.name),
      ],
    });
  });

  demo.forEach((workspace, index) => {
    const workspaceId = `guest-ws-${demoSlug(workspace.name)}`;
    const theme = themeOf(workspace.tint);
    /** Every Panel of items in this Workspace by folded name, for the Inbox's suggestions. */
    const panelIds = new Map<string, string>();
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
        // *Before* the `Workspace 1` that `0015-first-workspace` gives every
        // account, which holds 0, and before anything a guest has made for
        // themselves, which is 1 upwards: a guest lands on the first tab
        // (`somewhereThatWorks`, apps/web/src/router.tsx) and landing on the
        // empty starter with the demonstration behind it is the whole thing
        // this change exists to stop. Counting down from minus the dataset's
        // size keeps these three in the order they are written in. The column
        // carries no uniqueness and no floor, and `created_at` breaks any tie,
        // so the tabs come back in one stable order regardless.
        index - demo.length,
        at,
        accountId,
        foldName(workspace.name),
      ],
    });

    // Gmail and Teams, connected (`GUEST_DEMO_CONNECTIONS`). Guarded on the
    // Workspace being this change's own row, so a guest's Workspace that took
    // the name first gets none; and on the row, so a second run adds nothing.
    for (const connection of GUEST_DEMO_CONNECTIONS) {
      connectionsSoFar += 1;
      const connectionId = demoId(DEMO_CONNECTION, connectionsSoFar);
      statements.push({
        sql: `INSERT INTO connector_accounts (id, tenant_id, workspace_id, connector_id, external_account_key, display_name,
                                              encrypted_credential, credential_nonce, connected_at, updated_at, last_tested_at)
                SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND tenant_id = ?)
                  AND NOT EXISTS (SELECT 1 FROM connector_accounts WHERE id = ?)`,
        params: [
          connectionId,
          accountId,
          workspaceId,
          connection.connectorId,
          connection.externalAccountKey,
          connection.displayName,
          GUEST_DEMO_PLACEHOLDER_CREDENTIAL,
          GUEST_DEMO_PLACEHOLDER_CREDENTIAL,
          at,
          at,
          // Never "last checked" for Gmail, which nothing checks; Teams reads
          // "last worked" a few hours ago, like a connection in use.
          connection.connectorId === 'gmail' ? null : hoursBefore(3),
          workspaceId,
          accountId,
          connectionId,
        ],
      });
    }

    for (const dashboard of workspace.dashboards) {
      const under = `${demoSlug(workspace.name)}-${demoSlug(dashboard.name)}`;
      const dashboardId = `guest-db-${under}`;
      layoutsSoFar += 1;
      const layoutId = demoId(DEMO_LAYOUT, layoutsSoFar);
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
        sql: `INSERT INTO layouts (id, tenant_id, dashboard_id, created_at)
                SELECT ?, ?, ?, ?
                WHERE EXISTS (SELECT 1 FROM dashboards WHERE id = ? AND tenant_id = ?)
                  AND NOT EXISTS (SELECT 1 FROM layouts WHERE id = ? OR dashboard_id = ?)`,
        params: [layoutId, accountId, dashboardId, at, dashboardId, accountId, layoutId, dashboardId],
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
        // Clamped as well as checked (`checkedGuestDemo`), because a span
        // outside 1..12 is refused by `panel_placements_span_fits_the_grid`
        // and would take the whole change - and with it guest sign-in.
        const span = Math.min(
          GRID_COLUMNS,
          Math.max(1, Math.floor(GRID_COLUMNS / row.panels.length)),
        );

        row.panels.forEach((panel, position) => {
          panelsSoFar += 1;
          const panelId = demoId(DEMO_PANEL, panelsSoFar);
          if (!isFilter(panel)) panelIds.set(foldName(panel.name), panelId);
          statements.push({
            // A Filter is a Panel whose conditions are set, its stored kind
            // left at `items` (`STORED_PANEL_KINDS`), so the column is all
            // that tells one from the other.
            sql: `INSERT INTO panels (id, tenant_id, dashboard_id, name, folded_name, filter_conditions, created_at)
                    SELECT ?, ?, ?, ?, ?, ?, ?
                    WHERE EXISTS (SELECT 1 FROM dashboards WHERE id = ? AND tenant_id = ?)
                      AND NOT EXISTS (SELECT 1 FROM panels WHERE id = ?)`,
            params: [
              panelId,
              accountId,
              dashboardId,
              panel.name,
              foldName(panel.name),
              isFilter(panel) ? JSON.stringify(panelFilterSchema.parse(panel.filter)) : null,
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

          if (isFilter(panel)) return;
          panel.items.forEach((item, filedAt) => {
            const { itemId, madeAt } = writeItem(item, workspaceId, dashboard);
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
                madeAt,
                panelId,
                accountId,
                itemId,
                accountId,
                panelId,
                itemId,
              ],
            });
          });
        });
      });
    }

    // After every Dashboard, because a suggestion is a foreign key to a Panel
    // on any of them; `checkedGuestDemo` has made sure the name finds one.
    for (const item of workspace.inbox) {
      const panelId = item.suggest ? panelIds.get(foldName(item.suggest.panel)) : undefined;
      writeItem(item, workspaceId, undefined, {
        suggestion: panelId && item.suggest ? { panelId, why: item.suggest.why } : null,
      });
    }
  });

  return statements;

  /**
   * One Item and its Associations - filed or not is the caller's business.
   *
   * `source` is `internal` for an Item with no `via`, because it was captured
   * inside Cockpit rather than synced from anywhere (one that came from Gmail or
   * Teams is stored the way `asStored` does, with its sender and demo address), and `status` carries `DEAD_STATUS_VALUE`
   * (schema.ts) because the column is NOT NULL with a CHECK and nothing reads
   * it. `focus_horizon` is left alone: it is dead too, and what this
   * demonstrates in its place is a due date and a priority, which are live.
   * The suggested Panel is read back by a subquery, so a Panel skipped by a
   * guard leaves the suggestion empty - its reason with it - rather than
   * failing its foreign key. `inbox` is present for an Item filed on no Panel.
   */
  function writeItem(
    item: SeedItem & Partial<SeedInboxItem>,
    workspaceId: string,
    dashboard: SeedDashboard | undefined,
    inbox?: { suggestion: { panelId: string; why: string } | null },
  ): { itemId: string; madeAt: string } {
    const suggestion = inbox?.suggestion ?? null;
    itemsSoFar += 1;
    const itemId = demoId(DEMO_ITEM, itemsSoFar);
    const madeAt = hoursBefore(demoAgeInHours(item, itemsSoFar, inbox !== undefined));
    // Before midnight, like `madeAt`: the nightly reset runs early in the
    // day, and a start later than it would be a start in the future.
    // Gmail keeps `mail` and names its connector, Teams keeps `internal` and names its own (`asStored`).
    const stored = !item.via
      ? { source: 'internal', sourceConnector: null }
      : item.via.source === 'gmail'
        ? { source: 'mail', sourceConnector: 'gmail' }
        : { source: 'internal', sourceConnector: 'teams' };
    const startedAt = item.started === undefined ? null : hoursBefore(item.started * 24 + 2);
    statements.push({
      sql: `INSERT INTO items (id, tenant_id, workspace_id, workspace_decided, captured_message, source, source_connector,
                               source_link, sender, source_timestamp, title,
                               description, type_id, priority, due_date, started_at,
                               proposed_panel_id, proposed_panel_reason, status, created_at, updated_at)
              SELECT ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     (SELECT id FROM panels WHERE id = ? AND tenant_id = ?),
                     (SELECT ? FROM panels WHERE id = ? AND tenant_id = ?), 'to_process', ?, ?
              WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ? AND tenant_id = ?)
                AND NOT EXISTS (SELECT 1 FROM items WHERE id = ?)`,
      params: [
        itemId,
        accountId,
        workspaceId,
        item.anyWorkspace ? 0 : 1,
        stored.source,
        stored.sourceConnector,
        item.via ? demoAddress(item.via.source) : null,
        item.via?.sender ?? null,
        item.via ? madeAt : null,
        item.title,
        item.description ?? null,
        item.note ? noteType : taskType,
        item.priority ?? null,
        item.due === undefined ? null : dateIn(item.due),
        startedAt,
        suggestion?.panelId ?? null,
        accountId,
        suggestion?.why ?? null,
        suggestion?.panelId ?? null,
        accountId,
        madeAt,
        madeAt,
        workspaceId,
        accountId,
        itemId,
      ],
    });

    if (item.run) {
      runsSoFar += 1;
      const runId = demoId(DEMO_RUN, runsSoFar);
      const agentId = agentIds.get(item.run.agent)!;
      // Started a little before the Item was last touched, so it never
      // predates the Item and never falls after midnight.
      const startedAt = hoursBefore(runsSoFar + 1);
      statements.push({
        sql: `INSERT INTO agent_runs (id, tenant_id, workspace_id, item_id, agent_id, status, session_url, started_at, settled_at)
                SELECT ?, ?, ?, ?, ?, 'working', ?, ?, ?
                WHERE EXISTS (SELECT 1 FROM items WHERE id = ? AND tenant_id = ?)
                  AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL)
                  AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE id = ?)`,
        params: [
          runId,
          accountId,
          workspaceId,
          itemId,
          agentId,
          demoAddress('session', runId),
          startedAt,
          startedAt,
          itemId,
          accountId,
          agentId,
          accountId,
          runId,
        ],
      });
      if (item.run.state === 'waiting') {
        statements.push({
          sql: `INSERT INTO agent_run_activity (run_id, tenant_id, waiting, reported_at)
                  SELECT ?, ?, 1, ?
                  WHERE EXISTS (SELECT 1 FROM agent_runs WHERE id = ? AND tenant_id = ?)
                    AND NOT EXISTS (SELECT 1 FROM agent_run_activity WHERE run_id = ?)`,
          params: [runId, accountId, startedAt, runId, accountId, runId],
        });
      }
    }

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
          madeAt,
          itemId,
          accountId,
          associationId,
        ],
      });
    }
    return { itemId, madeAt };
  }
}
