import { describe, expect, it } from 'vitest';
import { DEFAULT_PANEL_SIZE } from '@cockpit/shared';
import type { Panel, SaveLayoutCommand } from '@cockpit/shared';
import {
  PLACEMENTS_PER_INSERT,
  appendedPlacement,
  panelsNotOn,
  placementBatches,
  placementRows,
} from '../../../src/domain/panels.js';

/**
 * L1: where a new panel lands in a layout, which panels an arrangement names
 * that are not there, and what an arrangement's order becomes are all decisions
 * over a list. That the layouts are then really written, and really refused
 * when a stranger is named, is proved against a real store in
 * tests/integration/http/panels.test.ts.
 */

const AT = '2026-09-01T10:00:00.000Z';

function placement(panelId: string, columns: number, rows: number, position: number) {
  return { tenantId: 'tenant', layoutId: 'wide', panelId, position, columnSpan: columns, rowSpan: rows };
}

function aPanel(id: string): Panel {
  return { id, tenantId: 'tenant', dashboardId: 'today', name: id };
}

describe('Panels', () => {
  describe('a panel added later joins a layout last, at the size of what is already there', () => {
    it('copies the size of the panel already last, so a phone layout stays a phone layout', () => {
      // A phone layout's panels are the full twelve columns. A newcomer handed
      // the default third of the grid would be a sliver on the one screen this
      // layout exists to fit - and on the screen nobody was looking at when
      // they added it.
      const appended = appendedPlacement('tenant', 'wide', 'new', [
        placement('reading', 12, 3, 0),
        placement('falcon', 12, 5, 1),
      ]);

      expect(appended).toEqual({
        tenantId: 'tenant',
        layoutId: 'wide',
        panelId: 'new',
        position: 2,
        columnSpan: 12,
        rowSpan: 5,
      });
    });

    it('goes after the last place, not after the count, once a panel has been deleted', () => {
      // Deleting a panel takes its placement without renumbering the ones left,
      // so three rows can hold positions 0, 3 and 4. Counting them would put
      // the newcomer at 3, beside a panel already there rather than after them
      // all - and the rows are ordered by position, so it would be drawn in the
      // middle of a dashboard it was appended to.
      const appended = appendedPlacement('tenant', 'wide', 'new', [
        placement('a', 4, 3, 0),
        placement('d', 4, 3, 3),
        placement('e', 4, 3, 4),
      ]);

      expect(appended.position).toBe(5);
    });

    it('falls back to the ordinary size when the layout holds nothing to copy', () => {
      const appended = appendedPlacement('tenant', 'wide', 'new', []);

      expect(appended).toMatchObject({
        position: 0,
        columnSpan: DEFAULT_PANEL_SIZE.columns,
        rowSpan: DEFAULT_PANEL_SIZE.rows,
      });
    });
  });

  describe('the order an arrangement is given in is the order it is stored in', () => {
    it('writes each panel’s place down, because nothing else carries it', () => {
      const rows = placementRows('tenant', 'wide', [
        { panelId: 'falcon', columns: 4, rows: 3 },
        { panelId: 'reading', columns: 8, rows: 2 },
      ]);

      expect(rows).toEqual([
        { tenantId: 'tenant', layoutId: 'wide', panelId: 'falcon', position: 0, columnSpan: 4, rowSpan: 3 },
        { tenantId: 'tenant', layoutId: 'wide', panelId: 'reading', position: 1, columnSpan: 8, rowSpan: 2 },
      ]);
    });
  });

  describe('an arrangement of any size is stored whole, in the order it was given', () => {
    it.each([
      { situation: 'a dashboard arranged empty', panels: 0 },
      { situation: 'a handful of panels', panels: 3 },
      { situation: 'exactly as many as one write holds', panels: PLACEMENTS_PER_INSERT },
      { situation: 'one more than one write holds', panels: PLACEMENTS_PER_INSERT + 1 },
      { situation: 'a dashboard nobody should build, at forty panels', panels: 40 },
    ])('$situation', ({ panels }) => {
      const rows = placementRows(
        'tenant',
        'wide',
        Array.from({ length: panels }, (_, n) => ({ panelId: `panel-${n}`, columns: 4, rows: 3 })),
      );

      const written = placementBatches(rows);

      // Every panel exactly once, still in its place: what comes back out is
      // what went in, whether that took one write or three.
      expect(written.flat()).toEqual(rows);
      for (const batch of written) expect(batch.length).toBeLessThanOrEqual(PLACEMENTS_PER_INSERT);
      expect(written.some((batch) => batch.length === 0)).toBe(false);
    });
  });

  describe('an arrangement names only panels that are on the dashboard it arranges', () => {
    it.each([
      { situation: 'every panel is one of the dashboard’s', named: ['falcon', 'reading'], strangers: [] },
      { situation: 'one belongs to another dashboard', named: ['falcon', 'elsewhere'], strangers: ['elsewhere'] },
      { situation: 'one was deleted a moment ago', named: ['gone'], strangers: ['gone'] },
      { situation: 'the dashboard is arranged empty', named: [], strangers: [] },
    ])('$situation', ({ named, strangers }) => {
      const command = {
        commandId: 'c',
        issuedAt: AT,
        workspaceId: 'ws-work',
        dashboardId: 'today',
        layoutId: 'wide',
        screenWidth: 1280,
        placements: named.map((panelId) => ({ panelId, columns: 4, rows: 3 })),
      } as SaveLayoutCommand;

      expect(panelsNotOn([aPanel('falcon'), aPanel('reading')], command)).toEqual(strangers);
    });
  });
});
