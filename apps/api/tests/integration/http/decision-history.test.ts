import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { TASK_TYPE_ID, WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`), for the reason
 * `panel-items.test.ts` beside this file is: a filing is a real write, and
 * whether it appends a decision-history row is a fact about the store, not
 * about a pure function - `decisionHistoryEntryFor`
 * (apps/api/src/domain/decision-history.ts) does no branching of its own to
 * unit-test in isolation, it only copies fields `command-service.ts` already
 * has to hand ("Learn where notes belong from where you actually file them",
 * issue 299).
 *
 * What a routing proposal reads *back* from this table is the AI layer's own
 * concern, proved in note-cleanup.test.ts against the system prompt it
 * produces - this file is only about what gets written and when.
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-09-09T10:00:00.000Z';

async function send(command: string, body: Record<string, unknown>) {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...body }),
  });
}

async function aDashboard(): Promise<string> {
  const dashboardId = nextId();
  expect(
    (
      await send('add_dashboard', {
        workspaceId: WORKSPACE_ID,
        dashboardId,
        panelId: nextId(),
        name: `Today ${seq}`,
      })
    ).status,
  ).toBe(200);
  return dashboardId;
}

async function aPanel(dashboardId: string, name: string): Promise<string> {
  const panelId = nextId();
  expect(
    (await send('add_panel', { workspaceId: WORKSPACE_ID, dashboardId, panelId, name })).status,
  ).toBe(200);
  return panelId;
}

/** An item captured with a note, so it has a `capturedMessage` to carry into history. */
async function anItem(message: string): Promise<string> {
  const itemId = nextId();
  expect(
    (
      await send('capture_item', {
        workspaceId: WORKSPACE_ID,
        itemId,
        message,
        typeId: TASK_TYPE_ID,
      })
    ).status,
  ).toBe(200);
  return itemId;
}

/**
 * An item with no captured note at all - the shape a connector-sourced Item
 * has, never having been typed in. There is no command in this product that
 * creates one directly, so this captures one and clears the column by hand.
 */
async function anUncapturedItem(): Promise<string> {
  const itemId = await anItem('placeholder');
  await inTheStore((sql) => sql.exec('UPDATE items SET captured_message = NULL WHERE id = ?', itemId));
  return itemId;
}

function move(itemId: string, panelId: string | null, order: string[] = panelId ? [itemId] : []) {
  return send('move_item_to_panel', { workspaceId: WORKSPACE_ID, itemId, panelId, order });
}

/**
 * Puts a live proposal on an Item directly, by row - `propose_item_panel` is
 * Cockpit's own to send (`note-cleanup.test.ts`, "the reading is Cockpit's to
 * do, and cannot be asked for from outside"), so there is no address a test
 * can post it to either. What is under test here is what a *filing* does with
 * whatever proposal an Item already carries, not how it got there - the same
 * reasoning `alsoFileOn` in `panel-items.test.ts` gives for writing a filing
 * by row rather than through `add_item_to_panel`.
 */
async function propose(itemId: string, panelId: string, reason: string): Promise<void> {
  await inTheStore((sql) =>
    sql.exec(
      'UPDATE items SET proposed_panel_id = ?, proposed_panel_reason = ? WHERE id = ?',
      panelId,
      reason,
      itemId,
    ),
  );
}

async function historyFor(itemId: string) {
  return inTheStore((sql) =>
    sql
      .exec<{
        item_id: string;
        proposed_panel_id: string | null;
        proposed_panel_reason: string | null;
        chosen_panel_id: string;
        decided_at: string;
      }>(
        'SELECT item_id, proposed_panel_id, proposed_panel_reason, chosen_panel_id, decided_at FROM decision_history WHERE item_id = ?',
        itemId,
      )
      .toArray(),
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Triage', () => {
  describe('filing an item onto a panel appends one decision-history entry', () => {
    it('records no proposal and the panel actually chosen, when nothing was proposed', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const itemId = await anItem('Reply to Bart');

      expect((await move(itemId, falcon)).status).toBe(200);

      const rows = await historyFor(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        proposed_panel_id: null,
        proposed_panel_reason: null,
        chosen_panel_id: falcon,
      });
    });

    it('records the same panel as proposed and chosen, when the proposal was accepted', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const itemId = await anItem('Reply to Bart');
      await propose(itemId, falcon, 'sounds like Falcon');

      expect((await move(itemId, falcon)).status).toBe(200);

      const rows = await historyFor(itemId);
      expect(rows[0]).toMatchObject({
        proposed_panel_id: falcon,
        proposed_panel_reason: 'sounds like Falcon',
        chosen_panel_id: falcon,
      });
    });

    it('records both the wrong and the right panel, when the proposal was overridden', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const anna = await aPanel(today, 'Anna');
      const itemId = await anItem('Reply to Bart');
      await propose(itemId, falcon, 'sounds like Falcon');

      expect((await move(itemId, anna)).status).toBe(200);

      const rows = await historyFor(itemId);
      expect(rows[0]).toMatchObject({
        proposed_panel_id: falcon,
        proposed_panel_reason: 'sounds like Falcon',
        chosen_panel_id: anna,
      });
    });

    it('records a filing even for an item with no captured note', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const itemId = await anUncapturedItem();

      expect((await move(itemId, falcon)).status).toBe(200);

      expect(await historyFor(itemId)).toHaveLength(1);
    });

    it('appends nothing when the item is moved to the Inbox instead of a panel', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const itemId = await anItem('Reply to Bart');
      await move(itemId, falcon);

      expect((await move(itemId, null)).status).toBe(200);

      // The one entry from the first, real filing - and nothing added for the
      // move back to the Inbox, which settles nothing.
      expect(await historyFor(itemId)).toHaveLength(1);
    });

    it('appends nothing when an already-filed item is moved to a different panel, and never misattributes the first filing’s proposal to it', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const anna = await aPanel(today, 'Anna');
      const itemId = await anItem('Reply to Bart');
      await propose(itemId, falcon, 'sounds like Falcon');
      await move(itemId, falcon);

      // A later reorganization - not a fresh routing decision, and the
      // proposal on the item is still whatever the first filing read, so
      // recording it here would misattribute it to a decision it was never
      // shown for.
      expect((await move(itemId, anna)).status).toBe(200);

      const rows = await historyFor(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ chosen_panel_id: falcon });
    });

    it('appends nothing when a reorganizing move is undone, matching the rule that undo never writes here', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const anna = await aPanel(today, 'Anna');
      const itemId = await anItem('Reply to Bart');
      await move(itemId, falcon);
      await move(itemId, anna);

      // Undo of the reorganization, restoring the earlier panel - not the
      // Inbox, so this is the case the plain "moved to the Inbox" rule above
      // does not itself cover.
      expect((await move(itemId, falcon)).status).toBe(200);

      expect(await historyFor(itemId)).toHaveLength(1);
    });

    /**
     * Deleting a Panel tombstones it without touching the `panel_items` rows
     * that pointed at it, which is what puts the Item back in the Inbox
     * (`isItemFiled` in repo.ts). Filing it onto a new Panel afterwards is
     * therefore a genuine first-ever, visible filing, not a reorganizing
     * move of one still filed somewhere - and has to be told apart from
     * that case correctly, or the entry is lost for good.
     */
    it('appends an entry when an item is re-filed after its only panel was deleted', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const anna = await aPanel(today, 'Anna');
      const itemId = await anItem('Reply to Bart');
      await move(itemId, falcon);
      expect((await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: falcon })).status).toBe(200);

      expect((await move(itemId, anna)).status).toBe(200);

      // Two entries, not one: the original Falcon filing was a genuine first
      // filing too, and stands - deleting its Panel afterwards does not
      // erase that it happened. The Anna filing is a second, equally
      // genuine first-ever-*visible* filing, not a reorganization of the
      // first.
      const rows = await historyFor(itemId);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.chosen_panel_id).sort()).toEqual([anna, falcon].sort());
    });

    it('appends nothing for add_item_to_panel, which puts an item on a second panel without saying it primarily belongs there', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const anna = await aPanel(today, 'Anna');
      const itemId = await anItem('Reply to Bart');
      await move(itemId, falcon);

      expect(
        (
          await send('add_item_to_panel', {
            workspaceId: WORKSPACE_ID,
            itemId,
            panelId: anna,
            order: [itemId],
          })
        ).status,
      ).toBe(200);

      expect(await historyFor(itemId)).toHaveLength(1);
    });

    /**
     * The ordinary path onto `add_item_to_panel` is already-filed, but
     * nothing refuses one aimed straight at an Inbox item - and landing on a
     * Panel for the first time is a routing settling whichever of the two
     * commands does it (schema.ts, "written by whichever... gets there
     * first").
     */
    it('appends an entry for add_item_to_panel too, when it is the item’s first-ever filing', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const itemId = await anItem('Reply to Bart');

      expect(
        (
          await send('add_item_to_panel', {
            workspaceId: WORKSPACE_ID,
            itemId,
            panelId: falcon,
            order: [itemId],
          })
        ).status,
      ).toBe(200);

      const rows = await historyFor(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ chosen_panel_id: falcon });
    });

    it('writes one entry, not two, when the same filing command is replayed', async () => {
      const today = await aDashboard();
      const falcon = await aPanel(today, 'Falcon');
      const itemId = await anItem('Reply to Bart');
      const body = {
        commandId: nextId(),
        issuedAt: AT,
        workspaceId: WORKSPACE_ID,
        itemId,
        panelId: falcon,
        order: [itemId],
      };
      const once = () =>
        asUser('http://cockpit.test/v1/commands/move_item_to_panel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      await once();
      await once();

      expect(await historyFor(itemId)).toHaveLength(1);
    });
  });
});
