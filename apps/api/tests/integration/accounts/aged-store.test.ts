import { beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { abortAllDurableObjects, applyD1Migrations, env } from 'cloudflare:test';
import type { SqlStorage } from '@cloudflare/workers-types';
import { accountChanges } from '../../../src/accounts/changes.js';
import { inStoreAsItIs, storeNamed } from '../seed.js';

/**
 * The gate that replaced the one D1 used to give for free.
 *
 * While an account's data was in D1, a schema change that could not be applied
 * failed at deploy time: one command, before anything went live, and the deploy
 * stopped. Now each account applies its outstanding updates when somebody next
 * opens it, so a bad one fails inside a request instead - and the proof behind
 * docs/account-storage-options.md measured what that looks like: every account
 * falls over, one at a time as they wake, and the first person to know is a
 * user rather than whoever deployed.
 *
 * This is that gate, and it is a test rather than a script on purpose:
 * .github/workflows/deploy-staging.yml runs `pnpm test` before it deploys, so a
 * red test here already stops the deploy, with no second mechanism to keep in
 * step with this one.
 *
 * **What it adds over the tests that already exist.** Opening an account at all
 * applies every update, so apps/api/tests/integration/accounts/store.test.ts
 * incidentally proves they apply to a *new* store, and the branching in
 * deciding which to apply is proved at apps/api/tests/unit/accounts/up-to-date.test.ts.
 * Neither touches the case that actually breaks: an update that is fine against
 * an empty table and fails against a full one. So every update is applied here
 * to a store that already carries the ones before it and rows in every table
 * they created - which also means an account left untouched across several
 * releases is exercised, since the run starts from every point in the list.
 *
 * **Adding an update means adding to `rowsFor` below** if it creates a table,
 * so that the next update meets a full one rather than an empty one. That is
 * the same discipline as writing the update itself, and it is what keeps this
 * gate from quietly becoming the empty-store test again. An update that creates
 * an *index* asks the other half of the same question: a row written to stand
 * for something arranged before it has to stay writable after it, which is what
 * `once` below is for.
 *
 * **What it did not add, until "Prove a change keeps the rows it did not mean
 * to drop" (issue 281).** Reaching the right shape says nothing about what
 * survived getting there - "Draw a dashboard against the screen sizes it has
 * defined" (pull request 272) and the first commit of "Take the width and
 * the name off a layout, now that its size carries them" (pull request 273)
 * each reached the right shape while deleting rows nobody meant to lose, and
 * both were caught only by review. "every update keeps the rows it does not
 * mean to drop" below is that gate: every update runs alone
 * against a store aged and filled exactly as above, and a table that holds
 * fewer rows afterwards fails - unless `DECLARED_LOSSES` names the same
 * change and count, which is how an update that means to drop something
 * says so.
 */

const AT = '2026-08-12T10:00:00.000Z';
/** A second and two seconds later, so the workspaces below have an order to keep. */
const LATER = '2026-08-12T10:00:01.000Z';
const LATEST = '2026-08-12T10:00:02.000Z';
/** When the item that was already finished with was last touched, which is when it was finished. */
const FINISHED_AT = '2026-08-12T16:00:00.000Z';

/** A store no account owns, one per case, so a broken arrangement cannot leak into the next. */
function fixtureName(index: number): string {
  return `aged-store-fixture-${index}`;
}

/**
 * Puts a store in the state an account is in when it has applied everything up
 * to `applied` and nothing since - recorded as applied, exactly as the store
 * itself records it, so that opening it afterwards has real outstanding work.
 */
async function agedTo(name: string, applied: number): Promise<void> {
  const changes = accountChanges(name);
  await inStoreAsItIs(name, (sql) => {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS account_changes (
         name text PRIMARY KEY NOT NULL,
         applied_at text NOT NULL
       ) STRICT`,
    );
    for (const change of changes.slice(0, applied)) {
      for (const statement of change.statements) {
        sql.exec(statement.sql, ...(statement.params ?? []));
      }
      sql.exec('INSERT INTO account_changes (name, applied_at) VALUES (?, ?)', change.name, AT);
    }
  });
}

/**
 * A row for every table that exists at this point, in the order the foreign
 * keys require. Keyed by table so that a store part-way through the list gets
 * rows in what it has and nothing else.
 */
const rowsFor: {
  table: string;
  sql: string;
  params: (name: string) => string[];
  /**
   * Used in place of `sql` once the table has this column - for a row that was
   * writable when it stood for something arranged before an update, and that
   * the index the update goes on to create would refuse afterwards. Without it
   * these rows only work at the points before that update, which is the half of
   * the run they are least needed in.
   */
  once?: { column: string; sql: string; params: (name: string) => string[] };
  /**
   * The other direction of `once`: used in place of `sql` once the table has
   * *stopped* having every one of these columns, for an update that drops one
   * rather than adding one. Checked before `once`, since a store that has
   * reached this point has necessarily passed through `once`'s already; the
   * first that matches is used, so the latest shape goes first.
   */
  final?: { missingColumns: string[]; sql: string; params: (name: string) => string[] }[];
}[] = [
  // In foreign-key order, which is why this is a list and not a lookup.
  {
    table: 'workspaces',
    // Every column named out loud, defaults included: this row is here to be
    // what the *next* update meets, so it should be a whole workspace rather
    // than the subset that happens to have no default today.
    // Three of them, a second apart, because the case below is about the order
    // they were made in and one row has no order to keep. They are this
    // fixture's own: an account that has been in use is exactly the account the
    // workspace an untouched one is given (`0015-first-workspace`) is guarded
    // against, so nothing arrives here but what this file puts here.
    sql: `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, ground, header, created_at)
          VALUES ('ws-before', ?, 'Before', 'before', '#6f62b5', '#e3e1f2', '#d2cdea', ?),
                 ('ws-during', ?, 'During', 'during', '#3a72c8', '#d8e5f7', '#bed6f2', ?),
                 ('ws-after', ?, 'After', 'after', '#c06a45', '#f2e5d4', '#ead2b3', ?)`,
    params: (name) => [name, AT, name, LATER, name, LATEST],
  },
  {
    table: 'dashboards',
    // Named out loud like the workspace above, and for the same reason: what
    // the next update meets should be a whole dashboard.
    //
    // Reached as of the update that adds panels, which is what this row was
    // put here for: a panel points at a dashboard, so the dashboard has to be
    // there for the panels update to meet a full table rather than an empty
    // one.
    sql: `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
          VALUES ('db-before', ?, 'ws-before', 'Before', 'before', ?)`,
    params: (name) => [name, AT],
  },
  {
    table: 'panels',
    // Named out loud like the rows above, for the same reason: what the next
    // update meets should be a whole panel.
    // Two, because the arrangement below needs two to have wrapped: one panel
    // cannot show whether `0013-panel-rows` put the second on a line of its own
    // or beside the first.
    sql: `INSERT INTO panels (id, tenant_id, dashboard_id, name, folded_name, created_at)
          VALUES ('pn-before', ?, 'db-before', 'Before', 'before', ?),
                 ('pn-wrapped', ?, 'db-before', 'Wrapped', 'wrapped', ?)`,
    params: (name) => [name, AT, name, AT],
  },
  {
    // Screen sizes exist from `0019-screen-sizes` until
    // `0053-one-layout-per-dashboard` drops them, so these rows are here for
    // the reason the file exists rather than for the reason the feature did:
    // whatever update comes after should meet a table with something in it -
    // and, from `0020-drop-layout-name-and-width` on, the layouts below have
    // to point somewhere real. Two widths, so the conversion that keeps each
    // Dashboard's widest Layout has a narrower one to discard.
    table: 'screen_sizes',
    sql: `INSERT INTO screen_sizes (id, tenant_id, name, folded_name, width, created_at)
          VALUES ('sz-before', ?, 'Before', 'before', 1280, ?),
                 ('sz-wide', ?, 'Wide', 'wide', 2560, ?)`,
    params: (name) => [name, AT, name, AT],
  },
  {
    table: 'layouts',
    sql: `INSERT INTO layouts (id, tenant_id, dashboard_id, screen_width, created_at)
          VALUES ('ly-before', ?, 'db-before', 1280, ?)`,
    params: (name) => [name, AT],
    final: [
      // `0053-one-layout-per-dashboard` leaves a Layout no size at all, and
      // one per Dashboard: this one is that one from there on.
      {
        missingColumns: ['screen_width', 'screen_size_id'],
        sql: `INSERT INTO layouts (id, tenant_id, dashboard_id, created_at)
              VALUES ('ly-before', ?, 'db-before', ?)`,
        params: (name) => [name, AT],
      },
      // `0020-drop-layout-name-and-width` rebuilds the table without
      // `screen_width` and with `screen_size_id` required - a layout from
      // there on points at the screen size above rather than recording a
      // width of its own.
      {
        missingColumns: ['screen_width'],
        sql: `INSERT INTO layouts (id, tenant_id, dashboard_id, screen_size_id, created_at)
              VALUES ('ly-before', ?, 'db-before', 'sz-before', ?)`,
        params: (name) => [name, AT],
      },
    ],
  },
  {
    // A second one of the same dashboard at the same width, which nothing ever
    // stopped: two devices of one size could each record their own. It is here
    // because `0011-layout-names` names every layout after the width it was
    // made at and then guards those names with a unique index - so these two
    // are the rows that would collide, and the change has to number them apart
    // or take the account's first request down with it.
    table: 'layouts',
    sql: `INSERT INTO layouts (id, tenant_id, dashboard_id, screen_width, created_at)
          VALUES ('ly-twin', ?, 'db-before', 1280, ?)`,
    params: (name) => [name, AT],
    // Once that change has run, its index refuses a second layout of this
    // dashboard with the empty name, so from there on the twin carries the
    // name the change would have given it. It is still the second layout of
    // one width, which is what every later update meets.
    once: {
      column: 'folded_name',
      sql: `INSERT INTO layouts (id, tenant_id, dashboard_id, screen_width, created_at, name, folded_name)
            VALUES ('ly-twin', ?, 'db-before', 1280, ?, '1280 px (2)', '1280 px (2)')`,
      params: (name) => [name, AT],
    },
    final: [
      // Past `0053-one-layout-per-dashboard` a Dashboard holds one Layout, and
      // `ly-before` is it, so there is no twin to write.
      { missingColumns: ['screen_width', 'screen_size_id'], sql: 'SELECT 1', params: () => [] },
      // Past `0020-drop-layout-name-and-width`, `folded_name` is gone along
      // with `screen_width` - nothing about the account-wide name collision
      // this row exists to prove survives past that release, so it becomes an
      // ordinary second layout at the same screen size, which the index that
      // guarded names no longer restricts.
      {
        missingColumns: ['screen_width'],
        sql: `INSERT INTO layouts (id, tenant_id, dashboard_id, screen_size_id, created_at)
              VALUES ('ly-twin', ?, 'db-before', 'sz-before', ?)`,
        params: (name) => [name, AT],
      },
    ],
  },
  {
    // The same Dashboard arranged again for the wider screen, with rows and
    // placements of its own - what `0053-one-layout-per-dashboard` keeps over
    // the two above. Only once Layouts name a screen size; before that there
    // is nothing for it to stand for.
    table: 'layouts',
    sql: 'SELECT 1',
    params: () => [],
    once: {
      column: 'screen_size_id',
      // Named apart from the two above, whose `folded_name` the index on it
      // still guards at this point.
      sql: `INSERT INTO layouts (id, tenant_id, dashboard_id, screen_width, created_at, name, folded_name, screen_size_id)
            VALUES ('ly-wide', ?, 'db-before', 2560, ?, '2560 px', '2560 px', 'sz-wide')`,
      params: (name) => [name, AT],
    },
    final: [
      { missingColumns: ['screen_width', 'screen_size_id'], sql: 'SELECT 1', params: () => [] },
      {
        missingColumns: ['screen_width'],
        sql: `INSERT INTO layouts (id, tenant_id, dashboard_id, screen_size_id, created_at)
              VALUES ('ly-wide', ?, 'db-before', 'sz-wide', ?)`,
        params: (name) => [name, AT],
      },
    ],
  },
  {
    table: 'panel_placements',
    // After both of the above, which is the whole reason this is a list: the
    // placement points at the layout and the panel written just now.
    //
    // Two of them, wide enough that they cannot share a line: eight columns and
    // then five is thirteen, past the grid, so the second wrapped. That is the
    // arrangement `0013-panel-rows` has to convert into two rows rather than
    // one, and a single placement could not tell a right conversion from a
    // wrong one.
    sql: `INSERT INTO panel_placements (tenant_id, layout_id, panel_id, position, column_span, row_span)
          VALUES (?, 'ly-before', 'pn-before', 0, 8, 3), (?, 'ly-before', 'pn-wrapped', 1, 5, 2)`,
    params: (name) => [name, name],
    // The columns the wrap was stored in are the ones that change takes away,
    // so past it the same pair goes in as the rows they converted to - and a
    // change added after it still meets a full table rather than an empty one.
    once: {
      column: 'span',
      sql: `INSERT INTO panel_placements (tenant_id, layout_id, panel_id, row_index, position, span)
            VALUES (?, 'ly-before', 'pn-before', 0, 0, 8), (?, 'ly-before', 'pn-wrapped', 1, 0, 5)`,
      params: (name) => [name, name],
    },
  },
  {
    table: 'layout_rows',
    sql: `INSERT INTO layout_rows (tenant_id, layout_id, row_index, height)
          VALUES (?, 'ly-before', 0, 248), (?, 'ly-before', 1, 164)`,
    params: (name) => [name, name],
  },
  {
    // `ly-wide`'s own arrangement - both Panels on one row - wherever that
    // Layout was written above. Rows and spans exist before Layouts name a
    // screen size, so the guard on the Layout is all this needs.
    table: 'panel_placements',
    sql: 'SELECT 1',
    params: () => [],
    once: {
      column: 'span',
      sql: `INSERT INTO panel_placements (tenant_id, layout_id, panel_id, row_index, position, span)
            SELECT ?, 'ly-wide', 'pn-before', 0, 0, 7 WHERE EXISTS (SELECT 1 FROM layouts WHERE id = 'ly-wide')
            UNION ALL
            SELECT ?, 'ly-wide', 'pn-wrapped', 0, 1, 5 WHERE EXISTS (SELECT 1 FROM layouts WHERE id = 'ly-wide')`,
      params: (name) => [name, name],
    },
  },
  {
    table: 'layout_rows',
    sql: `INSERT INTO layout_rows (tenant_id, layout_id, row_index, height)
          SELECT ?, 'ly-wide', 0, 300 WHERE EXISTS (SELECT 1 FROM layouts WHERE id = 'ly-wide')`,
    params: (name) => [name],
  },
  {
    // From Gmail, the way every Gmail Item was stored before
    // `0062-gmail-items-under-their-connector`: the conversation below is
    // linked to it, and every update after meets a Gmail Item as it is.
    table: 'items',
    sql: `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
          VALUES ('it-before', ?, 'ws-before', 'mail', 'Captured before the update', 'task', 0, ?, ?)`,
    params: (name) => [name, AT, AT],
  },
  {
    // A second item, finished with under the old eight statuses, so the update
    // that turns being done into a time meets a row it has to carry across
    // rather than an empty column ("An item is either yours to deal with or
    // finished with", issue 154).
    table: 'items',
    sql: `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
          VALUES ('it-done-before', ?, 'ws-before', 'internal', 'Finished before the update', 'done', 0, ?, ?)`,
    params: (name) => [name, AT, FINISHED_AT],
  },
  {
    // The table the types update creates, filled so that whatever comes next
    // meets a full one - the discipline this file's header states. A name of
    // its own, so it cannot collide with the Action and Thought that update
    // inserts for every account.
    table: 'item_types',
    sql: `INSERT INTO item_types (id, tenant_id, name, folded_name, color, position, created_at)
          VALUES ('ty-before', ?, 'Before', 'before', '#c06a45', 7, ?)`,
    params: (name) => [name, AT],
  },
  {
    table: 'associations',
    sql: `INSERT INTO associations (id, tenant_id, item_id, kind, label, created_at)
          VALUES ('as-before', ?, 'it-before', 'person', 'Anna', ?)`,
    params: (name) => [name, AT],
  },
  {
    table: 'commands',
    sql: `INSERT INTO commands (command_id, tenant_id, workspace_id, name, payload, issued_at, received_at)
          VALUES ('cmd-before', ?, 'ws-before', 'capture_item', '{}', ?, ?)`,
    params: (name) => [name, AT, AT],
  },
  {
    // The table `0024-decision-history` creates, filled so that whatever
    // comes next meets a full one rather than an empty one - the same
    // discipline `screen_sizes` above follows.
    table: 'decision_history',
    sql: `INSERT INTO decision_history (id, tenant_id, workspace_id, item_id, chosen_panel_id, decided_at)
          VALUES ('dh-before', ?, 'ws-before', 'it-before', 'pn-before', ?)`,
    params: (name) => [name, AT],
  },
  {
    // The table `0025-workspace-routing-summary` creates, filled for the reason
    // `decision_history` above is - and so that
    // `0050-drop-workspace-routing-summary` meets a sentence somebody wrote
    // rather than an empty table.
    table: 'workspace_routing_summary',
    sql: `INSERT INTO workspace_routing_summary (workspace_id, tenant_id, correction, correction_set_at)
          VALUES ('ws-before', ?, 'Invoices go on Finance', ?)`,
    params: (name) => [name, AT],
  },
  {
    // The two tables `0028-item-meanings` creates, filled for the reason
    // `decision_history` above is: whatever comes next has to meet a full one.
    // Two readings rather than one, because the pair below needs two items to
    // hang off.
    table: 'item_meanings',
    sql: `INSERT INTO item_meanings (item_id, tenant_id, model, reading, read_at)
          VALUES ('it-before', ?, 'a-model', '[1,0]', ?),
                 ('it-done-before', ?, 'a-model', '[1,0]', ?)`,
    params: (name) => [name, AT, name, AT],
  },
  {
    // Smaller id first, which is what `item_duplicates_is_one_unordered_pair`
    // refuses to let a row break - so this row is also what would fail were
    // that CHECK ever written the other way round.
    table: 'item_duplicates',
    sql: `INSERT INTO item_duplicates (tenant_id, item_id, other_item_id, how_alike, found_at)
          VALUES (?, 'it-before', 'it-done-before', 0.99, ?)`,
    params: (name) => [name, AT],
  },
  {
    // The table `0029-duplicate-settlements` creates, filled for the reason
    // every table above is. The same pair `item_duplicates` above names,
    // which is the ordinary case: a settling is about a pair that was drawn.
    table: 'duplicate_settlements',
    sql: `INSERT INTO duplicate_settlements (tenant_id, item_id, other_item_id, settled_at)
          VALUES (?, 'it-before', 'it-done-before', ?)`,
    params: (name) => [name, AT],
  },
  {
    // The table `0037-connector-accounts` creates, filled for the reason every
    // table above is ("Connect a Microsoft Teams source account", issue 485).
    // Sealed bytes nothing here ever opens: what the next update has to meet
    // is a workspace that already has a connection on it, not a credential
    // that means anything.
    table: 'connector_accounts',
    sql: `INSERT INTO connector_accounts
            (id, tenant_id, workspace_id, connector_id, external_account_key,
             display_name, encrypted_credential, credential_nonce, connected_at, updated_at)
          VALUES ('cn-before', ?, 'ws-before', 'teams', 'a-tenant:somebody',
                  'Somebody at the source', 'c2VhbGVk', 'bm9uY2UtMTItYnl0', ?, ?)`,
    params: (name) => [name, AT, AT],
  },
  {
    // The table `0034-rewrite-history` creates, filled for the reason every
    // table above is - and so that `0051-rewrite-history-looks-at` and
    // `0052-rewrite-history-panel-before` meet a refinement recorded before
    // either column existed.
    table: 'rewrite_history',
    sql: `INSERT INTO rewrite_history
            (id, tenant_id, workspace_id, item_id, title_before, title_after, description_before,
             description_after, proposed_panel_id, proposed_panel_reason, status, message, attempted_at)
          VALUES ('rh-before', ?, 'ws-before', 'it-before', 'captured before', 'Captured before the update',
                  NULL, 'What it said.', 'pn-before', 'because', 'rewritten', 'proposed in English', ?)`,
    params: (name) => [name, AT],
  },
  {
    // A Gmail connection beside the Teams one, so `0056-gmail-followed-mark`
    // meets one that followed the label before there was anything else to
    // follow ("Connect Gmail by star, and bring in conversations starred
    // from then on", issue 822).
    table: 'connector_accounts',
    sql: `INSERT INTO connector_accounts
            (id, tenant_id, workspace_id, connector_id, external_account_key,
             display_name, encrypted_credential, credential_nonce, connected_at, updated_at)
          VALUES ('cn-gmail-before', ?, 'ws-before', 'gmail', 'google-somebody',
                  'somebody@example.com', 'c2VhbGVk', 'bm9uY2UtMTItYnl0', ?, ?)`,
    params: (name) => [name, AT, AT],
  },
  {
    // The table `0054-gmail-conversations` creates: the conversation the
    // connection above brought in, for the same change to meet.
    table: 'gmail_conversations',
    sql: `INSERT INTO gmail_conversations (tenant_id, workspace_id, mailbox_key, thread_id, item_id, label_wanted, linked_at)
          VALUES (?, 'ws-before', 'google-somebody', 'thread-before', 'it-before', 0, ?)`,
    params: (name) => [name, AT],
  },
  {
    // The tables `0059-pulled-connections` creates ("Check a pulled connector
    // on its cadence through the generic host", issue 891): a pulled
    // connection's check part-way through a run, and an Item it filed, for
    // the next update to meet.
    table: 'pulled_connections',
    sql: `INSERT INTO pulled_connections (source_account_id, tenant_id, state, due_at, queued_at, run_id, lease_until)
          VALUES ('cn-before', ?, '{"cursor":"7"}', ?, NULL, 'run-before', ?)`,
    params: (name) => [name, AT, LATER],
  },
  {
    table: 'pulled_links',
    sql: `INSERT INTO pulled_links (tenant_id, workspace_id, connector_id, external_account_key, source_id, item_id, linked_at)
          VALUES (?, 'ws-before', 'teams', 'a-tenant:somebody', 'source-before', 'it-done-before', ?)`,
    params: (name) => [name, AT],
  },
];

/**
 * The rows a change means to drop, named the way its own issue names them -
 * table and count.
 *
 * - `0020-drop-layout-name-and-width`: a Layout written before "Take the
 *   width and the name off a layout, now that its size carries them" (issue
 *   264) ever ran carries no `screen_size_id`, and the new NOT NULL rule
 *   rejects it. `ly-before` and `ly-twin`, from `rowsFor`, are exactly the two
 *   such Layouts this file ever seeds, and everything they carry - a row and a
 *   placement each - goes with them.
 * - `0050-drop-workspace-routing-summary`: the whole table ("Drop the
 *   workspace_routing_summary table", issue 401), which `rowsFor` gives one row.
 * - `0053-one-layout-per-dashboard`: every Layout of `db-before` but the
 *   widest ("Convert every Dashboard to its widest Layout and retire Screen
 *   sizes", issue 713) - `ly-before` and `ly-twin` at 1280 px, with
 *   `ly-before`'s two rows and two placements, `ly-wide` surviving - and both
 *   Screen sizes with their table.
 */
const DECLARED_LOSSES: Record<string, Record<string, number>> = {
  '0020-drop-layout-name-and-width': {
    layouts: 2,
    panel_placements: 2,
    layout_rows: 2,
  },
  '0050-drop-workspace-routing-summary': {
    workspace_routing_summary: 1,
  },
  '0053-one-layout-per-dashboard': {
    layouts: 2,
    panel_placements: 2,
    layout_rows: 2,
    screen_sizes: 2,
  },
};

/** What a table's columns are called, in the order the store holds them. */
function columnsOf(sql: SqlStorage, table: string): string[] {
  return sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray()
    .map((column) => column.name);
}

/** How many rows each table the store holds has, keyed by table name. */
function rowCountsOf(sql: SqlStorage): Record<string, number> {
  const tables = sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .toArray()
    .map((row) => row.name);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM \`${table}\``).toArray()[0]!.n;
  }
  return counts;
}

