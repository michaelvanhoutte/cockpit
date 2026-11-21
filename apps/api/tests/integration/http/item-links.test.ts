import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { fixedLineKindId, type Whiteboards } from '@cockpit/shared/board';
import { createAccountDb } from '../../../src/accounts/client.js';
import { linesOfTheBoards, linksOfTheRead } from '../../../src/accounts/links.js';
import { ACCOUNT_NAME, DASHBOARD_ID, WORKSPACE_ID, asUser, seedRegister, startFromEmpty, storeNamed, withoutTheGuide } from '../seed.js';
import { ORIGIN } from './connected-apps.support.js';

/**
 * Integration level, through the real Worker: "Brainstorming: the whiteboard
 * can't show how Items connect" (issue 1831). A link, a line kind and a free
 * line are rows in the account's own store, and what the Workspace's read
 * carries of them is a query over those rows and its Items, so each holds only
 * against a real one. Which links a board draws, and where, is F1
 * (apps/web/tests/unit/whiteboard/links.test.ts); dragging one from a card's
 * dot is the browser walk's (tests/e2e/whiteboard.test.ts).
 */

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await withoutTheGuide();
});

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const NOW = '2026-11-21T10:00:00.000Z';
let tick = 0;
const later = () => new Date(Date.parse(NOW) + ++tick * 1000).toISOString();

