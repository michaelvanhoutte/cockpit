import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, abortAllDurableObjects, applyD1Migrations, env } from 'cloudflare:test';
import type { SqlStorage } from '@cloudflare/workers-types';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { accountChanges } from '../../../src/accounts/changes.js';
import {
  GETTING_STARTED_PANEL_NAME,
  GETTING_STARTED_TASKS,
  INBOX_TASK,
} from '../../../src/accounts/getting-started-data.js';
import {
  ACCOUNT_NAME,
  GUIDE_TITLES,
  WORKSPACE_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  startFromEmpty,
  taskTypeIn,
} from '../seed.js';

/**
 * Integration level throughout, because what an account arrives with is rows a
 * real store was brought up to date with, and each way of being skipped is a
 * different arm of one guard over those rows. Entered the way a person enters:
 * signed in, the first read is what brings the account up to date.
 *
 * An account somebody has used is arranged by bringing its store up to the
 * point just before Getting started existed and writing what that use left
 * behind - nothing a request could reach, since the first request already
 * brings the account the rest of the way.
 *
 * Deleting *Getting started* is not asked: it is the delete every Panel takes.
 * Nor is a failure part way: every change commits with its record in one
 * transaction (tests/integration/accounts/store.test.ts).
 */

const SECRET = 'test-operator-secret';
const AT = '2026-09-20T10:00:00.000Z';
const FIRST_PANEL_ID = '01920000-0000-7000-8000-000000000001';

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

/** The account's first Workspace as the app reads it, which is what opening it does first. */
async function snapshot(): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

/** Opens the account the way a person does, and answers the Workspaces it offers. */
async function openTheAccount(): Promise<{ id: string }[]> {
  const res = await asUser('http://cockpit.test/v1/workspaces');
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { workspaces: { id: string }[] }).workspaces;
}

/** What of Getting started the account holds: its Panels so named, and its Tasks by title. */
async function guideHeld(): Promise<{ panels: number; tasks: number }> {
  return inStoreAsItIs(ACCOUNT_NAME, (sql) => {
    const panels = sql
      .exec<{ n: number }>('SELECT count(*) AS n FROM panels WHERE name = ?', GETTING_STARTED_PANEL_NAME)
      .one().n;
    const titles = sql.exec<{ title: string }>('SELECT title FROM items').toArray();
    return { panels, tasks: titles.filter((row) => GUIDE_TITLES.has(row.title)).length };
  });
}

/**
 * The store as it stood before Getting started existed - every change before
 * `before` applied and recorded, exactly as the store records them - with what
 * somebody's use of it left behind written over it.
 */
async function usedBefore(
  arrange: (sql: SqlStorage) => void,
  before = '0056-getting-started',
): Promise<void> {
  const changes = accountChanges(ACCOUNT_NAME);
  const upTo = changes.findIndex((change) => change.name === before);
  expect(upTo, `no change called ${before}`).toBeGreaterThan(0);
  await inStoreAsItIs(ACCOUNT_NAME, (sql) => {
    sql.exec(
      `CREATE TABLE IF NOT EXISTS account_changes (
         name text PRIMARY KEY NOT NULL,
         applied_at text NOT NULL
       ) STRICT`,
    );
    for (const change of changes.slice(0, upTo)) {
      for (const statement of change.statements) sql.exec(statement.sql, ...(statement.params ?? []));
      sql.exec('INSERT INTO account_changes (name, applied_at) VALUES (?, ?)', change.name, AT);
    }
    arrange(sql);
  });
}

function send(command: string, body: Record<string, unknown>): Promise<Response> {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Issued now, as the app issues one: a change dated before the Item was
    // last written is an older version of it, and is not applied.
    body: JSON.stringify({
      commandId: nextId(),
      issuedAt: new Date().toISOString(),
      workspaceId: WORKSPACE_ID,
      ...body,
    }),
  });
}

function asOperator(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`http://cockpit.test${path}`, {
    ...init,
    headers: { ...((init.headers as Record<string, string>) ?? {}), authorization: `Bearer ${SECRET}` },
  });
}

/** The panel called Getting started, which the account's first Dashboard has to hold. */
function gettingStartedIn(snap: WorkspaceSnapshot) {
  const panel = snap.panels.find((one) => one.name === GETTING_STARTED_PANEL_NAME);
  expect(panel, 'the account arrived with no Getting started').toBeDefined();
  return panel!;
}