/** Fills every table the store has, so the outstanding updates meet data rather than emptiness. */
async function fillWithWhatIsAlreadyThere(name: string): Promise<void> {
  await inStoreAsItIs(name, (sql) => {
    const tables = new Set(
      sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name),
    );
    for (const row of rowsFor) {
      if (!tables.has(row.table)) continue;
      const columns = columnsOf(sql, row.table);
      const final = row.final?.find((shape) =>
        shape.missingColumns.every((column) => !columns.includes(column)),
      );
      const write = final ?? (row.once && columns.includes(row.once.column) ? row.once : row);
      sql.exec(write.sql, ...write.params(name));
    }
  });
}

/**
 * Every point an account can be sitting at with real work still outstanding.
 * Point 0 is left out deliberately: a store with nothing applied is a new one,
 * and store.test.ts already opens one of those.
 */
const updates = accountChanges('any-account-would-do');

/**
 * How far to age a store so that one named change is the next thing it applies.
 *
 * By name rather than by counting back from the end, because the end moves: a
 * case pinned to `updates.length - 1` silently starts testing a different
 * change the day one is added after it, and the fixtures it set up for the one
 * it meant are then the wrong fixtures.
 */
function justBefore(change: string): number {
  const at = updates.findIndex((update) => update.name === change);
  expect(at, `no change called ${change}`).toBeGreaterThan(-1);
  return at;
}

