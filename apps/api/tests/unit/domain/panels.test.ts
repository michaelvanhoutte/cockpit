import { describe, expect, it } from 'vitest';
import { DEFAULT_CELL_SPAN } from '@cockpit/shared';
import type { Panel, SaveLayoutCommand } from '@cockpit/shared';
import {
  appendedPlacement,
  arrangementRows,
  firstPanelFor,
  panelFromCommand,
  panelNameForMove,
  panelsNotOn,
} from '../../../src/domain/panels.js';

/**
 * L1: where a new panel lands in a layout, which panels an arrangement names
 * that are not there, and what an arrangement's rows become are all decisions
 * over a list. That the rows are then really written, and really refused when a
 * stranger is named, is proved against a real store in
 * tests/integration/http/panels.test.ts.
 */

const AT = '2026-09-01T10:00:00.000Z';

function row(rowIndex: number, height: number | null = null) {
  return { tenantId: 'tenant', layoutId: 'wide', rowIndex, height };
}

function aPanel(id: string): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: 'today',
    name: id,
    kind: 'items',
    format: 'plain',
    body: '',
    readOnly: false,
  };
}

describe('Panels', () => {
  describe('a dashboard arrives with a panel, so there is somewhere to file into', () => {
    it('takes the dashboard’s account and moment, and the id it was given', () => {
      // The id is the command's rather than derived from the dashboard's, which
      // is the one thing this does not copy from `firstDashboardFor`: five
      // commands take a panelId as a uuid, so a derived one would leave the
      // panel unable to be renamed, deleted or filed into.
      expect(firstPanelFor({ id: 'today', tenantId: 'tenant', createdAt: AT }, 'p-1')).toEqual({
        id: 'p-1',
        tenantId: 'tenant',
        dashboardId: 'today',
        name: 'Panel 1',
        foldedName: 'panel 1',
        kind: 'items',
        format: 'plain',
        body: '',
        readOnly: false,
        createdAt: AT,
        deletedAt: null,
      });
    });
  });

  describe('a panel moved to a dashboard that already has one going by its name keeps a name of its own', () => {
    function named(id: string, name: string): Panel {
      return { ...aPanel(id), name };
    }

    it('lands unchanged where nothing there is already called that', () => {
      expect(panelNameForMove([named('other', 'To read')], 'Reading list')).toBe('Reading list');
    });

    it('takes the first free number where the plain name is taken', () => {
      expect(panelNameForMove([named('other', 'Reading list')], 'Reading list')).toBe(
        'Reading list (2)',
      );
    });

    it('climbs past every number already there rather than colliding with one', () => {
      expect(
        panelNameForMove(
          [named('a', 'Reading list'), named('b', 'Reading list (2)')],
          'Reading list',
        ),
      ).toBe('Reading list (3)');
    });

    it('is not thrown off by a gap in the numbers already there', () => {
      // The next free number past every one taken, not the first gap in them -
      // renumbering into a hole a person left on purpose would be its own
      // surprise.
      expect(
        panelNameForMove(
          [named('a', 'Reading list'), named('b', 'Reading list (3)')],
          'Reading list',
        ),
      ).toBe('Reading list (2)');
    });

    it('folds case the same way every other name comparison does', () => {
      expect(panelNameForMove([named('other', 'READING LIST')], 'Reading list')).toBe(
        'Reading list (2)',
      );
    });

    it('climbs the same sequence rather than piling a second suffix onto one it already carries', () => {
      // A panel already called `Reading list (2)` - its own suffix from an
      // earlier move - colliding again must not become `Reading list (2) (2)`.
      expect(
        panelNameForMove(
          [named('a', 'Reading list'), named('b', 'Reading list (2)')],
          'Reading list (2)',
        ),
      ).toBe('Reading list (3)');
    });

    it('keeps every character of a title that merely ends in a parenthesised number', () => {
      // `Sprint (2026)` is a real title, not this function's own earlier
      // suffix - stripping it unconditionally would collide again with the
      // number torn off, landing on `Sprint (2)` and losing the year outright.
      // Trusted as a suffix only where the name under it is itself already on
      // the target (found in review).
      expect(panelNameForMove([named('other', 'Sprint (2026)')], 'Sprint (2026)')).toBe(
        'Sprint (2026) (2)',
      );
    });

    it('reserves room for the suffix rather than growing past the cap every other panel name obeys', () => {
      // Nothing upstream validates this name's length the way `add_panel`/
      // `rename_panel` do, since the mover never types it (found in review).
      const atTheCap = 'x'.repeat(60);
      const result = panelNameForMove([named('other', atTheCap)], atTheCap);
      expect(result.length).toBeLessThanOrEqual(60);
      expect(result).toBe(`${'x'.repeat(54)} (2)`);
    });
  });

  describe('a panel holds either the items filed into it or the text written in it', () => {
    /**
     * The kind is written once, from the command, and nothing updates it - so
     * this is the whole of "decided when it is made and never after". What each
     * kind then draws is the screen's, and the scope the decision is applied in
     * is proved against a real store in tests/integration/http/panels.test.ts.
     */
    it.each([
      { situation: 'a panel of items', kind: 'items' as const },
      { situation: 'a panel of text', kind: 'text' as const },
    ])('$situation is made holding what it was asked to hold', ({ kind }) => {
      const made = panelFromCommand(
        {
          commandId: 'c-1',
          issuedAt: AT,
          workspaceId: 'ws-1',
          dashboardId: 'today',
          panelId: 'p-2',
          name: 'What matters',
          kind,
        },
        'tenant',
      );

      expect(made).toMatchObject({ kind, body: '' });
    });

    /**
     * Read-only is what a panel of text settles into, and the panel just made
     * is the one that arrives open: an empty box refusing to be written in, one
     * menu away from the gesture that made it, is nonsense.
     */
    it('arrives open to be written in, whichever it holds', () => {
      for (const kind of ['items', 'text'] as const) {
        expect(
          panelFromCommand(
            {
              commandId: 'c-1',
              issuedAt: AT,
              workspaceId: 'ws-1',
              dashboardId: 'today',
              panelId: 'p-3',
              name: 'What matters',
              kind,
            },
            'tenant',
          ).readOnly,
        ).toBe(false);
      }
    });
  });
});