async function send(command: string, body: Record<string, unknown>) {
  return asUser(`${ORIGIN}/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: later(), workspaceId: WORKSPACE_ID, ...body }),
  });
}

async function ok(command: string, body: Record<string, unknown>): Promise<{ applied: boolean }> {
  const res = await send(command, body);
  expect(res.status, `${command}: ${await res.clone().text()}`).toBe(200);
  return (await res.json()) as { applied: boolean };
}

type Read = WorkspaceSnapshot & { whiteboards: Whiteboards };
async function snapshot(workspaceId = WORKSPACE_ID): Promise<Read> {
  const res = await asUser(`${ORIGIN}/v1/workspaces/${workspaceId}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as Read;
}

/** An Item filed on a Panel of the Workspace, so it can be placed. */
async function aFiledItem(message: string, workspaceId = WORKSPACE_ID, dashboardId = DASHBOARD_ID): Promise<string> {
  const panelId = nextId();
  await ok('add_panel', { workspaceId, dashboardId, panelId, name: `${message} panel`, kind: 'items' });
  const itemId = nextId();
  await ok('capture_item', { workspaceId, itemId, message });
  await ok('move_item_to_panel', { workspaceId, itemId, panelId, order: [itemId] });
  return itemId;
}

async function aDashboard(name: string): Promise<string> {
  const dashboardId = nextId();
  await ok('add_dashboard', { dashboardId, panelId: nextId(), name });
  return dashboardId;
}

async function aWorkspace(name: string): Promise<{ workspaceId: string; dashboardId: string }> {
  const workspaceId = nextId();
  await ok('create_workspace', { workspaceId, panelId: nextId(), name });
  return { workspaceId, dashboardId: (await snapshot(workspaceId)).dashboards[0]!.id };
}

const LEADS_TO = fixedLineKindId(WORKSPACE_ID, 'leads_to');
const RELATED = fixedLineKindId(WORKSPACE_ID, 'related');

async function link(fromItemId: string, toItemId: string, kindId = LEADS_TO, linkId = nextId()) {
  return { linkId, res: await send('link_items', { linkId, fromItemId, toItemId, kindId }) };
}

async function aKind(name: string): Promise<string> {
  const kindId = nextId();
  await ok('add_line_kind', { kindId, name, style: 'dashed', colour: 'rose', arrow: true });
  return kindId;
}

const linksOf = async () => (await snapshot()).whiteboards.links;

describe('Whiteboard', () => {
  describe('a link joins two Items of one Workspace, and the read carries it once, whichever boards hold their cards', () => {
    it('stores a link from one Item to another, with its kind and no label, apart from any board', async () => {
      const [storm, ferry] = [await aFiledItem('Storm scene'), await aFiledItem('Ferry scene')];
      const plot = await aDashboard('Plot');
      for (const dashboardId of [DASHBOARD_ID, plot]) {
        for (const itemId of [storm, ferry]) await ok('place_card', { cardId: nextId(), dashboardId, itemId, boxId: null, x: 0, y: 0 });
      }
      const { linkId, res } = await link(storm, ferry);
      expect(res.status).toBe(200);
      expect(await linksOf()).toEqual([{ id: linkId, fromItemId: storm, toItemId: ferry, kindId: LEADS_TO, label: null }]);
    });

    it.each([
      { situation: 'an Item of another Workspace', other: 'workspace', status: 404 },
      { situation: 'an Item linked to itself', other: 'itself', status: 400 },
      { situation: 'a dismissed Item', other: 'dismissed', status: 404 },
      { situation: 'a kind the Workspace does not have', other: 'kind', status: 404 },
    ])('refuses $situation and stores nothing', async ({ other, status }) => {
      const storm = await aFiledItem('Storm scene');
      let to = storm;
      let kindId = LEADS_TO;
      if (other === 'workspace') {
        const elsewhere = await aWorkspace('Home');
        to = await aFiledItem('Paint the shed', elsewhere.workspaceId, elsewhere.dashboardId);
      } else if (other === 'dismissed') {
        to = await aFiledItem('Ferry scene');
        await ok('set_dismissed', { itemId: to, dismissed: true });
      } else if (other === 'kind') {
        to = await aFiledItem('Ferry scene');
        kindId = fixedLineKindId(nextId(), 'leads_to');
      }
      expect((await link(storm, to, kindId)).res.status).toBe(status);
      expect(await linksOf()).toEqual([]);
    });

    it.each([
      { situation: 'the same link sent again', again: 'same id' },
      { situation: 'the same two Items linked the same way by another link', again: 'new id' },
    ])('keeps one link for $situation', async ({ again }) => {
      const [storm, ferry] = [await aFiledItem('Storm scene'), await aFiledItem('Ferry scene')];
      const { linkId } = await link(storm, ferry);
      const second = await link(storm, ferry, LEADS_TO, again === 'same id' ? linkId : nextId());
      expect(second.res.status).toBe(200);
      expect(((await second.res.json()) as { applied: boolean }).applied).toBe(false);
      expect((await linksOf()).map((one) => one.id)).toEqual([linkId]);
    });

    it.each([
      { situation: 'the same two Items related the other way round', second: 'reverse' },
      { situation: 'a link of another kind changed to the kind the two are linked by already', second: 'rekind' },
    ])('keeps one link for $situation', async ({ second }) => {
      const [storm, ferry] = [await aFiledItem('Storm scene'), await aFiledItem('Ferry scene')];
      const { linkId } = await link(storm, ferry, RELATED);
      let answer: { applied: boolean };
      if (second === 'reverse') {
        const res = (await link(ferry, storm, RELATED)).res;
        expect(res.status).toBe(200);
        answer = (await res.json()) as { applied: boolean };
      } else {
        const other = (await link(storm, ferry, LEADS_TO)).linkId;
        answer = await ok('set_link_kind', { linkId: other, kindId: RELATED });
      }
      expect(answer.applied).toBe(false);
      expect((await linksOf()).filter((one) => one.kindId === RELATED).map((one) => one.id)).toEqual([linkId]);
    });

    it('leaves the read while an Item at either end is dismissed, and comes back with it', async () => {
      const [storm, ferry] = [await aFiledItem('Storm scene'), await aFiledItem('Ferry scene')];
      const { linkId } = await link(storm, ferry);
      await ok('set_dismissed', { itemId: ferry, dismissed: true });
      expect(await linksOf()).toEqual([]);
      await ok('set_dismissed', { itemId: ferry, dismissed: false });
      expect((await linksOf()).map((one) => one.id)).toEqual([linkId]);
    });

    it('changes its kind and label, and is removed and brought back', async () => {
      const [storm, ferry] = [await aFiledItem('Storm scene'), await aFiledItem('Ferry scene')];
      const { linkId } = await link(storm, ferry);
      await ok('set_link_kind', { linkId, kindId: RELATED });
      await ok('set_link_label', { linkId, label: 'the crossing' });
      expect(await linksOf()).toEqual([{ id: linkId, fromItemId: storm, toItemId: ferry, kindId: RELATED, label: 'the crossing' }]);
      await ok('set_link_label', { linkId, label: '' });
      expect((await linksOf())[0]!.label).toBeNull();
      await ok('unlink_items', { linkId });
      expect(await linksOf()).toEqual([]);
      expect((await ok('unlink_items', { linkId })).applied).toBe(false);
      await ok('restore_link', { linkId });
      expect((await linksOf()).map((one) => one.id)).toEqual([linkId]);
    });
  });

  describe('every Workspace has Leads to and Related, which can’t be changed or deleted; an added kind can be', () => {
    it('lists Leads to and Related in a new Workspace, before anything is linked', async () => {
      const { workspaceId } = await aWorkspace('Home');
      expect((await snapshot(workspaceId)).whiteboards.lineKinds).toEqual([
        { id: fixedLineKindId(workspaceId, 'leads_to'), name: 'Leads to', style: 'solid', colour: 'slate', arrow: true, role: 'leads_to' },
        { id: fixedLineKindId(workspaceId, 'related'), name: 'Related', style: 'solid', colour: 'grey', arrow: false, role: 'related' },
      ]);
    });

    it.each([
      { situation: 'Leads to deleted', command: 'delete_line_kind', kindId: LEADS_TO },
      { situation: 'Related renamed', command: 'edit_line_kind', kindId: RELATED },
    ])('refuses $situation', async ({ command, kindId }) => {
      const res = await send(command, { kindId, name: 'Follows', style: 'solid', colour: 'teal', arrow: false });
      expect(res.status).toBe(400);
      expect((await snapshot()).whiteboards.lineKinds.map((kind) => kind.name)).toEqual(['Leads to', 'Related']);
    });

    it('adds a kind after the two, renames and redraws it, and refuses a name a live kind has', async () => {
      const blocks = await aKind('Blocks');
      expect((await snapshot()).whiteboards.lineKinds.map((kind) => kind.name)).toEqual(['Leads to', 'Related', 'Blocks']);
      await ok('edit_line_kind', { kindId: blocks, name: 'Holds up', style: 'dotted', colour: 'amber', arrow: false });
      expect((await snapshot()).whiteboards.lineKinds[2]).toEqual({ id: blocks, name: 'Holds up', style: 'dotted', colour: 'amber', arrow: false, role: null });
      for (const name of ['leads TO', 'holds up']) {
        expect((await send('add_line_kind', { kindId: nextId(), name, style: 'solid', colour: 'teal', arrow: true })).status).toBe(409);
      }
    });

    it('draws the links of a deleted kind as Related, and gives them back their kind when it is brought back', async () => {
      const [storm, ferry] = [await aFiledItem('Storm scene'), await aFiledItem('Ferry scene')];
      const blocks = await aKind('Blocks');
      await link(storm, ferry, blocks);
      await ok('delete_line_kind', { kindId: blocks });
      const read = await snapshot();
      expect(read.whiteboards.lineKinds.map((kind) => kind.name)).toEqual(['Leads to', 'Related']);
      expect(read.whiteboards.links.map((one) => one.kindId)).toEqual([RELATED]);
      await ok('restore_line_kind', { kindId: blocks });
      expect((await linksOf()).map((one) => one.kindId)).toEqual([blocks]);
    });
  });

  describe('the read finds the links touching its Items through their from and to indexes', () => {
    it.each([
      { situation: 'from', index: /item_links USING INDEX item_links_tenant_from/ },
      { situation: 'to', index: /item_links USING INDEX item_links_tenant_to/ },
    ])('reads links by their $situation end', async ({ index }) => {
      await snapshot();
      const plan = await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => {
        const { sql, params } = linksOfTheRead(createAccountDb(state.storage), ACCOUNT_NAME, WORKSPACE_ID, { finishedAfter: NOW }).toSQL();
        return state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
          .toArray()
          .map((row) => row.detail);
      });
      expect(plan).toContainEqual(expect.stringMatching(index));
    });

    it('reads a board’s free lines through their index', async () => {
      await snapshot();
      const plan = await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => {
        const { sql, params } = linesOfTheBoards(createAccountDb(state.storage), ACCOUNT_NAME, WORKSPACE_ID).toSQL();
        return state.storage.sql
          .exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params)
          .toArray()
          .map((row) => row.detail);
      });
      expect(plan).toContainEqual(expect.stringMatching(/board_lines USING INDEX board_lines_tenant_dashboard/));
    });
  });

  describe('a free line belongs to its Dashboard’s board alone', () => {
    it('is on the board it was drawn on and no other, is labelled, removed and brought back', async () => {
      const plot = await aDashboard('Plot');
      const lineId = nextId();
      await ok('draw_line', { lineId, dashboardId: DASHBOARD_ID, x1: 0, y1: 0, x2: 300, y2: 120, label: '' });
      const on = async (dashboardId: string) => (await snapshot()).whiteboards.lines.filter((line) => line.dashboardId === dashboardId);
      expect(await on(DASHBOARD_ID)).toEqual([{ id: lineId, dashboardId: DASHBOARD_ID, x1: 0, y1: 0, x2: 300, y2: 120, label: '' }]);
      expect(await on(plot)).toEqual([]);
      await ok('set_line_label', { lineId, label: 'Act two' });
      expect((await on(DASHBOARD_ID))[0]!.label).toBe('Act two');
      await ok('delete_line', { lineId });
      expect(await on(DASHBOARD_ID)).toEqual([]);
      await ok('restore_line', { lineId });
      expect((await on(DASHBOARD_ID)).map((line) => line.id)).toEqual([lineId]);
    });

    it('is refused on another Workspace’s board', async () => {
      const elsewhere = await aWorkspace('Home');
      const res = await send('draw_line', { lineId: nextId(), dashboardId: elsewhere.dashboardId, x1: 0, y1: 0, x2: 10, y2: 10, label: '' });
      expect(res.status).toBe(404);
    });
  });
});
