import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { SWATCHES } from '@cockpit/shared/board';
import { DASHBOARD_ID, WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker: "Brainstorming: Panels can't be
 * told apart at a glance" (issue 1832). A Panel's colour is a column of its
 * row, so that it is kept, cleared and read back with the Panel only holds
 * against a real store. How it is drawn is F1
 * (apps/web/tests/unit/components/PanelBoard.test.tsx).
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-11-21T10:00:00.000Z';

async function send(command: string, body: Record<string, unknown>) {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: AT, workspaceId: WORKSPACE_ID, ...body }),
  });
}

async function aPanel(name: string, kind: 'items' | 'text' | 'filter' = 'items'): Promise<string> {
  const panelId = nextId();
  expect((await send('add_panel', { dashboardId: DASHBOARD_ID, panelId, name, kind })).status).toBe(200);
  return panelId;
}

const colourOf = (panelId: string) =>
  inTheStore((sql) => sql.exec<{ colour: string | null }>('SELECT colour FROM panels WHERE id = ?', panelId).one().colour);

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Panels', () => {
  describe('a colour is one of the eight or none, and is stored on the Panel it was set on', () => {
    it('is kept on the Panel, whatever it holds, and read back with it', async () => {
      const holding = await aPanel('Falcon');
      const text = await aPanel('Notes', 'text');
      const filter = await aPanel('Due soon', 'filter');
      const other = await aPanel('Untouched');

      for (const panelId of [holding, text, filter]) {
        expect((await send('set_panel_colour', { panelId, colour: 'teal' })).status).toBe(200);
        expect(await colourOf(panelId)).toBe('teal');
      }

      const read = (await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`)).json()) as WorkspaceSnapshot;
      expect(read.panels.find((panel) => panel.id === holding)?.colour).toBe('teal');
      expect(read.panels.find((panel) => panel.id === other)?.colour).toBeNull();
      expect(await colourOf(other)).toBeNull();
    });

    it('takes each of the eight swatches, and None clears it', async () => {
      const panelId = await aPanel('Falcon');

      for (const colour of SWATCHES) {
        expect((await send('set_panel_colour', { panelId, colour })).status).toBe(200);
        expect(await colourOf(panelId)).toBe(colour);
      }
      expect((await send('set_panel_colour', { panelId, colour: null })).status).toBe(200);

      expect(await colourOf(panelId)).toBeNull();
    });

    it.each([
      { situation: 'a name that is not a swatch', colour: 'chartreuse' },
      { situation: 'a swatch in other capitals', colour: 'Teal' },
      { situation: 'an empty name', colour: '' },
    ])('refuses $situation and keeps the colour it had', async ({ colour }) => {
      const panelId = await aPanel('Falcon');
      expect((await send('set_panel_colour', { panelId, colour: 'rose' })).status).toBe(200);

      expect((await send('set_panel_colour', { panelId, colour })).status).toBe(400);

      expect(await colourOf(panelId)).toBe('rose');
    });

    it('a Panel whose colour this version has no swatch for is drawn with no colour, and the Workspace still opens', async () => {
      const panelId = await aPanel('Falcon');
      await inTheStore((sql) => sql.exec('UPDATE panels SET colour = ? WHERE id = ?', 'chartreuse', panelId));

      const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);

      expect(res.status).toBe(200);
      const read = (await res.json()) as WorkspaceSnapshot;
      expect(read.panels.find((panel) => panel.id === panelId)?.colour).toBeNull();
    });

    it('refuses an Item, which has no colour, and writes no colour anywhere', async () => {
      const itemId = nextId();
      expect((await send('capture_item', { itemId, message: 'Call the plumber' })).status).toBe(200);
      const own = await aPanel('Falcon');

      const refused = await send('set_panel_colour', { panelId: itemId, colour: 'rose' });

      expect(refused.status).toBe(404);
      const stored = await inTheStore((sql) => ({
        coloured: sql.exec('SELECT id FROM panels WHERE colour IS NOT NULL').toArray(),
        itemColumns: sql.exec<{ name: string }>('SELECT name FROM pragma_table_info(\'items\')').toArray().map((row) => row.name),
      }));
      expect(stored.coloured).toEqual([]);
      expect(stored.itemColumns).not.toContain('colour');
      // What the screen reads has no colour on an Item either.
      const read = (await (await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`)).json()) as WorkspaceSnapshot;
      expect(read.items.find((item) => item.id === itemId)).not.toHaveProperty('colour');
      expect(await colourOf(own)).toBeNull();
    });
  });
});