/**
 * Applies one named change directly, the way `agedTo` applies everything
 * before a point - for a case that needs to inspect the store right after
 * that one change, without opening it, which would carry it all the way to
 * the newest change in the list instead. Only meaningful straight after
 * `agedTo(name, justBefore(change))`.
 *
 * **By `accountChanges(name)`, not the module-level `updates`.** Three
 * changes derive ids and `tenant_id`s from the account they are handed
 * (`itemTypes`, `standardTypes`, `firstWorkspace`) - `agedTo` already looks
 * these up per store for exactly that reason, and a change applied here
 * under `updates`' fixed `'any-account-would-do'` would run against ids and
 * a tenant this store never wrote, silently doing nothing to it.
 */
async function applyChange(name: string, change: string): Promise<void> {
  const found = accountChanges(name).find((update) => update.name === change);
  expect(found, `no change called ${change}`).toBeDefined();
  await inStoreAsItIs(name, (sql) => {
    for (const statement of found!.statements) {
      sql.exec(statement.sql, ...(statement.params ?? []));
    }
    sql.exec('INSERT INTO account_changes (name, applied_at) VALUES (?, ?)', found!.name, AT);
  });
}

const points = updates
  .map((_, applied) => ({ applied, position: applied + 1, total: updates.length }))
  .filter(({ applied }) => applied > 0);

/**
 * **This file empties nothing, unlike every other suite here, and that is a
 * budget rather than a shortcut.** Every case works in a store of its own,
 * named after the point it is aged to, and none of them reads the register or
 * signs anybody in - so `startFromEmpty` would be clearing ten stores nothing
 * here touches, and the pool charges for that in a currency this file is short
 * of: the workers pool wraps the Durable Object's prototype in a fresh `Proxy`
 * on **every construction** (`createProxyPrototypeClass`,
 * @cloudflare/vitest-pool-workers), so a property read costs one stack frame
 * per construction the isolate has ever done. At ten a case across ninety-odd
 * cases, the last ones in the file were reading through a thousand of them and
 * fell over with `Maximum call stack size exceeded` - a failure that names
 * nothing about what it was doing, and that adding one change to the list was
 * enough to trigger ("Connect a Microsoft Teams source account", issue 485).
 *
 * Aborting is still needed: an object that stays in memory believing itself up
 * to date would serve the next case over the tables it aged.
 */
beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await abortAllDurableObjects();
});

describe('Accounts', () => {
  describe('every update applies to an account that already has data, not only to a new one', () => {
    it.each(points)(
      'applies update $position of $total, and what was already captured is still there',
      async ({ applied }) => {
        const name = fixtureName(applied);
        await agedTo(name, applied);
        await fillWithWhatIsAlreadyThere(name);

        // Opening the store is what brings it up to date, exactly as the first
        // request of the day does for a real account.
        const answer = await storeNamed(name).workspaces(name);

        expect(answer).toMatchObject({ status: 'ok' });
        // The store is brought fully up to date by the read above whatever
        // point it started from, so the texts added along the way are asked for
        // at every point: an item written before they existed still reads, and
        // holds nothing in them rather than being refused or rewritten.
        expect(
          await inStoreAsItIs(name, (sql) =>
            sql
              .exec("SELECT title, captured_message, description FROM items WHERE id = 'it-before'")
              .toArray(),
          ),
        ).toEqual([
          {
            title: 'Captured before the update',
            captured_message: null,
            description: null,
          },
        ]);
      },
    );
  });

  describe('every update keeps the rows it does not mean to drop', () => {
    /**
     * Unlike the loop above, each update here runs alone: `agedTo(name, index)`
     * ages the store to exactly the point before it, `fillWithWhatIsAlreadyThere`
     * gives every table it meets a row, and only that one change is applied
     * (`applyChange`) rather than catching the store all the way up - so a
     * count lost here is that update's own doing, not a later one's.
     *
     * Index 0 is aged to an empty store, which has no table yet to lose a row
     * from - the same reason `points` above leaves it out. Named by position
     * rather than the change itself, the same reason `points` above is: what
     * the runner prints is the statement list, and a migration's own name is
     * the mechanism, not a sentence about the product.
     *
     * **Bounded by what one shared fixture can show.** This compares counts,
     * not row identities, so a change that lost N rows of a table while
     * inserting N different ones in the same breath would net to zero here -
     * no update does that today. Which rows a dropping change keeps is asked
     * by its own cases below.
     */
    const everyUpdate = updates
      .map((update, index) => ({ changeName: update.name, index, position: index + 1, total: updates.length }))
      .filter(({ index }) => index > 0);

    it.each(everyUpdate)('update $position of $total keeps the rows it does not mean to drop', async ({ changeName, index }) => {
      const name = `row-survival-${changeName}`;
      await agedTo(name, index);
      await fillWithWhatIsAlreadyThere(name);

      const before = await inStoreAsItIs(name, rowCountsOf);
      await applyChange(name, changeName);
      const after = await inStoreAsItIs(name, rowCountsOf);

      // A table not present afterwards counts as every row it had lost, which
      // is what catches a change that drops a table outright rather than
      // rebuilding it under the same name.
      const lost: Record<string, number> = {};
      for (const [table, count] of Object.entries(before)) {
        const missing = count - (after[table] ?? 0);
        if (missing > 0) lost[table] = missing;
      }

      expect(lost).toEqual(DECLARED_LOSSES[changeName] ?? {});
    });
  });

  describe('an item carries the three texts it has and nothing left over from before', () => {
    /**
     * The text an Item used to show beside its title lived in `preview` until
     * its title, the message it was captured from and its description became
     * three of their own ("Edit an item's title and description on a form of
     * its own", issue 159). Nothing has read or written it since, and
     * `0014-drop-item-preview` is the release that takes it away.
     *
     * Integration rather than lower down because whether a column exists is a
     * fact about a real schema, and against a store that already holds items
     * rather than a new one: it is the only destructive change in the list, and
     * a drop meeting an empty table would prove nothing about the rows.
     */
    it('a store brought fully up to date holds the three and not the fourth, and every item still reads', async () => {
      const name = 'aged-store-item-texts-only';
      await agedTo(name, justBefore('0014-drop-item-preview'));
      await fillWithWhatIsAlreadyThere(name);

      // Opening the store is what applies it, as the first request of the day
      // does for a real account.
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      // The three are asked for as well as the fourth, so that a `table_info`
      // answering about nothing at all - a renamed or rebuilt table - fails
      // here rather than reading as a column that has gone.
      const columns = await inStoreAsItIs(name, (sql) => columnsOf(sql, 'items'));
      expect(columns).toEqual(expect.arrayContaining(['title', 'captured_message', 'description']));
      expect(columns).not.toContain('preview');

      // Read the way a workspace is read rather than out of the table, because
      // what the drop could break is `itemColumns` naming a column that is gone
      // - which only a read through the real query can show.
      const snapshot = await storeNamed(name).snapshot(name, 'ws-before');
      expect(snapshot).toMatchObject({ status: 'ok' });
      expect(
        snapshot.status === 'ok'
          ? snapshot.value.items
              .map((item) => ({
                id: item.id,
                title: item.title,
                capturedMessage: item.capturedMessage,
                description: item.description,
              }))
              // Sorted here because both fixture items were captured at the
              // same moment and the read orders by that, so SQLite is free to
              // answer either way round.
              .sort((one, other) => one.id.localeCompare(other.id))
          : [],
      ).toEqual([
        {
          id: 'it-before',
          title: 'Captured before the update',
          capturedMessage: null,
          description: null,
        },
        {
          id: 'it-done-before',
          title: 'Finished before the update',
          capturedMessage: null,
          description: null,
        },
      ]);
    });
  });

  describe('no account keeps a sentence about where a workspace’s notes belong, however far behind it was', () => {
    /**
     * "Drop the workspace_routing_summary table" (issue 401). Integration
     * because whether a table exists is a fact about a real schema, against a
     * store that still holds a row of it rather than a new one.
     *
     * The second situation is the one `IF EXISTS` is for: a store whose table
     * is gone while the change is unrecorded would otherwise fail every
     * request that opens the account.
     */
    const schemaOf = (sql: SqlStorage) =>
      sql
        .exec<{ type: string; name: string; tbl_name: string; sql: string | null }>(
          `SELECT type, name, tbl_name, sql FROM sqlite_master
            WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
              AND name NOT LIKE '\\_%' ESCAPE '\\'
              AND tbl_name <> 'account_changes'
            ORDER BY type, name`,
        )
        .toArray();

    it.each([
      { situation: 'an account that still held one', alreadyGone: false },
      { situation: 'an account where it had already gone', alreadyGone: true },
    ])('$situation opens, holds none, and is built exactly as a new account is', async ({ situation, alreadyGone }) => {
      const name = `aged-store-routing-summary-${alreadyGone ? 'gone' : 'held'}`;
      await agedTo(name, justBefore('0050-drop-workspace-routing-summary'));
      await fillWithWhatIsAlreadyThere(name);
      if (alreadyGone) {
        await inStoreAsItIs(name, (sql) => sql.exec('DROP TABLE `workspace_routing_summary`'));
      }

      // Opening the store is what applies it, as the first request of the day
      // does for a real account.
      expect(await storeNamed(name).workspaces(name), situation).toMatchObject({ status: 'ok' });

      const schema = await inStoreAsItIs(name, schemaOf);
      // The table and its index both, by the table they belong to.
      expect(schema.filter((entry) => entry.tbl_name === 'workspace_routing_summary')).toEqual([]);

      const fresh = `${name}-new`;
      expect(await storeNamed(fresh).workspaces(fresh)).toMatchObject({ status: 'ok' });
      expect(schema).toEqual(await inStoreAsItIs(fresh, schemaOf));
    });
  });
});

