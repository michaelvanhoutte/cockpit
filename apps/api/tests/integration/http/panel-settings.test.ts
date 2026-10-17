import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { Panel, WorkspaceSnapshot } from '@cockpit/shared';
import {
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`), because every rule
 * below is about what the store does with one command: a name's uniqueness is
 * the store's index, and "all or nothing" only holds against a real
 * transaction ("Change a Panel's name and settings in one Panel settings
 * form", issue 1206).
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-09-01T10:00:00.000Z';

async function send(command: string, body: Record<string, unknown>) {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, ...body }),
  });
}

/** A dashboard of the seeded workspace with the panel it arrives with taken back off. */
async function aDashboard(): Promise<string> {
  const dashboardId = nextId();
  const panelId = nextId();
  expect(
    (await send('add_dashboard', { workspaceId: WORKSPACE_ID, dashboardId, panelId, name: `Today ${seq}` }))
      .status,
  ).toBe(200);
  expect((await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId })).status).toBe(200);
  return dashboardId;
}

async function aPanel(dashboardId: string, name: string, kind?: string): Promise<string> {
  const panelId = nextId();
  const made = await send('add_panel', {
    workspaceId: WORKSPACE_ID,
    dashboardId,
    panelId,
    name,
    ...(kind ? { kind } : {}),
  });
  expect(made.status).toBe(200);
  return panelId;
}

async function snapshot(): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

async function panelNow(panelId: string): Promise<Panel> {
  const found = (await snapshot()).panels.find((panel) => panel.id === panelId);
  expect(found).toBeDefined();
  return found!;
}

function settings(panelId: string, changes: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return send('set_panel_settings', { workspaceId: WORKSPACE_ID, panelId, ...changes, ...extra });
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Panels', () => {
  describe('a save writes everything it changed, or nothing', () => {
    it('lands a rename and Never propose together', async () => {
      const panelId = await aPanel(await aDashboard(), 'Next up');

      expect((await settings(panelId, { name: 'Soon', neverPropose: true })).status).toBe(200);

      expect(await panelNow(panelId)).toMatchObject({ name: 'Soon', neverPropose: true });
    });

    it('frees the name it had and holds the new one, in the index that guards names', async () => {
      const dashboardId = await aDashboard();
      const panelId = await aPanel(dashboardId, 'Next up');
      expect((await settings(panelId, { name: 'Soon' })).status).toBe(200);

      const dashboard = (id: string, name: string) =>
        send('add_panel', { workspaceId: WORKSPACE_ID, dashboardId, panelId: id, name });

      expect((await dashboard(nextId(), 'NEXT UP')).status).toBe(200);
      expect((await dashboard(nextId(), 'soon')).status).toBe(409);
    });

    it('refuses a name another live panel of the dashboard holds, in other capitals, and writes the rest of the save nowhere', async () => {
      const dashboardId = await aDashboard();
      await aPanel(dashboardId, 'To read');
      const panelId = await aPanel(dashboardId, 'Next up');

      const refused = await settings(panelId, { name: 'TO READ', neverPropose: true });

      expect(refused.status).toBe(409);
      expect(await panelNow(panelId)).toMatchObject({ name: 'Next up', neverPropose: false });
    });

    it('lands read-only and formatting on a panel of text together', async () => {
      const panelId = await aPanel(await aDashboard(), 'What matters', 'text');

      expect((await settings(panelId, { readOnly: true, format: 'rich' })).status).toBe(200);

      expect(await panelNow(panelId)).toMatchObject({ readOnly: true, format: 'rich' });
    });

    it('lands a name a deleted panel held', async () => {
      const dashboardId = await aDashboard();
      const gone = await aPanel(dashboardId, 'To read');
      const panelId = await aPanel(dashboardId, 'Next up');
      expect((await send('delete_panel', { workspaceId: WORKSPACE_ID, panelId: gone })).status).toBe(200);

      expect((await settings(panelId, { name: 'To read' })).status).toBe(200);

      expect((await panelNow(panelId)).name).toBe('To read');
    });

    it('keeps a panel’s own name in other capitals', async () => {
      const panelId = await aPanel(await aDashboard(), 'Project Falcon');

      expect((await settings(panelId, { name: 'PROJECT FALCON' })).status).toBe(200);

      expect((await panelNow(panelId)).name).toBe('PROJECT FALCON');
    });
  });

  describe('a save carries only what the form changed, so another tab’s change to the rest stays', () => {
    it('leaves a rename made elsewhere when this save only unticks suggestions', async () => {
      const panelId = await aPanel(await aDashboard(), 'Next up');
      // The other tab, after this form opened.
      expect((await send('rename_panel', { workspaceId: WORKSPACE_ID, panelId, name: 'Soon' })).status).toBe(200);

      expect((await settings(panelId, { neverPropose: true })).status).toBe(200);

      expect(await panelNow(panelId)).toMatchObject({ name: 'Soon', neverPropose: true });
    });

    it('leaves Never propose set elsewhere when this save only renames', async () => {
      const panelId = await aPanel(await aDashboard(), 'Next up');
      expect((await send('set_panel_never_propose', { workspaceId: WORKSPACE_ID, panelId, neverPropose: true })).status).toBe(200);

      expect((await settings(panelId, { name: 'Soon' })).status).toBe(200);

      expect(await panelNow(panelId)).toMatchObject({ name: 'Soon', neverPropose: true });
    });
  });

  describe('a setting that does not apply to the panel’s kind is refused, and nothing is written', () => {
    it.each([
      { situation: 'Never propose on a filter', kind: 'filter', changes: { name: 'Renamed', neverPropose: true } },
      { situation: 'read-only on a panel of items', kind: undefined, changes: { name: 'Renamed', readOnly: true } },
      { situation: 'formatting on a panel of items', kind: undefined, changes: { name: 'Renamed', format: 'rich' } },
      { situation: 'Never propose on a panel of text', kind: 'text', changes: { name: 'Renamed', neverPropose: true } },
    ])('$situation', async ({ kind, changes }) => {
      const panelId = await aPanel(await aDashboard(), 'Original', kind);
      const before = await panelNow(panelId);

      expect((await settings(panelId, changes)).status).toBe(400);

      expect(await panelNow(panelId)).toEqual(before);
    });
  });

  describe('a save with nothing in it is not a command', () => {
    it('is refused by the schema', async () => {
      const panelId = await aPanel(await aDashboard(), 'Next up');

      expect((await settings(panelId, {})).status).toBe(400);
    });
  });

  describe('the same save sent twice changes nothing more', () => {
    it('is one change and one row in the command log', async () => {
      const panelId = await aPanel(await aDashboard(), 'Next up');
      const commandId = nextId();
      const ask = () => settings(panelId, { name: 'Soon', neverPropose: true }, { commandId });

      expect(await (await ask()).json()).toEqual({ ok: true, applied: true });
      expect(await (await ask()).json()).toEqual({ ok: true, applied: false });

      const logged = await inTheStore(
        (sql) => sql.exec('SELECT COUNT(*) AS n FROM commands WHERE command_id = ?', commandId).one().n,
      );
      expect(logged).toBe(1);
      expect(await panelNow(panelId)).toMatchObject({ name: 'Soon', neverPropose: true });
    });
  });

  describe('a save never reaches another workspace’s panel', () => {
    it('is not found, and changes nothing', async () => {
      await alsoWorkspaces();
      const panelId = await aPanel(await aDashboard(), 'Next up');

      const refused = await send('set_panel_settings', {
        workspaceId: 'ws-atlas',
        panelId,
        name: 'Hijacked',
        neverPropose: true,
      });

      expect(refused.status).toBe(404);
      expect(await panelNow(panelId)).toMatchObject({ name: 'Next up', neverPropose: false });
    });
  });
});
