import { describe, expect, it } from 'vitest';
import { MAX_ROW_HEIGHT, MIN_ROW_HEIGHT } from '@cockpit/shared';
import type { Layout, LayoutCell, LayoutRow, Panel } from '@cockpit/shared';
import {
  dividerMoved,
  drawnRows,
  freeName,
  layoutLabel,
  layoutToDraw,
  movedBeside,
  movedBy,
  movedToOwnRow,
  nameForScreen,
  sharesOf,
  withRowHeight,
} from '../../../src/panels/arrangement';

/**
 * F1: which layout a dashboard is drawn with, and where its panels end up, are
 * decisions over a list and a number. That the result then really fits the
 * screen without scrolling sideways is a claim about layout that no arithmetic
 * can make, and it is proved in the browser by tests/e2e/panels.test.ts.
 */

function aLayout(
  id: string,
  screenWidth: number,
  rows: LayoutRow[] = [],
  name = id,
): Layout {
  return { id, tenantId: 'tenant', dashboardId: 'today', name, screenWidth, rows };
}

function cell(panelId: string, span: number): LayoutCell {
  return { panelId, span };
}

function aRow(cells: LayoutCell[], height: number | null = null): LayoutRow {
  return { height, cells };
}

/** An arrangement as the panels on each line, which is what most of these are about. */
function idsOf(rows: readonly LayoutRow[]): string[][] {
  return rows.map((row) => row.cells.map((one) => one.panelId));
}

function aPanel(id: string): Panel {
  return { id, tenantId: 'tenant', dashboardId: 'today', name: id, kind: 'items' as const, format: 'plain' as const, body: '', readOnly: false };
}