describe('Capture', () => {
  describe('an item captured before capture wrote a title is named by what was captured', () => {
    /**
     * Capture used to leave the title empty and let the row fall through to the
     * captured message, which is the duplicate this release removed. Nothing
     * reads the captured message as a label any more, so without
     * `0018-title-from-captured-message` every item captured before it would
     * read *Untitled*.
     *
     * Integration rather than lower down because this is a rewrite of rows that
     * already exist, against a store that already holds them: the rule itself
     * is decided in packages/shared/tests/unit/domain/item.test.ts, and what a
     * statement does to a full table is not a thing a pure test can ask.
     */
    const LONG = `Ask Novy ${'x'.repeat(250)}`;
    /**
     * The run-lengths a single break cannot tell apart: `\r\n` is two break
     * characters together and a blank line is two more. A title is one space at
     * each, not one space per character - which is what replacing them one at a
     * time gives, and is a title no fresh capture of the same note would have.
     */
    const RUN = 'Ask Novy\r\nabout\n\npart 11';

    it('gives each of them the title it should have had, and rewrites nothing that has one', async () => {
      const name = 'aged-store-title-from-captured';
      await agedTo(name, justBefore('0018-title-from-captured-message'));
      await fillWithWhatIsAlreadyThere(name);
      await inStoreAsItIs(name, (sql) => {
        // Four items as capture left them, and one a person has since written
        // about: what was captured, whether it fits a title, and whether there
        // is already a description are the three things this decides on.
        sql.exec(
          `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen,
                              captured_message, description, created_at, updated_at)
             VALUES ('it-fits', ?, 'ws-before', 'internal', '', 'task', 0, ?, NULL, ?, ?),
                    ('it-long', ?, 'ws-before', 'internal', '', 'task', 0, ?, NULL, ?, ?),
                    ('it-lines', ?, 'ws-before', 'internal', '  ', 'task', 0, ?, NULL, ?, ?),
                    ('it-run', ?, 'ws-before', 'internal', '', 'task', 0, ?, NULL, ?, ?),
                    ('it-written-about', ?, 'ws-before', 'internal', '', 'task', 0, ?, ?, ?, ?)`,
          name,
          'Ask Novy about part 11',
          AT,
          AT,
          name,
          LONG,
          AT,
          AT,
          name,
          'Ask Novy\nabout part 11',
          AT,
          AT,
          name,
          RUN,
          AT,
          AT,
          name,
          LONG,
          'Tolerances, and the sign-off date',
          AT,
          AT,
        );
      });

      // Opening the store is what applies it, as the first request of the day
      // does for a real account.
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      // Read through the real query rather than out of the table, because what
      // a person ends up seeing is the snapshot the app reads.
      const snapshot = await storeNamed(name).snapshot(name, 'ws-before');
      expect(snapshot).toMatchObject({ status: 'ok' });
      const texts = (id: string) => {
        const item = snapshot.status === 'ok' ? snapshot.value.items.find((it) => it.id === id) : undefined;
        return item && { title: item.title, description: item.description };
      };

      expect(texts('it-fits')).toEqual({
        title: 'Ask Novy about part 11',
        description: null,
      });
      // Cut for the title, kept whole in the description, so the 201st
      // character onwards is not left only in a text nobody can edit.
      expect(texts('it-long')).toEqual({ title: LONG.slice(0, 200), description: LONG });
      // A title is one line, so the break closes up rather than being stored.
      expect(texts('it-lines')).toEqual({
        title: 'Ask Novy about part 11',
        description: 'Ask Novy\nabout part 11',
      });
      // A run of breaks closes up to one space too, so a note backfilled here
      // is named exactly as the same note captured fresh would be.
      expect(texts('it-run')).toEqual({ title: 'Ask Novy about part 11', description: RUN });
      // What somebody wrote is never overwritten by what was captured.
      expect(texts('it-written-about')).toEqual({
        title: LONG.slice(0, 200),
        description: 'Tolerances, and the sign-off date',
      });
      // And an item that already had a title keeps it, untouched.
      expect(texts('it-before')).toEqual({
        title: 'Captured before the update',
        description: null,
      });

      // `updated_at` is what every change measures staleness by, so moving it
      // would refuse an edit made on a device between its last read and this -
      // and nothing a person did happened here.
      expect(
        await inStoreAsItIs(name, (sql) =>
          sql.exec("SELECT updated_at FROM items WHERE id = 'it-fits'").toArray(),
        ),
      ).toEqual([{ updated_at: AT }]);
    });
  });
});

describe('Workspace management', () => {
  describe('an account that was already in use keeps its workspaces in the order they were made', () => {
    /**
     * Here rather than with the other ordering rules because it is the only one
     * that needs an account from *before* workspaces could be ordered, and
     * arranging one is what this file already knows how to do.
     *
     * The order itself would survive without this - `created_at` breaks a tie,
     * so workspaces all sharing a place still come out oldest first. What would
     * not survive is the next thing that happens to them: a place of one's own
     * is what the tiebreak is a tiebreak *for*, and an account whose workspaces
     * all sit at zero is one where the column says nothing and every read is
     * leaning on the fallback.
     */
    const BEFORE_THE_ORDER = updates.findIndex((update) => update.name === '0004-workspace-order');

    it('gives each of them a place of its own, in the order they were made', async () => {
      const name = 'aged-store-before-the-order';
      await agedTo(name, BEFORE_THE_ORDER);
      await fillWithWhatIsAlreadyThere(name);

      // Opening it is what brings it up to date, exactly as the first request
      // of the day does for a real account.
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      expect(
        await inStoreAsItIs(name, (sql) =>
          sql
            .exec<{ id: string; position: number }>(
              'SELECT id, position FROM workspaces ORDER BY position',
            )
            .toArray(),
        ),
      ).toEqual([
        // The three this file adds to every table before the outstanding
        // updates run, made one second apart, in that order.
        { id: 'ws-before', position: 0 },
        { id: 'ws-during', position: 1 },
        { id: 'ws-after', position: 2 },
      ]);
    });
  });
});

describe('Triage', () => {
  describe('an item finished with before the app kept the time still says it is finished with', () => {
    /**
     * The one row the update has to carry rather than leave alone: being done
     * used to live in `status` and nothing else, so an account brought up to
     * date without this would show every item it had ever finished with back in
     * the Inbox ("An item is either yours to deal with or finished with", issue
     * 154).
     */
    const BEFORE_THE_TIME = updates.findIndex((update) => update.name === '0007-item-completed-at');

    it.each([
      { situation: 'was finished with', id: 'it-done-before', completed: FINISHED_AT },
      { situation: 'was still to deal with', id: 'it-before', completed: null },
    ])('an item that $situation', async ({ id, completed }) => {
      const name = `aged-store-before-the-time-${id}`;
      await agedTo(name, BEFORE_THE_TIME);
      await fillWithWhatIsAlreadyThere(name);

      // Opening it is what brings it up to date, exactly as the first request
      // of the day does for a real account.
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      expect(
        await inStoreAsItIs(name, (sql) =>
          sql
            .exec<{ completed_at: string | null }>(
              'SELECT completed_at FROM items WHERE id = ?',
              id,
            )
            .toArray(),
        ),
      ).toEqual([{ completed_at: completed }]);
    });
  });
});