/** The Items no Panel holds, which is what the Inbox shows. */
function inboxOf(snap: WorkspaceSnapshot) {
  const filed = new Set(snap.filings.map((filing) => filing.itemId));
  return snap.items.filter((item) => !filed.has(item.id));
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Onboarding', () => {
  describe('an account nobody has used arrives with Getting started before Panel 1, and one Task in its Inbox', () => {
    it('holds the steps on Getting started in order, and nothing on Panel 1', async () => {
      const snap = await snapshot();
      const guide = gettingStartedIn(snap);

      expect(snap.dashboards.map((one) => one.name)).toEqual(['Dashboard 1']);
      expect(snap.panels.map((one) => [one.name, one.dashboardId])).toEqual([
        [GETTING_STARTED_PANEL_NAME, snap.dashboards[0]!.id],
        ['Panel 1', snap.dashboards[0]!.id],
      ]);
      const onIt = snap.filings
        .filter((filing) => filing.panelId === guide.id)
        .sort((one, other) => one.position - other.position)
        .map((filing) => snap.items.find((item) => item.id === filing.itemId)?.title);
      expect(onIt).toEqual(GETTING_STARTED_TASKS.map((task) => task.title));
      expect(snap.filings.filter((filing) => filing.panelId === FIRST_PANEL_ID)).toEqual([]);
    });

    it('holds exactly one Task in the Inbox, saying what the Inbox is', async () => {
      expect(inboxOf(await snapshot()).map((item) => item.title)).toEqual([INBOX_TASK.title]);
    });

    it('makes every one an open Task, described as written, with nothing proposed for it', async () => {
      const snap = await snapshot();
      const written = [...GETTING_STARTED_TASKS, INBOX_TASK];

      expect(
        snap.items
          .map((item) => ({
            title: item.title,
            description: item.description,
            type: item.typeId,
            done: item.completedAt,
            captured: item.capturedMessage,
            proposed: [item.textsProposedAt, item.readings, item.proposedPanelId],
          }))
          .sort((one, other) => one.title.localeCompare(other.title)),
      ).toEqual(
        written
          .map((task) => ({
            title: task.title,
            description: task.description,
            type: taskTypeIn(ACCOUNT_NAME),
            done: null,
            captured: null,
            proposed: [null, null, null],
          }))
          .sort((one, other) => one.title.localeCompare(other.title)),
      );
    });
  });

  /**
   * Each row is one way somebody's use shows in the rows, written alone so that
   * it is the only thing standing between the account and the guide - and the
   * first row, the same store with nothing written over it, is what says the
   * arrangement itself stops nothing.
   */
  describe('an account is given Getting started only while nobody has used it', () => {
    const situations: { situation: string; before?: string; arrange: (sql: SqlStorage) => void; given: boolean }[] = [
      { situation: 'one opened before Getting started existed, and never used', arrange: () => {}, given: true },
      {
        situation: 'its workspace renamed',
        arrange: (sql) => sql.exec("UPDATE workspaces SET name = 'Work', folded_name = 'work'"),
        given: false,
      },
      {
        situation: 'its dashboard renamed',
        arrange: (sql) => sql.exec("UPDATE dashboards SET name = 'Today', folded_name = 'today'"),
        given: false,
      },
      {
        situation: 'its panel renamed',
        arrange: (sql) => sql.exec("UPDATE panels SET name = 'Reading list', folded_name = 'reading list'"),
        given: false,
      },
      {
        situation: 'an item captured and since dismissed',
        arrange: (sql) =>
          sql.exec(
            `INSERT INTO items (id, tenant_id, workspace_id, source, title, status, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, 'internal', 'Ring the plumber', 'to_process', ?, ?, ?)`,
            nextId(),
            ACCOUNT_NAME,
            WORKSPACE_ID,
            AT,
            AT,
            AT,
          ),
        given: false,
      },
      {
        situation: 'an action recorded but no item, such as a panel renamed back to Panel 1',
        arrange: (sql) =>
          sql.exec(
            `INSERT INTO commands (command_id, tenant_id, workspace_id, name, payload, issued_at, received_at)
             VALUES (?, ?, ?, 'rename_panel', ?, ?, ?)`,
            nextId(),
            ACCOUNT_NAME,
            WORKSPACE_ID,
            JSON.stringify({ panelId: FIRST_PANEL_ID, name: 'Panel 1' }),
            AT,
            AT,
          ),
        given: false,
      },
      {
        // Without the Dashboard it would arrive with, so that the second
        // Workspace alone is what stands in the way.
        situation: 'a second workspace made',
        arrange: (sql) =>
          sql.exec(
            `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, position, created_at)
             VALUES ('ws-2', ?, 'Personal', 'personal', '#c06a45', 1, ?)`,
            ACCOUNT_NAME,
            AT,
          ),
        given: false,
      },
      {
        situation: 'a second dashboard added',
        arrange: (sql) =>
          sql.exec(
            `INSERT INTO dashboards (id, tenant_id, workspace_id, name, folded_name, created_at)
             VALUES ('ws-1-dashboard-2', ?, ?, 'Dashboard 2', 'dashboard 2', ?)`,
            ACCOUNT_NAME,
            WORKSPACE_ID,
            AT,
          ),
        given: false,
      },
      {
        situation: 'a second panel added',
        arrange: (sql) =>
          sql.exec(
            `INSERT INTO panels (id, tenant_id, dashboard_id, name, folded_name, created_at)
             VALUES (?, ?, 'ws-1-dashboard-1', 'Reading list', 'reading list', ?)`,
            nextId(),
            ACCOUNT_NAME,
            AT,
          ),
        given: false,
      },
      {
        situation: 'every workspace deleted',
        arrange: (sql) => sql.exec('UPDATE workspaces SET deleted_at = ?', AT),
        given: false,
      },
      {
        // Given Work, Atlas Copco and Personal by the change that came before
        // the first workspace, so that one never ran its own.
        situation: 'the three old starting workspaces',
        before: '0015-first-workspace',
        arrange: (sql) =>
          sql.exec(
            `INSERT INTO workspaces (id, tenant_id, name, folded_name, color, created_at)
             VALUES ('ws-work', ?, 'Work', 'work', '#6f62b5', ?),
                    ('ws-atlas', ?, 'Atlas Copco', 'atlas copco', '#3a72c8', ?),
                    ('ws-personal', ?, 'Personal', 'personal', '#c06a45', ?)`,
            ACCOUNT_NAME,
            AT,
            ACCOUNT_NAME,
            AT,
            ACCOUNT_NAME,
            AT,
          ),
        given: false,
      },
    ];

    it.each(situations)('$situation', async ({ arrange, before, given }) => {
      await usedBefore(arrange, before);

      await openTheAccount();

      expect(await guideHeld()).toEqual(
        given ? { panels: 1, tasks: GUIDE_TITLES.size } : { panels: 0, tasks: 0 },
      );
    });

    it('leaves an account with every workspace deleted offered the screen that makes one', async () => {
      await usedBefore((sql) => sql.exec('UPDATE workspaces SET deleted_at = ?', AT));

      expect(await openTheAccount()).toEqual([]);
    });

    it('gives the shared guest account none, and its demonstration as before', async () => {
      const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
      const cookie = back.headers
        .getSetCookie()
        .map((one) => one.split(';')[0]!)
        .find((one) => one.startsWith('cockpit_session='))!;
      const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`, {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      const starter = (await res.json()) as WorkspaceSnapshot;

      expect(starter.panels.map((one) => one.name)).toEqual(['Panel 1']);
      const held = await inStoreAsItIs('tenant-guest', (sql) =>
        sql.exec<{ title: string }>('SELECT title FROM items').toArray(),
      );
      expect(held.length).toBeGreaterThan(0);
      expect(held.filter((row) => GUIDE_TITLES.has(row.title))).toEqual([]);
    });
  });

  describe('Getting started arrives once', () => {
    it('is still one when the account is opened again', async () => {
      await openTheAccount();
      // Forgotten in memory, so the next request asks the store again what it
      // has been brought up to date with.
      await abortAllDurableObjects();

      await openTheAccount();

      expect(await guideHeld()).toEqual({ panels: 1, tasks: GUIDE_TITLES.size });
    });

    it('is still one when an untouched account is restored from its backup', async () => {
      await openTheAccount();
      const taken = await asOperator(`/v1/operator/backup/accounts/${ACCOUNT_NAME}`);
      expect(taken.status).toBe(200);

      const restored = await asOperator(`/v1/operator/restore/accounts/${ACCOUNT_NAME}?force=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: await taken.text(),
      });
      expect(restored.status, await restored.clone().text()).toBe(200);
      await openTheAccount();

      expect(await guideHeld()).toEqual({ panels: 1, tasks: GUIDE_TITLES.size });
    });
  });

  describe('Getting started and its Tasks change like anything else', () => {
    it('takes a new name, a step ticked off, and the Inbox Task filed onto Panel 1', async () => {
      const before = await snapshot();
      const guide = gettingStartedIn(before);
      const firstStep = before.items.find((item) => item.title === GETTING_STARTED_TASKS[0]!.title)!;
      const [inboxTask] = inboxOf(before);

      const answers = [
        await send('rename_panel', { panelId: guide.id, name: 'Start here' }),
        await send('set_done', { itemId: firstStep.id, done: true }),
        await send('move_item_to_panel', { itemId: inboxTask!.id, panelId: FIRST_PANEL_ID, order: [inboxTask!.id] }),
      ];

      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
      const after = await snapshot();
      expect(after.panels.find((one) => one.id === guide.id)?.name).toBe('Start here');
      expect(after.items.find((item) => item.id === firstStep.id)?.completedAt).toEqual(expect.any(String));
      expect(
        after.filings.filter((filing) => filing.panelId === FIRST_PANEL_ID).map((filing) => filing.itemId),
      ).toEqual([inboxTask!.id]);
    });
  });
});