describe('Layouts', () => {
  describe('a panel added later joins a layout in a row of its own, under everything there', () => {
    it('puts it on a line by itself rather than beside whatever was last', () => {
      // A row is a decision about what belongs side by side, and adding a panel
      // says nothing about which panels it belongs beside. Full width also
      // keeps a phone layout a phone layout without copying anything: one
      // across is what a row of one is.
      const appended = appendedPlacement('tenant', 'wide', 'new', [row(0), row(1)]);

      expect(appended).toEqual({
        row: { tenantId: 'tenant', layoutId: 'wide', rowIndex: 2, height: null },
        placement: {
          tenantId: 'tenant',
          layoutId: 'wide',
          panelId: 'new',
          rowIndex: 2,
          position: 0,
          span: DEFAULT_CELL_SPAN,
        },
      });
    });

    it('goes after the last row, not after the count, when the indexes have gaps', () => {
      // An arrangement is written whole, so its indexes are contiguous - but a
      // layout read back while one is being changed need not be, and counting
      // would put the newcomer at an index a row already holds.
      const appended = appendedPlacement('tenant', 'wide', 'new', [row(0), row(3), row(4)]);

      expect(appended.row.rowIndex).toBe(5);
    });

    it('starts the first row of a layout that has none', () => {
      const appended = appendedPlacement('tenant', 'wide', 'new', []);

      expect(appended.row.rowIndex).toBe(0);
      expect(appended.placement.rowIndex).toBe(0);
    });
  });

  describe('an arrangement is stored as the rows it was given, in the order it gave them', () => {
    it('writes down which row each panel is in and where along it', () => {
      // Two orders, because there are two: which row, and where across it.
      const { rows, placements } = arrangementRows('tenant', 'wide', [
        { height: 300, cells: [{ panelId: 'falcon', span: 8 }, { panelId: 'anna', span: 4 }] },
        { height: null, cells: [{ panelId: 'reading', span: 12 }] },
      ]);

      expect(rows).toEqual([
        { tenantId: 'tenant', layoutId: 'wide', rowIndex: 0, height: 300 },
        { tenantId: 'tenant', layoutId: 'wide', rowIndex: 1, height: null },
      ]);
      expect(placements).toEqual([
        { tenantId: 'tenant', layoutId: 'wide', panelId: 'falcon', rowIndex: 0, position: 0, span: 8 },
        { tenantId: 'tenant', layoutId: 'wide', panelId: 'anna', rowIndex: 0, position: 1, span: 4 },
        { tenantId: 'tenant', layoutId: 'wide', panelId: 'reading', rowIndex: 1, position: 0, span: 12 },
      ]);
    });

    it('stores nothing for an arrangement with no rows, which is a dashboard with nothing on it', () => {
      expect(arrangementRows('tenant', 'wide', [])).toEqual({ rows: [], placements: [] });
    });
  });

  describe('an arrangement names only panels that are on the dashboard it arranges', () => {
    it.each([
      { situation: 'every panel is one of the dashboard’s', named: [['falcon'], ['reading']], strangers: [] },
      { situation: 'one belongs to another dashboard', named: [['falcon', 'elsewhere']], strangers: ['elsewhere'] },
      { situation: 'one was deleted a moment ago', named: [['gone']], strangers: ['gone'] },
      { situation: 'the dashboard is arranged empty', named: [], strangers: [] },
      // Across rows rather than within one: a stranger is a stranger wherever
      // in the arrangement it was put.
      { situation: 'one sits alone on a later row', named: [['falcon'], ['nobody']], strangers: ['nobody'] },
    ])('$situation', ({ named, strangers }) => {
      const command = {
        commandId: 'c',
        issuedAt: AT,
        workspaceId: 'ws-work',
        dashboardId: 'today',
        layoutId: 'wide',
        screenWidth: 1280,
        rows: named.map((panelIds) => ({
          height: null,
          cells: panelIds.map((panelId) => ({ panelId, span: 12 / panelIds.length })),
        })),
      } as SaveLayoutCommand;

      expect(panelsNotOn([aPanel('falcon'), aPanel('reading')], command)).toEqual(strangers);
    });
  });
});