describe('Layouts', () => {
  describe('a dashboard is drawn with the layout nearest the screen it is on, unless you picked one and the nearest has not changed since', () => {
    const phone = aLayout('phone', 480);
    const laptop = aLayout('laptop', 1280);
    const wide = aLayout('wide', 2560);

    /** Picking `layoutId` on a screen the nearest layout is `whileNearestIs`. */
    const picked = (layoutId: string, whileNearestIs: string) => ({ layoutId, whileNearestIs });

    it.each([
      { situation: 'a phone', screenWidth: 480, pick: null, drawn: 'phone' },
      { situation: 'a laptop', screenWidth: 1440, pick: null, drawn: 'laptop' },
      { situation: 'a 4K screen', screenWidth: 2400, pick: null, drawn: 'wide' },
      // Nothing was made at this width, and the nearest is what it gets rather
      // than nothing at all.
      { situation: 'a tablet nothing was made for', screenWidth: 900, pick: null, drawn: 'laptop' },
      {
        situation: 'a layout picked by hand, on the screen it was picked on',
        screenWidth: 480,
        pick: picked('wide', 'phone'),
        drawn: 'wide',
      },
      // The window moved and the screen did not: a pick scoped to a width would
      // be thrown away here, and there is nothing about resizing a window that
      // means "put me back on the other layout".
      {
        situation: 'a window resized without the nearest layout changing',
        screenWidth: 560,
        pick: picked('wide', 'phone'),
        drawn: 'wide',
      },
      // The screen really did change, which is the whole feature: the pick was
      // made on the phone and this is the laptop, so the laptop's own layout is
      // what the dashboard goes back to.
      {
        situation: 'moving to a screen with a layout of its own',
        screenWidth: 1280,
        pick: picked('wide', 'phone'),
        drawn: 'laptop',
      },
      // Pressing the layout the screen was already going to draw is still a
      // pick, and it still expires: this is the 4K screen picked on the 4K
      // screen, read back from the laptop.
      {
        situation: 'a pick of the layout that was nearest anyway, read on another screen',
        screenWidth: 1280,
        pick: picked('wide', 'wide'),
        drawn: 'laptop',
      },
      // A deleted layout arrives by the only route it can: the pick still names
      // it and it is not in the list any more.
      {
        situation: 'a picked layout another device has since deleted',
        screenWidth: 480,
        pick: picked('gone', 'phone'),
        drawn: 'phone',
      },
      // The other half of that, and it expires the pick rather than falling
      // through it: what the pick was overriding is no longer an answer anybody
      // can give.
      {
        situation: 'a picked layout whose overridden answer has been deleted',
        screenWidth: 480,
        pick: picked('wide', 'gone'),
        drawn: 'phone',
      },
    ])('$situation', ({ screenWidth, pick, drawn }) => {
      expect(layoutToDraw([phone, laptop, wide], 'today', screenWidth, pick)?.id).toBe(drawn);
    });

    it('goes to the narrower one when two are equally close, so two screens agree', () => {
      expect(layoutToDraw([phone, laptop], 'today', 880, null)?.id).toBe('phone');
    });

    it('draws another dashboard’s layouts with nothing of this one', () => {
      const elsewhere = { ...aLayout('elsewhere', 1280), dashboardId: 'research' };

      expect(layoutToDraw([elsewhere], 'today', 1280, null)).toBeNull();
    });

    it('draws a dashboard that has no layouts at all with none', () => {
      expect(layoutToDraw([], 'today', 1280, null)).toBeNull();
    });
  });

  describe('a row’s panels divide it in proportion to their spans', () => {
    it.each([
      { situation: 'two equal cells', spans: [6, 6], shares: [0.5, 0.5] },
      { situation: 'one twice the other', spans: [8, 4], shares: [2 / 3, 1 / 3] },
      // Spans are proportions, so what they add up to is not a rule: these two
      // divide the row exactly as 6 and 6 do.
      { situation: 'spans that add up to nothing in particular', spans: [1, 1], shares: [0.5, 0.5] },
      { situation: 'a row of one, whatever its span', spans: [4], shares: [1] },
      { situation: 'three unequal', spans: [6, 3, 3], shares: [0.5, 0.25, 0.25] },
      // A stored arrangement should be drawn, not throw: dividing by nothing is
      // the one way this arithmetic could fail.
      { situation: 'spans stored as nonsense', spans: [0, 0], shares: [0.5, 0.5] },
    ])('$situation', ({ spans, shares }) => {
      expect(sharesOf(aRow(spans.map((span, at) => cell(`p${at}`, span))))).toEqual(shares);
    });
  });

  describe('a row is as tall as it was set to, and as tall as what is in it until it is set', () => {
    const two = [aRow([cell('a', 12), cell('b', 12)]), aRow([cell('c', 12)])];

    it.each([
      { situation: 'a height a screen can draw', asked: 300, kept: 300 },
      { situation: 'taller than any screen should show', asked: 5000, kept: MAX_ROW_HEIGHT },
      { situation: 'shorter than a list can be read in', asked: 20, kept: MIN_ROW_HEIGHT },
      { situation: 'exactly the tallest allowed', asked: MAX_ROW_HEIGHT, kept: MAX_ROW_HEIGHT },
      { situation: 'exactly the shortest allowed', asked: MIN_ROW_HEIGHT, kept: MIN_ROW_HEIGHT },
      // The pointer lands between two pixels; what is kept is a whole one.
      { situation: 'a height between two pixels', asked: 300.4, kept: 300 },
    ])('$situation', ({ asked, kept }) => {
      expect(withRowHeight(two, 0, asked)[0]!.height).toBe(kept);
    });

    it('puts a row back to being as tall as what is in it', () => {
      const sized = withRowHeight(two, 0, 400);
      expect(withRowHeight(sized, 0, null)[0]!.height).toBeNull();
    });

    it('leaves every other row exactly as tall as it was', () => {
      const sized = withRowHeight(withRowHeight(two, 1, 400), 0, 200);
      expect(sized.map((row) => row.height)).toEqual([200, 400]);
    });

    it('leaves the panels of the row it sizes, and their order, alone', () => {
      expect(idsOf(withRowHeight(two, 0, 400))).toEqual(idsOf(two));
    });
  });

  describe('moving the line between two panels moves whole columns from one to the other', () => {
    /** What each panel of the row ends up holding, as twelfths. */
    const spansOf = (rows: readonly LayoutRow[]) => rows[0]!.cells.map((one) => one.span);
    const rowOf = (...spans: number[]) => [aRow(spans.map((span, at) => cell(`p${at}`, span)))];

    it.each([
      // A row nobody has dragged is the default span per cell, which is the
      // same proportions as an even share of twelve.
      { situation: 'two even panels, one column to the right', row: [12, 12], at: 0, columns: 1, spans: [7, 5] },
      { situation: 'two even panels, one column to the left', row: [12, 12], at: 0, columns: -1, spans: [5, 7] },
      { situation: 'three even panels, the first line moved', row: [12, 12, 12], at: 0, columns: 1, spans: [5, 3, 4] },
      { situation: 'three even panels, the second line moved', row: [12, 12, 12], at: 1, columns: 2, spans: [4, 6, 2] },
      { situation: 'a row already uneven', row: [8, 4], at: 0, columns: 1, spans: [9, 3] },
      // Neither neighbour is squeezed out: a panel stops at a twelfth.
      { situation: 'dragged far past its neighbour', row: [12, 12], at: 0, columns: 40, spans: [11, 1] },
      { situation: 'dragged far the other way', row: [12, 12], at: 0, columns: -40, spans: [1, 11] },
      // Only a converted arrangement is wider than the gestures allow, and it
      // is still drawn rather than rewritten.
      { situation: 'a row of six from an arrangement that wrapped', row: [5, 5, 5, 5, 5, 5], at: 0, columns: 1, spans: [3, 1, 2, 2, 2, 2] },
    ])('$situation', ({ row, at, columns, spans }) => {
      expect(spansOf(dividerMoved(rowOf(...row), 0, at, columns))).toEqual(spans);
    });

    it('leaves the row adding up to a whole, so the panels beside the pair keep their share', () => {
      const moved = dividerMoved(rowOf(12, 12, 12), 0, 0, 1);
      const spans = moved[0]!.cells.map((one) => one.span);
      expect(spans.reduce((sum, span) => sum + span, 0)).toBe(12);
      expect(spans[2]).toBe(4);
    });

    it.each([
      { situation: 'moved no column at all', row: [12, 12], at: 0, columns: 0 },
      { situation: 'a panel alone on its row', row: [12], at: 0, columns: 1 },
      { situation: 'a line beyond the last panel', row: [12, 12], at: 1, columns: 1 },
      { situation: 'a line before the first', row: [12, 12], at: -1, columns: 1 },
    ])('changes nothing when $situation', ({ row, at, columns }) => {
      const before = rowOf(...row);
      expect(dividerMoved(before, 0, at, columns)).toEqual(before);
    });

    it('leaves how tall the row is, and every other row, alone', () => {
      const rows = [aRow([cell('a', 12), cell('b', 12)], 300), aRow([cell('c', 12)], 200)];
      const moved = dividerMoved(rows, 0, 0, 1);
      expect(moved.map((row) => row.height)).toEqual([300, 200]);
      expect(idsOf(moved)).toEqual(idsOf(rows));
    });
  });

  describe('the dashboard draws every panel it has, and only the panels it has', () => {
    it('draws the layout’s own rows when they hold every panel', () => {
      const layout = aLayout('laptop', 1280, [
        aRow([cell('falcon', 8), cell('anna', 4)], 300),
        aRow([cell('reading', 12)]),
      ]);

      expect(drawnRows(layout, [aPanel('falcon'), aPanel('anna'), aPanel('reading')], 1280)).toEqual([
        { height: 300, cells: [cell('falcon', 8), cell('anna', 4)] },
        { height: null, cells: [cell('reading', 12)] },
      ]);
    });

    it('gives a panel the layout has never heard of a row of its own', () => {
      // A panel added in another tab, against a layout saved before it existed.
      // Dropping it would hide something a person made; putting it beside
      // something would be a decision nobody took.
      const layout = aLayout('phone', 480, [aRow([cell('a', 12)])]);

      expect(drawnRows(layout, [aPanel('a'), aPanel('new')], 480)).toEqual([
        { height: null, cells: [cell('a', 12)] },
        { height: null, cells: [cell('new', 12)] },
      ]);
    });

    it('leaves out a panel the layout still names but nothing has any more', () => {
      const layout = aLayout('laptop', 1280, [aRow([cell('a', 6), cell('gone', 6)])]);

      expect(drawnRows(layout, [aPanel('a')], 1280)).toEqual([
        { height: null, cells: [cell('a', 6)] },
      ]);
    });

    it('drops a row whose last panel is gone, rather than drawing a blank line', () => {
      const layout = aLayout('laptop', 1280, [
        aRow([cell('a', 12)]),
        aRow([cell('gone', 12)], 300),
        aRow([cell('b', 12)]),
      ]);

      expect(drawnRows(layout, [aPanel('a'), aPanel('b')], 1280)).toEqual([
        { height: null, cells: [cell('a', 12)] },
        { height: null, cells: [cell('b', 12)] },
      ]);
    });

    it.each([
      {
        situation: 'a laptop, three across',
        screenWidth: 1280,
        panels: ['a', 'b', 'c', 'd'],
        rows: [['a', 'b', 'c'], ['d']],
      },
      { situation: 'a phone, one across', screenWidth: 480, panels: ['a', 'b'], rows: [['a'], ['b']] },
      { situation: 'a dashboard with nothing on it', screenWidth: 1280, panels: [], rows: [] },
    ])('arranges a dashboard with no layout for the screen it is on: $situation', ({
      screenWidth,
      panels,
      rows,
    }) => {
      // The one place the old wrapping rule survives, and it belongs there:
      // before anybody has arranged a dashboard, how many fit at a size worth
      // reading is the only answer available.
      expect(drawnRows(null, panels.map(aPanel), screenWidth)).toEqual(
        rows.map((row) => ({ height: null, cells: row.map((id) => cell(id, 12)) })),
      );
    });
  });

  describe('a panel dropped beside another joins that one’s row', () => {
    const two = [aRow([cell('a', 6), cell('b', 6)]), aRow([cell('c', 12)])];

    it.each([
      { situation: 'before it', side: 'before' as const, order: [['c', 'a', 'b']] },
      { situation: 'after it', side: 'after' as const, order: [['a', 'c', 'b']] },
    ])('dropped $situation, and the row it left goes with it', ({ side, order }) => {
      expect(idsOf(movedBeside(two, 'c', 'a', side))).toEqual(order);
    });

    it('shares the row it joins out evenly, so nothing has to explain the proportions', () => {
      const uneven = [aRow([cell('a', 9), cell('b', 3)]), aRow([cell('c', 12)])];

      expect(movedBeside(uneven, 'c', 'a', 'after')[0]!.cells).toEqual([
        cell('a', 12),
        cell('c', 12),
        cell('b', 12),
      ]);
    });

    it('keeps the proportions when the move is along the row it was already on', () => {
      // Evening out is what a row does when *who is on it* changes. A reorder
      // changes nothing about that, so flattening a row somebody set to 9 and 3
      // would throw their proportions away from a gesture that only swapped two
      // panels over.
      const uneven = [aRow([cell('a', 9), cell('b', 3)])];

      expect(movedBeside(uneven, 'b', 'a', 'before')[0]!.cells).toEqual([
        cell('b', 3),
        cell('a', 9),
      ]);
    });

    it('keeps the row it left when something else is still on it', () => {
      const three = [aRow([cell('a', 6), cell('b', 6)]), aRow([cell('c', 6), cell('d', 6)])];

      expect(idsOf(movedBeside(three, 'c', 'a', 'before'))).toEqual([['c', 'a', 'b'], ['d']]);
    });

    it.each([
      { situation: 'onto itself', panelId: 'a', beside: 'a' },
      { situation: 'onto one that is not there', panelId: 'a', beside: 'nobody' },
      { situation: 'a panel that is not there', panelId: 'nobody', beside: 'a' },
    ])('leaves everything where it was when dropped $situation', ({ panelId, beside }) => {
      expect(movedBeside(two, panelId, beside, 'after')).toEqual(two);
    });

    it('refuses a fifth panel on a row, and says so by changing nothing', () => {
      // Four across is where a panel stops being a box you read. It is the
      // gestures that hold that line, not the store.
      const full = [
        aRow([cell('a', 3), cell('b', 3), cell('c', 3), cell('d', 3)]),
        aRow([cell('e', 12)]),
      ];

      expect(movedBeside(full, 'e', 'a', 'after')).toEqual(full);
    });

    it('lets a panel move within a row that is already full', () => {
      // The row is full, but nothing is joining it: this is a reorder, and
      // refusing it would make a full row one you cannot rearrange.
      const full = [aRow([cell('a', 3), cell('b', 3), cell('c', 3), cell('d', 3)])];

      expect(idsOf(movedBeside(full, 'd', 'a', 'before'))).toEqual([['d', 'a', 'b', 'c']]);
    });
  });

  describe('a panel dropped in the gap between two rows gets a row of its own', () => {
    const three = [aRow([cell('a', 12)]), aRow([cell('b', 12)]), aRow([cell('c', 12)])];

    it.each([
      { situation: 'above everything', at: 0, order: [['c'], ['a'], ['b']] },
      { situation: 'between the first two', at: 1, order: [['a'], ['c'], ['b']] },
      { situation: 'below everything', at: 3, order: [['a'], ['b'], ['c']] },
    ])('dropped $situation', ({ at, order }) => {
      expect(idsOf(movedToOwnRow(three, 'c', at))).toEqual(order);
    });

    it('lands where the pointer is when the panel is dragged down past its own row', () => {
      // Taking the panel out drops the row it was alone on, which moves every
      // gap below it up one. Without allowing for that, a panel dragged down
      // lands one row short of where it was let go - and a drop target is
      // exactly where that would go unnoticed.
      expect(idsOf(movedToOwnRow(three, 'a', 2))).toEqual([['b'], ['a'], ['c']]);
    });

    it('takes a panel out of a shared row onto a line of its own', () => {
      const shared = [aRow([cell('a', 6), cell('b', 6)]), aRow([cell('c', 12)])];

      expect(idsOf(movedToOwnRow(shared, 'b', 2))).toEqual([['a'], ['c'], ['b']]);
    });

    it('changes nothing when it already has that line to itself', () => {
      expect(movedToOwnRow(three, 'b', 1)).toEqual(three);
    });
  });

  describe('moving from the panel’s own menu is the move a drag makes, without a pointer', () => {
    it.each([
      {
        situation: 'left along its row',
        rows: [[['a', 'b']], [['c']]],
        panelId: 'b',
        places: -1,
        order: [['b', 'a'], ['c']],
      },
      {
        situation: 'right along its row',
        rows: [[['a', 'b']], [['c']]],
        panelId: 'a',
        places: 1,
        order: [['b', 'a'], ['c']],
      },
      {
        situation: 'left off the front of its row, onto a line above',
        rows: [[['a', 'b']]],
        panelId: 'a',
        places: -1,
        order: [['a'], ['b']],
      },
      {
        situation: 'right off the end of its row, onto a line below',
        rows: [[['a', 'b']]],
        panelId: 'b',
        places: 1,
        order: [['a'], ['b']],
      },
      {
        situation: 'up, from a row it already has to itself',
        rows: [[['a']], [['b']]],
        panelId: 'b',
        places: -1,
        order: [['b'], ['a']],
      },
      {
        situation: 'down, from a row it already has to itself',
        rows: [[['a']], [['b']]],
        panelId: 'a',
        places: 1,
        order: [['b'], ['a']],
      },
      {
        situation: 'up from the very top, which is nowhere',
        rows: [[['a']], [['b']]],
        panelId: 'a',
        places: -1,
        order: [['a'], ['b']],
      },
      {
        situation: 'down from the very bottom, which is nowhere',
        rows: [[['a']], [['b']]],
        panelId: 'b',
        places: 1,
        order: [['a'], ['b']],
      },
      {
        situation: 'a panel that is not there',
        rows: [[['a']]],
        panelId: 'nobody',
        places: 1,
        order: [['a']],
      },
    ])('$situation', ({ rows, panelId, places, order }) => {
      const arrangement = rows.map(([ids]) => aRow(ids!.map((id) => cell(id, 12))));

      expect(idsOf(movedBy(arrangement, panelId, places))).toEqual(order);
    });
  });


  describe('a layout is known by its name, and by the width it was made for where it has none', () => {
    it.each([
      { situation: 'a layout somebody named', name: 'Wide', screenWidth: 1440, label: 'Wide' },
      // What old code writes for the seconds of a deploy that both versions
      // serve: the row is real, and the app draws it as every layout was drawn
      // before names existed.
      { situation: 'a layout written before names existed', name: '', screenWidth: 1440, label: '1440 px' },
      { situation: 'a name that is only spaces', name: '   ', screenWidth: 480, label: '480 px' },
      // Not an empty name but no name at all, which is what a copy stored
      // before names existed holds: nothing parses what comes back out of
      // IndexedDB, so the field is absent and the type that says otherwise is
      // describing the parsed answer instead.
      {
        situation: 'a layout in a copy stored before names existed',
        name: undefined,
        screenWidth: 1440,
        label: '1440 px',
      },
    ])('$situation', ({ name, screenWidth, label }) => {
      expect(layoutLabel({ ...aLayout('l', screenWidth), name } as Layout)).toBe(label);
    });
  });

  describe('a layout made without being named is named for the size of screen it was made on', () => {
    it.each([
      { situation: 'a phone', screenWidth: 390, named: 'Phone' },
      { situation: 'a small tablet', screenWidth: 700, named: 'Tablet' },
      { situation: 'a laptop', screenWidth: 1100, named: 'Laptop' },
      { situation: 'a 4K screen', screenWidth: 2560, named: 'Wide' },
    ])('$situation', ({ screenWidth, named }) => {
      expect(nameForScreen(screenWidth)).toBe(named);
    });
  });

  describe('a name generated rather than typed is made free before it is sent', () => {
    // The server refuses a name this dashboard already holds, and a drag is the
    // worst place to learn that.
    it.each([
      { situation: 'nothing is called that yet', taken: [] as Layout[], wanted: 'Wide', free: 'Wide' },
      {
        situation: 'one already is',
        taken: [aLayout('a', 2560, [], 'Wide')],
        wanted: 'Wide',
        free: 'Wide 2',
      },
      {
        situation: 'the numbered one is taken too',
        taken: [aLayout('a', 2560, [], 'Wide'), aLayout('b', 2400, [], 'Wide 2')],
        wanted: 'Wide',
        free: 'Wide 3',
      },
      {
        situation: 'the name is taken in another capitalization',
        taken: [aLayout('a', 2560, [], 'WIDE')],
        wanted: 'Wide',
        free: 'Wide 2',
      },
      // A layout old code left unnamed is drawn as its width, so that is the
      // name it is really holding on this dashboard.
      {
        situation: 'an unnamed layout is drawn under the name being asked for',
        taken: [aLayout('a', 1440, [], '')],
        wanted: '1440 px',
        free: '1440 px 2',
      },
    ])('$situation', ({ taken, wanted, free }) => {
      expect(freeName(taken, wanted)).toBe(free);
    });
  });

});