describe('Capture', () => {
  describe('an item captured before a workspace could be left undecided still belongs to its own', () => {
    /**
     * The direction that matters, and the reason the column defaults to
     * *decided* ("Capture something before you know which workspace it belongs
     * to", issue 165): every item that existed before this was captured into a
     * workspace deliberately, and one read back as undecided would appear in
     * every workspace's Inbox at once - a privacy boundary crossed by a
     * migration rather than by anybody's decision.
     *
     * It is also what lets the update be a single statement: the default does
     * the work a backfill would, so there is no second statement to half-apply.
     */
    const BEFORE_IT = updates.findIndex((update) => update.name === '0009-item-workspace-decided');

    it('reads as belonging to the workspace it was captured into', async () => {
      const name = 'aged-store-before-the-workspace-question';
      await agedTo(name, BEFORE_IT);
      await fillWithWhatIsAlreadyThere(name);

      // Opening it is what brings it up to date, exactly as the first request
      // of the day does for a real account.
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      expect(
        await inStoreAsItIs(name, (sql) =>
          sql
            .exec<{ workspace_id: string; workspace_decided: number }>(
              'SELECT workspace_id, workspace_decided FROM items ORDER BY id',
            )
            .toArray(),
        ),
      ).toEqual([
        { workspace_id: 'ws-before', workspace_decided: 1 },
        { workspace_id: 'ws-before', workspace_decided: 1 },
      ]);
    });
  });

  describe('the two types an account started with are called Task and Note', () => {
    /**
     * The rename is data rather than code - no read anywhere names either word
     * ("Call the two standard types Task and Note", issue 194) - so the only
     * thing that can go wrong is which rows it lands on and what the live-name
     * index does about it. Every case here is a store that was already in use
     * when it arrived, which is the only kind that has an *Action* to rename.
     */
    const BEFORE_THE_WORDS = updates.findIndex((update) => update.name === '0012-standard-types');

    /** Every type the store holds, deleted ones included, in the order they are listed in. */
    const typesOf = (name: string) =>
      inStoreAsItIs(name, (sql) =>
        sql
          .exec(
            `SELECT id, name, folded_name, color, position, deleted_at
               FROM item_types ORDER BY position`,
          )
          .toArray(),
      );

    it('renames them and changes nothing else about them', async () => {
      const name = 'aged-store-standard-types';
      await agedTo(name, BEFORE_THE_WORDS);
      await fillWithWhatIsAlreadyThere(name);

      // Opening it is what brings it up to date, exactly as the first request
      // of the day does for a real account.
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      expect(await typesOf(name)).toEqual([
        // The same two rows: the ids `0008-item-types` derived from the
        // account's, the colours it gave them and the places it put them in.
        // The ids are the load-bearing half - they are what every Item already
        // captured as one of these points at, so keeping them is what makes
        // this a rename rather than a new pair with the old ones orphaned.
        {
          id: `${name}-type-action`,
          name: 'Task',
          folded_name: 'task',
          color: '#6f62b5',
          position: 0,
          deleted_at: null,
        },
        {
          id: `${name}-type-thought`,
          name: 'Note',
          folded_name: 'note',
          color: '#3a72c8',
          position: 1,
          deleted_at: null,
        },
        // The type this file writes into every table before the outstanding
        // changes run, untouched: the rename names two rows and no others.
        {
          id: 'ty-before',
          name: 'Before',
          folded_name: 'before',
          color: '#c06a45',
          position: 7,
          deleted_at: null,
        },
      ]);
    });

    it.each([
      {
        situation: 'one somebody had already renamed themselves',
        store: 'aged-store-standard-types-renamed',
        arrange: (name: string) => ({
          sql: `UPDATE item_types SET name = 'Doing', folded_name = 'doing' WHERE id = ?`,
          params: [`${name}-type-action`],
        }),
        expected: [{ name: 'Task', deleted_at: null }, { name: 'Note', deleted_at: null }],
      },
      {
        situation: 'one somebody had deleted, whose name is shown nowhere either way',
        store: 'aged-store-standard-types-deleted',
        arrange: (name: string) => ({
          sql: `UPDATE item_types SET deleted_at = ? WHERE id = ?`,
          params: [AT, `${name}-type-action`],
        }),
        expected: [{ name: 'Task', deleted_at: AT }, { name: 'Note', deleted_at: null }],
      },
    ])('renames $situation', async ({ store: name, arrange, expected }) => {
      await agedTo(name, BEFORE_THE_WORDS);
      const { sql, params } = arrange(name);
      await inStoreAsItIs(name, (store) => store.exec(sql, ...params));

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      expect(await typesOf(name)).toMatchObject(expected);
    });

    it('refuses to run at all where the account has already named a type Task', async () => {
      const name = 'aged-store-standard-types-taken';
      await agedTo(name, BEFORE_THE_WORDS);
      // A type this account named itself while *Task* was still free, in the
      // lower case that proves what collides is the fold rather than the word
      // as it is written. The index is what refuses the rename, and failing
      // loudly is the chosen outcome: the alternative leaves store and code
      // quietly disagreeing about what the standard types are called. It is
      // recovered by rolling the release back - which never runs this change -
      // renaming this one, and rolling forward.
      await inStoreAsItIs(name, (sql) =>
        sql.exec(
          `INSERT INTO item_types (id, tenant_id, name, folded_name, color, position, created_at)
           VALUES ('ty-task', ?, 'task', 'task', '#c06a45', 5, ?)`,
          name,
          AT,
        ),
      );

      expect(await storeNamed(name).workspaces(name)).toMatchObject({
        status: 'not-up-to-date',
        failure: expect.stringContaining('0012-standard-types'),
      });

      // Nothing of it is left behind, so it is retried whole the moment the
      // colliding name is given up.
      expect((await typesOf(name)).map((type) => type.name)).toEqual([
        'Action',
        'Thought',
        'task',
      ]);
    });
  });
});

