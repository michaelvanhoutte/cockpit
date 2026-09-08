import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { SqlStorage } from '@cloudflare/workers-types';
import { accountChanges } from '../../../src/accounts/changes.js';
import { inStoreAsItIs, startFromEmpty, storeNamed } from '../seed.js';

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
    table: 'layouts',
    sql: `INSERT INTO layouts (id, tenant_id, dashboard_id, screen_width, created_at)
          VALUES ('ly-before', ?, 'db-before', 1280, ?)`,
    params: (name) => [name, AT],
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
    table: 'items',
    sql: `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, unseen, created_at, updated_at)
          VALUES ('it-before', ?, 'ws-before', 'internal', 'Captured before the update', 'task', 0, ?, ?)`,
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
    // Nothing writes a screen size yet, so this row is here for the reason the
    // file exists rather than for the reason the feature does: whatever update
    // comes after `0017-screen-sizes` should meet a table with something in it.
    table: 'screen_sizes',
    sql: `INSERT INTO screen_sizes (id, tenant_id, name, folded_name, width, created_at)
          VALUES ('sz-before', ?, 'Before', 'before', 1280, ?)`,
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
];

/** What a table's columns are called, in the order the store holds them. */
function columnsOf(sql: SqlStorage, table: string): string[] {
  return sql
    .exec<{ name: string }>(`PRAGMA table_info(${table})`)
    .toArray()
    .map((column) => column.name);
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
      const write =
        row.once && columnsOf(sql, row.table).includes(row.once.column) ? row.once : row;
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

const points = updates
  .map((_, applied) => ({ applied, position: applied + 1, total: updates.length }))
  .filter(({ applied }) => applied > 0);

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
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

      // Opening the store is what applies it, as the first request of the day
      // does for a real account.
      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

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

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

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

      expect(await storeNamed(name).workspaces(name)).toMatchObject({ status: 'ok' });

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