describe('Layouts', () => {
  describe('the layouts an account already had are named for the width they were made at', () => {
    /**
     * The change is applied to a store that has two layouts of one dashboard at
     * the same width, which nothing ever stopped and which is exactly what the
     * unique index it then creates would refuse.
     */

    it('numbers two of one width apart rather than failing the account', async () => {
      const name = 'aged-store-layout-names';
      await agedTo(name, justBefore('0011-layout-names'));
      await fillWithWhatIsAlreadyThere(name);

      // Applied on its own rather than through a full open, which would carry
      // the store all the way to `0020-drop-layout-name-and-width` - these
      // rows carry no `screen_size_id`, so that change drops them along with
      // their rows and placements. What is under test is this one change's
      // own conversion, not what survives past a later one that discards it.
      await applyChange(name, '0011-layout-names');

      expect(
        await inStoreAsItIs(name, (sql) =>
          sql
            .exec('SELECT id, name, folded_name FROM layouts ORDER BY created_at, id')
            .toArray(),
        ),
      ).toEqual([
        { id: 'ly-before', name: '1280 px', folded_name: '1280 px' },
        { id: 'ly-twin', name: '1280 px (2)', folded_name: '1280 px (2)' },
      ]);
    });
  });

  describe('the lines a person arranged their panels onto survive becoming rows', () => {
    /**
     * The conversion's whole job. Which panels shared a line was decided by the
     * widths and the order, and drawn by CSS wrapping at twelve columns - so it
     * is real, and it exists nowhere but as a consequence. One row per panel
     * would be simple and would flatten every dashboard anyone has.
     */
    it('puts a panel that wrapped onto the next line in a row of its own', async () => {
      const name = 'aged-store-panel-rows';
      await agedTo(name, justBefore('0013-panel-rows'));
      // Eight columns and then five: thirteen is past the grid, so the second
      // panel wrapped.
      await fillWithWhatIsAlreadyThere(name);

      // Applied on its own rather than through a full open, which would carry
      // the store all the way to `0020-drop-layout-name-and-width` - this
      // Layout carries no `screen_size_id`, so that change takes it and its
      // placements with it. What is under test is this one change's own
      // conversion, not what survives past a later one that discards it.
      await applyChange(name, '0013-panel-rows');

      expect(
        await inStoreAsItIs(name, (sql) =>
          sql
            .exec('SELECT panel_id, row_index, position, span FROM panel_placements ORDER BY row_index, position')
            .toArray(),
        ),
      ).toEqual([
        { panel_id: 'pn-before', row_index: 0, position: 0, span: 8 },
        { panel_id: 'pn-wrapped', row_index: 1, position: 0, span: 5 },
      ]);
    });

    it('gives each row the height of the tallest panel that was on it', async () => {
      // So nothing on screen changes size on the day this lands: three grid
      // rows is 3 * 84 - 4, and two is 2 * 84 - 4.
      const name = 'aged-store-panel-row-heights';
      await agedTo(name, justBefore('0013-panel-rows'));
      await fillWithWhatIsAlreadyThere(name);

      // Applied on its own rather than through a full open - see the case
      // above.
      await applyChange(name, '0013-panel-rows');

      expect(
        await inStoreAsItIs(name, (sql) =>
          sql.exec('SELECT row_index, height FROM layout_rows ORDER BY row_index').toArray(),
        ),
      ).toEqual([
        { row_index: 0, height: 248 },
        { row_index: 1, height: 164 },
      ]);
    });
  });

  describe('the columns and rule a layout no longer needs are gone, and everything else survives it', () => {
    // Both applied on their own rather than through a full open, which would
    // carry the store on to `0053-one-layout-per-dashboard` - that change
    // takes `screen_size_id` away again and keeps one Layout per Dashboard.
    // What is under test is this one change's own conversion.
    it('reaches the shape the code expects: no name, no folded name, no width, and a screen size required', async () => {
      const name = 'aged-store-drop-layout-name-and-width-shape';
      await agedTo(name, justBefore('0020-drop-layout-name-and-width'));
      await fillWithWhatIsAlreadyThere(name);

      await applyChange(name, '0020-drop-layout-name-and-width');

      const columns = await inStoreAsItIs(name, (sql) =>
        sql.exec<{ name: string; notnull: number }>('PRAGMA table_info(layouts)').toArray(),
      );
      const names = columns.map((c) => c.name);
      expect(names).toEqual(
        expect.arrayContaining(['id', 'tenant_id', 'dashboard_id', 'screen_size_id', 'created_at']),
      );
      expect(names).not.toContain('name');
      expect(names).not.toContain('folded_name');
      expect(names).not.toContain('screen_width');
      expect(columns.find((c) => c.name === 'screen_size_id')?.notnull).toBe(1);
    });

    it('keeps a Layout that already names a real screen size, with its rows and placements, and drops only the ones that predate them', async () => {
      const name = 'aged-store-drop-layout-name-and-width-survivors';
      await agedTo(name, justBefore('0020-drop-layout-name-and-width'));
      // `ly-wide`, from `rowsFor`, already names a real screen size - what
      // every Layout "Draw a dashboard against the screen sizes its account
      // has" (issue 263) writes - with a row and placements of its own.
      // `ly-before` and `ly-twin` are the rows the new rule rejects: they
      // carry no `screen_size_id` at this point.
      await fillWithWhatIsAlreadyThere(name);
      // A filing, so there is one to prove survives - nothing in `rowsFor`
      // makes one, since no update before this file existed needed to meet a
      // full `panel_items` table.
      await inStoreAsItIs(name, (sql) => {
        sql.exec(
          `INSERT INTO panel_items (tenant_id, panel_id, item_id, position, created_at)
           VALUES (?, 'pn-before', 'it-before', 0, ?)`,
          name,
          AT,
        );
      });

      await applyChange(name, '0020-drop-layout-name-and-width');

      expect(
        await inStoreAsItIs(name, (sql) =>
          sql.exec<{ id: string }>('SELECT id FROM layouts ORDER BY id').toArray(),
        ),
      ).toEqual([{ id: 'ly-wide' }]);
      expect(
        await inStoreAsItIs(name, (sql) =>
          sql.exec('SELECT layout_id, row_index, height FROM layout_rows').toArray(),
        ),
      ).toEqual([{ layout_id: 'ly-wide', row_index: 0, height: 300 }]);
      expect(
        await inStoreAsItIs(name, (sql) =>
          sql.exec('SELECT layout_id, panel_id, span FROM panel_placements ORDER BY position').toArray(),
        ),
      ).toEqual([
        { layout_id: 'ly-wide', panel_id: 'pn-before', span: 7 },
        { layout_id: 'ly-wide', panel_id: 'pn-wrapped', span: 5 },
      ]);
      // Everything else this fixture wrote is untouched.
      expect(
        await inStoreAsItIs(name, (sql) => sql.exec('SELECT id FROM panels ORDER BY id').toArray()),
      ).toEqual([{ id: 'pn-before' }, { id: 'pn-wrapped' }]);
      expect(
        await inStoreAsItIs(name, (sql) => sql.exec('SELECT id FROM items ORDER BY id').toArray()),
      ).toEqual([{ id: 'it-before' }, { id: 'it-done-before' }]);
      expect(
        await inStoreAsItIs(name, (sql) =>
          sql.exec('SELECT panel_id, item_id FROM panel_items').toArray(),
        ),
      ).toEqual([{ panel_id: 'pn-before', item_id: 'it-before' }]);
    });
  });

  describe('every dashboard keeps the one layout made for its widest screen, exactly as it was, and no screen size is left', () => {
    /**
     * The situations "Draw a Dashboard on its one Layout, with nothing to
     * choose it by" (issue 712) proved the board drew, at L1, with the
     * ordering this change replaced: widest screen size, ties to the size
     * made earliest, then the lowest size id, then the lowest Layout id. Asked
     * again here of the SQL that keeps one, so what a Dashboard showed before
     * the conversion is what it shows after.
     *
     * Each Layout is given a row and placements of its own, so the one kept
     * is seen to keep exactly what it had and every other is seen to go.
     */
    const situations: {
      situation: string;
      sizes: [id: string, width: number, madeAt: string][];
      layouts: [id: string, sizeId: string][];
      kept: string | null;
    }[] = [
      {
        situation: 'the 2560 px one over the 1646 px one, the wider made last',
        sizes: [['sz-laptop', 1646, AT], ['sz-wide', 2560, AT]],
        layouts: [['ly-laptop', 'sz-laptop'], ['ly-wide', 'sz-wide']],
        kept: 'ly-wide',
      },
      {
        situation: 'the 2560 px one over the 1646 px one, the wider made first',
        sizes: [['sz-wide', 2560, AT], ['sz-laptop', 1646, AT]],
        layouts: [['ly-wide', 'sz-wide'], ['ly-laptop', 'sz-laptop']],
        kept: 'ly-wide',
      },
      {
        situation: 'the widest of three',
        sizes: [['sz-laptop', 1280, AT], ['sz-wide', 2560, AT], ['sz-desk', 1920, AT]],
        layouts: [['ly-laptop', 'sz-laptop'], ['ly-wide', 'sz-wide'], ['ly-desk', 'sz-desk']],
        kept: 'ly-wide',
      },
      {
        situation: 'the one whose screen size was made earlier, at one width',
        sizes: [['sz-b', 1280, AT], ['sz-a', 1280, LATER]],
        layouts: [['ly-on-a', 'sz-a'], ['ly-on-b', 'sz-b']],
        kept: 'ly-on-b',
      },
      {
        situation: 'the one whose screen size has the lower id, at one width made at one moment',
        sizes: [['sz-b', 1280, AT], ['sz-a', 1280, AT]],
        layouts: [['ly-on-b', 'sz-b'], ['ly-on-a', 'sz-a']],
        kept: 'ly-on-a',
      },
      {
        situation: 'the one with the lower id, at one screen size',
        sizes: [['sz-one', 1280, AT]],
        layouts: [['ly-b', 'sz-one'], ['ly-a', 'sz-one']],
        kept: 'ly-a',
      },
      {
        situation: 'its only one, made below 480 px',
        sizes: [['sz-small', 320, AT]],
        layouts: [['ly-only', 'sz-small']],
        kept: 'ly-only',
      },
      {
        situation: 'none, where it had none',
        sizes: [['sz-wide', 2560, AT]],
        layouts: [],
        kept: null,
      },
    ];

    it.each(situations.map((one, index) => ({ ...one, index })))(
      'keeps $situation',
      async ({ index, sizes, layouts, kept }) => {
        const name = `aged-store-widest-${index}`;
        await agedTo(name, justBefore('0053-one-layout-per-dashboard'));
        await inStoreAsItIs(name, (sql) => {
          // On the Workspace every account nobody has used starts with.
          sql.exec(
            `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
             VALUES ('db-arranged', ?, 'ws-1', 'Arranged', 'arranged', ?)`,
            name,
            AT,
          );
          sql.exec(
            `INSERT INTO panels (id, tenant_id, dashboard_id, name, folded_name, created_at)
             VALUES ('pn-a', ?, 'db-arranged', 'A', 'a', ?), ('pn-b', ?, 'db-arranged', 'B', 'b', ?)`,
            name,
            AT,
            name,
            AT,
          );
          for (const [id, width, madeAt] of sizes) {
            sql.exec(
              `INSERT INTO screen_sizes (id, tenant_id, name, folded_name, width, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              id,
              name,
              id,
              id,
              width,
              madeAt,
            );
          }
          layouts.forEach(([id, sizeId], at) => {
            sql.exec(
              `INSERT INTO layouts (id, tenant_id, dashboard_id, screen_size_id, created_at)
               VALUES (?, ?, 'db-arranged', ?, ?)`,
              id,
              name,
              sizeId,
              AT,
            );
            sql.exec(
              'INSERT INTO layout_rows (tenant_id, layout_id, row_index, height) VALUES (?, ?, 0, ?)',
              name,
              id,
              200 + at * 10,
            );
            sql.exec(
              `INSERT INTO panel_placements (tenant_id, layout_id, panel_id, row_index, position, span)
               VALUES (?, ?, 'pn-a', 0, 0, ?), (?, ?, 'pn-b', 0, 1, ?)`,
              name,
              id,
              at + 1,
              name,
              id,
              12 - at,
            );
          });
        });
        const arrangementOf = (sql: SqlStorage, layoutId: string | null) => ({
          rows: sql
            .exec('SELECT row_index, height FROM layout_rows WHERE layout_id = ?', layoutId)
            .toArray(),
          cells: sql
            .exec(
              'SELECT panel_id, row_index, position, span FROM panel_placements WHERE layout_id = ? ORDER BY position',
              layoutId,
            )
            .toArray(),
        });
        const before = await inStoreAsItIs(name, (sql) => arrangementOf(sql, kept));

        // Opened the way the first request after a deploy opens it.
        expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

        const after = await inStoreAsItIs(name, (sql) => ({
          layouts: sql.exec<{ id: string }>('SELECT id FROM layouts').toArray().map((row) => row.id),
          kept: arrangementOf(sql, kept),
          rowsLeft: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM layout_rows').toArray()[0]!.n,
          cellsLeft: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM panel_placements').toArray()[0]!.n,
          tables: sql
            .exec<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND (name = 'screen_sizes' OR name LIKE '%scratch' OR name = 'layouts_new')",
            )
            .toArray(),
          columns: columnsOf(sql, 'layouts'),
        }));
        expect(after.layouts).toEqual(kept ? [kept] : []);
        expect(after.kept).toEqual(before);
        // Nothing of the others is left behind, and nothing of the rebuild.
        expect(after.rowsLeft).toBe(kept ? 1 : 0);
        expect(after.cellsLeft).toBe(kept ? 2 : 0);
        expect(after.tables).toEqual([]);
        expect(after.columns).toEqual(['id', 'tenant_id', 'dashboard_id', 'created_at']);
      },
    );

    it('keeps the widest of each dashboard, not the widest of the account', async () => {
      const name = 'aged-store-widest-per-dashboard';
      await agedTo(name, justBefore('0053-one-layout-per-dashboard'));
      await inStoreAsItIs(name, (sql) => {
        sql.exec(
          `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
           VALUES ('db-one', ?, 'ws-1', 'One', 'one', ?), ('db-two', ?, 'ws-1', 'Two', 'two', ?)`,
          name,
          AT,
          name,
          AT,
        );
        sql.exec(
          `INSERT INTO screen_sizes (id, tenant_id, name, folded_name, width, created_at)
           VALUES ('sz-laptop', ?, 'Laptop', 'laptop', 1280, ?), ('sz-wide', ?, 'Wide', 'wide', 2560, ?)`,
          name,
          AT,
          name,
          AT,
        );
        // `db-two` was never arranged for the wide screen, so its laptop
        // Layout is its widest even though `db-one` has a wider one.
        sql.exec(
          `INSERT INTO layouts (id, tenant_id, dashboard_id, screen_size_id, created_at)
           VALUES ('ly-one-laptop', ?, 'db-one', 'sz-laptop', ?),
                  ('ly-one-wide', ?, 'db-one', 'sz-wide', ?),
                  ('ly-two-laptop', ?, 'db-two', 'sz-laptop', ?)`,
          name,
          AT,
          name,
          AT,
          name,
          AT,
        );
      });

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      const kept = await inStoreAsItIs(name, (sql) =>
        sql.exec('SELECT id, dashboard_id FROM layouts ORDER BY id').toArray(),
      );
      expect(kept).toEqual([
        { id: 'ly-one-wide', dashboard_id: 'db-one' },
        { id: 'ly-two-laptop', dashboard_id: 'db-two' },
      ]);
    });
  });

  describe('keeping one layout per dashboard touches nothing else an account holds', () => {
    /** Every row of the tables a person's own work is in, read whole. */
    const everythingElse = (sql: SqlStorage) =>
      Object.fromEntries(
        ['workspaces', 'dashboards', 'panels', 'panel_items', 'items', 'associations', 'item_types'].map(
          (table) => [table, sql.exec(`SELECT * FROM ${table} ORDER BY rowid`).toArray()],
        ),
      );

    it('leaves Dashboards, Panels, filings and Items exactly as they were', async () => {
      const name = 'aged-store-one-layout-leaves-the-rest';
      await agedTo(name, justBefore('0053-one-layout-per-dashboard'));
      await fillWithWhatIsAlreadyThere(name);
      await inStoreAsItIs(name, (sql) => {
        sql.exec(
          `INSERT INTO panel_items (tenant_id, panel_id, item_id, position, created_at)
           VALUES (?, 'pn-before', 'it-before', 0, ?), (?, 'pn-wrapped', 'it-done-before', 0, ?)`,
          name,
          AT,
          name,
          AT,
        );
      });
      const before = await inStoreAsItIs(name, everythingElse);

      // Applied alone rather than by opening the store, which would carry it on
      // through every later change - one of which adds a column to `panels`.
      await applyChange(name, '0053-one-layout-per-dashboard');

      expect(await inStoreAsItIs(name, everythingElse)).toEqual(before);
    });

    it('leaves the account as it was when it fails partway, and converts it on the next open', async () => {
      // Failed at the rebuild itself - after the arrangements were copied out
      // and emptied - by a table already holding the name it builds under,
      // which is the one way to stop it partway from outside.
      const name = 'aged-store-one-layout-fails-partway';
      await agedTo(name, justBefore('0053-one-layout-per-dashboard'));
      await fillWithWhatIsAlreadyThere(name);
      await inStoreAsItIs(name, (sql) => {
        sql.exec('CREATE TABLE layouts_new (in_the_way text)');
      });
      const before = await inStoreAsItIs(name, rowCountsOf);

      const failed = await storeNamed(name).workspaces(name);

      expect(failed).toMatchObject({ status: 'not-up-to-date' });
      expect(JSON.stringify(failed)).toContain('0053-one-layout-per-dashboard');
      expect(await inStoreAsItIs(name, rowCountsOf)).toEqual(before);

      await inStoreAsItIs(name, (sql) => {
        sql.exec('DROP TABLE layouts_new');
      });

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });
      expect(
        await inStoreAsItIs(name, (sql) => sql.exec('SELECT id FROM layouts').toArray()),
      ).toEqual([{ id: 'ly-wide' }]);
    });
  });

  describe('every layout an account already had reads exactly as before once Sections can be titled', () => {
    /**
     * `0060-layout-row-titles`'s direction that matters: every row already
     * stored takes no title, so it is the row of Panels it was and no Section
     * appears on any Dashboard the day it lands ("Add, rename and delete a
     * titled Section on a Dashboard", issue 896).
     */
    it('reads every row with its panels and height, and none of them titled', async () => {
      const name = 'aged-store-before-layout-row-titles';
      await agedTo(name, justBefore('0060-layout-row-titles'));
      await fillWithWhatIsAlreadyThere(name);

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      const snapshot = await storeNamed(name).snapshot(name, 'ws-before');
      expect(snapshot).toMatchObject({ status: 'ok' });
      expect(
        snapshot.status === 'ok'
          ? snapshot.value.layouts.map((layout) => ({ id: layout.id, rows: layout.rows }))
          : [],
      ).toEqual([
        {
          id: 'ly-before',
          rows: [
            { height: 248, cells: [{ panelId: 'pn-before', span: 8 }] },
            { height: 164, cells: [{ panelId: 'pn-wrapped', span: 5 }] },
          ],
        },
      ]);
    });
  });
});

describe('Panels', () => {
  describe('every panel an account already had is still made of what it was made of', () => {
    /**
     * The direction that matters about `0035-panel-filters`: what makes a panel
     * a filter is the column being set, so every panel that already existed
     * takes NULL and is not one. A default of anything else would turn every
     * panel in every account into a filter gathering nothing, which is a panel
     * drawing none of the items filed onto it.
     */
    it('reads an items panel and a text panel back as they were, and neither as a filter', async () => {
      const name = 'aged-store-before-filters';
      await agedTo(name, justBefore('0035-panel-filters'));
      await fillWithWhatIsAlreadyThere(name);
      // A panel of text as well as the two panels of items `rowsFor` writes,
      // so both kinds meet the change rather than only the default one.
      await inStoreAsItIs(name, (sql) =>
        sql.exec(
          `INSERT INTO panels (id, tenant_id, dashboard_id, name, folded_name, kind, created_at)
           VALUES ('pn-words', ?, 'db-before', 'Words', 'words', 'text', ?)`,
          name,
          AT,
        ),
      );

      // Opening it is what applies the change, as the first request of the day
      // does for a real account.
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      // Read through the real query rather than out of the table, because what
      // the change could break is what a person ends up looking at.
      const snapshot = await storeNamed(name).snapshot(name, 'ws-before');
      expect(snapshot).toMatchObject({ status: 'ok' });
      expect(
        snapshot.status === 'ok'
          ? snapshot.value.panels
              .map((panel) => ({ id: panel.id, kind: panel.kind, filter: panel.filter }))
              .sort((one, other) => one.id.localeCompare(other.id))
          : [],
      ).toEqual([
        { id: 'pn-before', kind: 'items', filter: null },
        { id: 'pn-words', kind: 'text', filter: null },
        { id: 'pn-wrapped', kind: 'items', filter: null },
      ]);
    });
  });

  describe('every panel an account already had is drawn in the order its items were filed in', () => {
    /**
     * `0040-panel-sort`'s direction that matters: every panel that already
     * existed takes NULL, which is Manual, so none of them starts drawing its
     * rows in an order nobody chose.
     */
    it('reads every panel back as Manual', async () => {
      const name = 'aged-store-before-sort';
      await agedTo(name, justBefore('0040-panel-sort'));
      await fillWithWhatIsAlreadyThere(name);

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      const snapshot = await storeNamed(name).snapshot(name, 'ws-before');
      expect(snapshot).toMatchObject({ status: 'ok' });
      const panels = snapshot.status === 'ok' ? snapshot.value.panels : [];
      expect(panels.length).toBeGreaterThan(0);
      expect(panels.map((panel) => panel.sort)).toEqual(panels.map(() => null));
    });
  });

  describe('every panel an account already had is still proposed', () => {
    /**
     * `0057-panel-never-propose`'s direction that matters: every panel that
     * already existed takes the default, unflagged, so none of them drops out
     * of proposals the day it lands.
     */
    it('reads every panel back as unflagged, and offers every panel of items', async () => {
      const name = 'aged-store-before-never-propose';
      await agedTo(name, justBefore('0057-panel-never-propose'));
      await fillWithWhatIsAlreadyThere(name);

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      const snapshot = await storeNamed(name).snapshot(name, 'ws-before');
      expect(snapshot).toMatchObject({ status: 'ok' });
      const panels = snapshot.status === 'ok' ? snapshot.value.panels : [];
      expect(panels.length).toBeGreaterThan(0);
      expect(panels.map((panel) => panel.neverPropose)).toEqual(panels.map(() => false));

      const offered = await storeNamed(name).panelsThatTakeItems(name, 'ws-before');
      expect(offered.status === 'ok' ? offered.value.map((panel) => panel.id).sort() : []).toEqual(
        panels.map((panel) => panel.id).sort(),
      );
    });
  });
});

describe('What Cockpit changed', () => {
  describe('a refinement recorded before this shipped is still read back, saying what it lacks', () => {
    /**
     * `0051-rewrite-history-looks-at` and `0052-rewrite-history-panel-before`
     * ("Rename Rewrite history to Smart refinements, and show each field's
     * change", issue 614) meet a row neither column existed for: it comes back
     * with both read as never recorded, and everything it did record intact.
     */
    it('returns it, with neither what it looked at nor the suggested panel it started from', async () => {
      const name = 'aged-store-before-smart-refinements';
      await agedTo(name, justBefore('0051-rewrite-history-looks-at'));
      await fillWithWhatIsAlreadyThere(name);

      const read = await storeNamed(name).rewriteHistoryForItem(name, 'it-before');

      expect(read).toMatchObject({ status: 'ok' });
      expect(read.status === 'ok' ? read.value : []).toEqual([
        expect.objectContaining({
          id: 'rh-before',
          titleAfter: 'Captured before the update',
          descriptionAfter: 'What it said.',
          looksAt: null,
          suggestedPanelBefore: null,
          suggestedPanelAfter: { id: 'pn-before', name: 'Before', dashboardName: 'Before' },
        }),
      ]);
    });

    it('reads a scope it does not know as never recorded', async () => {
      const name = 'aged-store-unknown-scope';
      await agedTo(name, justBefore('0051-rewrite-history-looks-at'));
      await fillWithWhatIsAlreadyThere(name);
      await storeNamed(name).rewriteHistoryForItem(name, 'it-before');
      await inStoreAsItIs(name, (sql) => {
        sql.exec("UPDATE rewrite_history SET looks_at = 'from-a-later-version'");
      });

      const read = await storeNamed(name).rewriteHistoryForItem(name, 'it-before');

      expect(read.status === 'ok' ? read.value : []).toEqual([expect.objectContaining({ looksAt: null })]);
    });
  });
});

describe('Connector management', () => {
  /**
   * `0056-gmail-followed-mark` ("Connect Gmail by star, and bring in
   * conversations starred from then on", issue 822) meets a Gmail connection
   * and a conversation it brought in from before the star existed.
   */
  describe('every Gmail connection and conversation stored before the star follows the label', () => {
    it('reads the label for each, and changes nothing else either holds', async () => {
      const name = 'aged-store-before-the-star';
      await agedTo(name, justBefore('0056-gmail-followed-mark'));
      await fillWithWhatIsAlreadyThere(name);
      const held = () =>
        inStoreAsItIs(name, (sql) => ({
          connections: sql.exec('SELECT * FROM connector_accounts ORDER BY id').toArray(),
          links: sql.exec('SELECT * FROM gmail_conversations').toArray(),
        }));
      const before = await held();

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      const after = await held();
      expect(before.connections.map((row) => row.connector_id)).toEqual(['teams', 'gmail']);
      expect(before.links).toHaveLength(1);
      expect(after.connections).toEqual(before.connections.map((row) => ({ ...row, follows: 'label' })));
      expect(after.links).toEqual(before.links.map((row) => ({ ...row, mark: 'label' })));
    });
  });
});

describe('Workspace management', () => {
  /**
   * The other half of "an account nobody has opened starts with one workspace"
   * (src/accounts/changes.ts, `0015-first-workspace`): an account that *has*
   * been opened is left exactly as it is. This file's account is the case -
   * it has been in use since before most of the change list existed - so the
   * claim is that bringing it up to date gives it nothing it did not have.
   */
  describe('an account that was already in use is given no workspace of its own', () => {
    it('keeps the workspaces it had, and gains none', async () => {
      const name = 'aged-store-already-in-use';
      // Aged to before the workspaces even had an order, so what is brought up
      // to date afterwards is the whole of the list this change sits at the end
      // of.
      await agedTo(
        name,
        updates.findIndex((update) => update.name === '0004-workspace-order'),
      );
      await fillWithWhatIsAlreadyThere(name);

      // Opening it is what brings it up to date, exactly as the first request
      // of the day does for a real account - and what it must not do on the way
      // is hand this account a Workspace 1 it never asked for.
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      expect(
        await inStoreAsItIs(name, (sql) =>
          sql.exec<{ id: string }>('SELECT id FROM workspaces ORDER BY position').toArray(),
        ),
      ).toEqual([{ id: 'ws-before' }, { id: 'ws-during' }, { id: 'ws-after' }]);
    });
  });
});

describe('Agents', () => {
  /**
   * `0058-end-runs-on-closed-items` ("End the agent runs left open on Items
   * already done or dismissed", issue 834). Integration because it is the
   * store's own change, run against rows written before it existed - which no
   * request can arrange now that an Item's Status ends its run.
   */
  const RUN_STARTED = '2026-09-01T10:00:00.000Z';
  const CLOSED = '2026-09-01T11:00:00.000Z';
  const LATER_STILL = '2026-09-01T12:00:00.000Z';
  const ENDED_BEFORE = '2026-09-01T10:30:00.000Z';
  const BEFORE_THE_RUN = '2026-09-01T09:00:00.000Z';

  const situations = [
    {
      situation: 'a run on a Done Item ends at its completion',
      done: CLOSED,
      dismissed: null,
      ended: null,
      expected: CLOSED,
    },
    {
      situation: 'a run on a dismissed Item ends at the dismissal',
      done: null,
      dismissed: CLOSED,
      ended: null,
      expected: CLOSED,
    },
    {
      situation: 'a run on an Item dismissed and later done ends at the dismissal',
      done: LATER_STILL,
      dismissed: CLOSED,
      ended: null,
      expected: CLOSED,
    },
    {
      // Two precisions, so the later of the two sorts first as text; the
      // earlier moment still wins.
      situation: 'a run on an Item done and a moment later dismissed ends at the completion',
      done: '2026-09-01T11:00:05Z',
      dismissed: '2026-09-01T11:00:05.500Z',
      ended: null,
      expected: '2026-09-01T11:00:05Z',
    },
    {
      situation: 'a run on an Item closed before the run started ends at its start',
      done: BEFORE_THE_RUN,
      dismissed: null,
      ended: null,
      expected: RUN_STARTED,
    },
    {
      situation: 'a run on an open Item stays open',
      done: null,
      dismissed: null,
      ended: null,
      expected: null,
    },
    {
      situation: 'a run already ended on a Done Item keeps its end',
      done: CLOSED,
      dismissed: null,
      ended: ENDED_BEFORE,
      expected: ENDED_BEFORE,
    },
  ];

  /** Every run the store holds, by its Item, with when it ended. */
  const runsIn = (name: string) =>
    inStoreAsItIs(name, (sql) =>
      sql
        .exec<{ item_id: string; ended_at: string | null }>(
          'SELECT item_id, ended_at FROM agent_runs ORDER BY item_id',
        )
        .toArray(),
    );

  /** A store from just before the change, holding one Item and one run per situation. */
  async function storeWithRunsLeftOpen(name: string): Promise<void> {
    await agedTo(name, justBefore('0058-end-runs-on-closed-items'));
    await fillWithWhatIsAlreadyThere(name);
    await inStoreAsItIs(name, (sql) => {
      situations.forEach((s, nth) => {
        sql.exec(
          `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen,
                              completed_at, deleted_at, created_at, updated_at)
             VALUES (?, ?, 'ws-before', 'internal', ?, 'task', 0, ?, ?, ?, ?)`,
          `it-run-${nth}`,
          name,
          s.situation,
          s.done,
          s.dismissed,
          AT,
          AT,
        );
        sql.exec(
          `INSERT INTO agent_runs (id, tenant_id, workspace_id, item_id, agent_id, status, started_at, ended_at)
             VALUES (?, ?, 'ws-before', ?, 'ag-before', 'working', ?, ?)`,
          `run-${nth}`,
          name,
          `it-run-${nth}`,
          RUN_STARTED,
          s.ended,
        );
      });
    });
  }

  describe('every run left open on a closed Item ends, stamped when its Item was closed', () => {
    it('ends each as its situation says, and leaves the rest alone', async () => {
      const name = 'aged-store-runs-left-open';
      await storeWithRunsLeftOpen(name);

      // Opening the store is what applies it, as the first request of the day
      // does for a real account.
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      const ended = new Map((await runsIn(name)).map((run) => [run.item_id, run.ended_at]));
      // Compared whole, so every situation that is wrong shows at once.
      expect(situations.map((s, nth) => ({ situation: s.situation, ended: ended.get(`it-run-${nth}`) }))).toEqual(
        situations.map((s) => ({ situation: s.situation, ended: s.expected })),
      );
    });
  });

  describe('ending the runs left open a second time changes nothing', () => {
    it('leaves every run as the first time left it', async () => {
      const name = 'aged-store-runs-left-open-twice';
      await storeWithRunsLeftOpen(name);
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });
      const once = await runsIn(name);

      // Run again over the store it has already been applied to, which the
      // store itself never does - so this asks the statement, not the record.
      const change = accountChanges(name).find((update) => update.name === '0058-end-runs-on-closed-items');
      await inStoreAsItIs(name, (sql) => {
        for (const statement of change!.statements) sql.exec(statement.sql, ...(statement.params ?? []));
      });

      expect(await runsIn(name)).toEqual(once);
    });
  });
});

/**
 * "Store Gmail Items under their connector id" (issue 926): every Gmail Item
 * an account already holds is rewritten to name `gmail` beside the `mail` its
 * source column keeps. Integration because it is a rewrite of rows that
 * already exist, against a store that holds them; what a person then sees of
 * a Gmail Item is held at apps/api/tests/integration/http/capture-source.test.ts
 * and gmail-import.test.ts.
 */
const GMAIL_ITEMS = '0062-gmail-items-under-their-connector';

/** What the change logs when it leaves Gmail Items naming another connector alone. */
const LEFT_ALONE = 'Gmail Items already naming another connector were left as they are';

interface Held {
  id: string;
  source: string;
  connector: string | null;
}

/** Every Item the store holds, by id, with the two columns its source is stored in. */
const sourcesIn = (name: string) =>
  inStoreAsItIs(name, (sql) =>
    sql
      .exec<{ id: string; source: string; source_connector: string | null }>(
        'SELECT id, source, source_connector FROM items ORDER BY id',
      )
      .toArray(),
  );

/**
 * A store from just before the change, filled as every other case here is -
 * `it-before` being a Gmail Item - and holding `held` besides. An entry naming
 * `it-before` restores it with the source given instead.
 */
async function storeHolding(name: string, held: readonly Held[]): Promise<void> {
  await agedTo(name, justBefore(GMAIL_ITEMS));
  await fillWithWhatIsAlreadyThere(name);
  await inStoreAsItIs(name, (sql) => {
    for (const one of held) {
      sql.exec(
        `INSERT INTO items (id, tenant_id, workspace_id, source, source_connector, title, status, unseen, created_at, updated_at)
           VALUES (?, ?, 'ws-before', ?, ?, ?, 'task', 0, ?, ?)
           ON CONFLICT(id) DO UPDATE SET source = excluded.source, source_connector = excluded.source_connector`,
        one.id,
        name,
        one.source,
        one.connector,
        `Held as ${one.source}`,
        AT,
        AT,
      );
    }
  });
}

/** The rows the change logged as left alone, by how many it counted. */
function leftAloneIn(lines: unknown[][]): number[] {
  return lines
    .map(([line]) => String(line))
    .filter((line) => line.includes(LEFT_ALONE))
    .map((line) => (JSON.parse(line) as { level: string; data: { rows: number } }))
    .map((logged) => {
      expect(logged.level).toBe('warn');
      return logged.data.rows;
    });
}

describe('Capture', () => {
  describe('a Gmail Item is stored under its connector, gmail', () => {
    it('one stored before is rewritten to name it, and nothing else about it changes', async () => {
      const name = 'aged-store-gmail-item-whole';
      await agedTo(name, justBefore(GMAIL_ITEMS));
      await fillWithWhatIsAlreadyThere(name);
      // A Gmail Item as bringing in a conversation wrote it, every column it
      // fills filled - so a statement touching more than the one column shows.
      await inStoreAsItIs(name, (sql) =>
        sql.exec(
          `INSERT INTO items (id, tenant_id, workspace_id, source, source_id, source_link, sender, source_timestamp,
                              captured_message, title, description, status, unseen, priority, due_date,
                              completed_at, created_at, updated_at)
             VALUES ('it-gmail-whole', ?, 'ws-before', 'mail', 'thread-whole', 'https://mail.google.com/mail/#all/thread-whole',
                     'Pieter Claes', ?, 'Invoice 42', 'Invoice 42', 'Please pay by Friday', 'task', 1, 'high', '2026-08-20',
                     ?, ?, ?)`,
          name,
          AT,
          LATER,
          AT,
          LATEST,
        ),
      );
      const rowOf = () =>
        inStoreAsItIs(name, (sql) => sql.exec("SELECT * FROM items WHERE id = 'it-gmail-whole'").toArray()[0]);
      const before = await rowOf();

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

      expect(await rowOf()).toEqual({ ...before, source: 'mail', source_connector: 'gmail' });
    });
  });
});

describe('Accounts', () => {
  describe('every account comes up to date with its Gmail Items under their connector, and nothing else rewritten', () => {
    const own = { id: 'it-own', source: 'internal', connector: null };
    const fromTeams = { id: 'it-teams', source: 'internal', connector: 'teams' };
    const fromAnApp = { id: 'it-app', source: 'internal', connector: 'mcp' };

    it.each([
      {
        situation: 'Gmail Items beside Items of your own, from Teams and from an app: only the Gmail ones change',
        held: [own, fromTeams, fromAnApp, { id: 'it-gmail', source: 'mail', connector: null }],
        rewritten: ['it-before', 'it-gmail'],
        logged: [],
      },
      {
        situation: 'a Gmail Item already naming another connector: left as it is, and logged',
        held: [{ id: 'it-elsewhere', source: 'mail', connector: 'outlook' }],
        rewritten: ['it-before'],
        logged: [1],
      },
      {
        situation: 'no Gmail Items: nothing changes',
        held: [own, fromTeams, { id: 'it-before', source: 'internal', connector: null }],
        rewritten: [],
        logged: [],
      },
      {
        situation: '150 Gmail Items: every one rewritten',
        held: Array.from({ length: 150 }, (_, nth) => ({
          id: `it-gmail-${String(nth).padStart(3, '0')}`,
          source: 'mail',
          connector: null,
        })),
        rewritten: [
          'it-before',
          ...Array.from({ length: 150 }, (_, nth) => `it-gmail-${String(nth).padStart(3, '0')}`),
        ],
        logged: [],
      },
    ])('$situation', async ({ situation, held, rewritten, logged }) => {
      const name = `aged-store-gmail-${held.length}-${rewritten.length}`;
      await storeHolding(name, held);
      const before = await sourcesIn(name);

      const log = vi.spyOn(console, 'log');
      try {
        // Opening the store is what applies it, as the first request of the
        // day does for a real account.
        expect(await storeNamed(name).workspaces(name), situation).toMatchObject({ status: 'ok' });
        expect(leftAloneIn(log.mock.calls)).toEqual(logged);
      } finally {
        log.mockRestore();
      }

      // Compared whole, so a row changed that should not have been shows.
      expect(await sourcesIn(name)).toEqual(
        before.map((row) => (rewritten.includes(row.id) ? { ...row, source_connector: 'gmail' } : row)),
      );
    });
  });
});
