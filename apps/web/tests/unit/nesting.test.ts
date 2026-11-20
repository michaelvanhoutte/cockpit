import { describe, expect, it } from 'vitest';
import type { ChildRow, Filing } from '@cockpit/shared';
import { leavesOfAPick, planDropOntoARow, planPuttingInside, refusesNesting, whereOnARow, type DropOntoARow, type RowDropPlan } from '../../src/nesting';

/**
 * F1: where a drop onto a row lands, and what it leaves ("Drag to nest in
 * Panels and the Inbox", issue 1857). The arithmetic is proved here, from
 * boxes and the held copy: jsdom has no layout, and the pointer itself is the
 * browser walk's.
 */

const [CHAPTER_3, CHAPTER_4, STORM, FERRY, FLASHBACK] = ['i-chapter-3', 'i-chapter-4', 'i-storm', 'i-ferry', 'i-flashback'];
const [SCENES, DRAFTS] = ['p-scenes', 'p-drafts'];

const box = { top: 100, height: 40, left: 0, width: 300 };

describe('Panels', () => {
  describe('where a drop on a row lands', () => {
    it.each([
      { situation: 'the middle of a row', y: 120, where: 'inside' },
      { situation: 'just inside the top quarter', y: 109, where: 'before' },
      { situation: 'the top quarter', y: 103, where: 'before' },
      { situation: 'the bottom quarter', y: 137, where: 'after' },
      { situation: 'just past the middle half', y: 131, where: 'after' },
    ])('is $where for $situation', ({ y, where }) => {
      expect(whereOnARow(box, 150, y)).toBe(where);
    });

    it.each([
      { situation: 'the middle of a card', x: 150, where: 'inside' },
      { situation: 'the left edge of a card', x: 20, where: 'before' },
      { situation: 'the right edge of a card', x: 280, where: 'after' },
    ])('is $where for $situation in columns', ({ x, where }) => {
      expect(whereOnARow(box, x, 120, true)).toBe(where);
    });

    const inside: ChildRow[] = [
      { parentId: STORM, childId: FERRY, position: 0 },
      { parentId: FERRY, childId: FLASHBACK, position: 0 },
    ];
    it.each([
      { situation: 'the dragged Item’s own row', carried: [STORM], target: STORM, refused: true },
      { situation: 'a row inside it', carried: [STORM], target: FERRY, refused: true },
      { situation: 'a row two levels inside it', carried: [STORM], target: FLASHBACK, refused: true },
      { situation: 'a row inside one of the Items of a selection', carried: [CHAPTER_3, STORM], target: FERRY, refused: true },
      { situation: 'a row beside it', carried: [STORM], target: CHAPTER_4, refused: false },
      { situation: 'the row holding it', carried: [FERRY], target: STORM, refused: false },
    ])('offers no drop onto $situation: $refused', ({ carried, target, refused }) => {
      expect(refusesNesting(carried, target, inside)).toBe(refused);
    });
  });

  describe('what a drop onto a row leaves, and whether it asks', () => {
    const filed = (itemId: string, panelId: string): Filing => ({ itemId, panelId, position: 0 }) as Filing;
    const drop = (over: Partial<DropOntoARow>): DropOntoARow => ({
      carried: [STORM],
      target: CHAPTER_4,
      rows: [],
      filings: [filed(STORM, SCENES)],
      from: { parentId: null, panelId: SCENES },
      selectionPanels: null,
      list: { panelId: SCENES, heldBy: null },
      keys: { move: false, add: false },
      ...over,
    });
    const planned = (over: Partial<DropOntoARow>) => planDropOntoARow(drop(over)) as Exclude<RowDropPlan, { refused: string }>;

    it.each([
      {
        situation: 'a top-level row onto a row of the same Panel',
        over: {},
        asks: false,
        answer: 'move',
        leaves: [{ itemId: STORM, panelId: SCENES }],
      },
      {
        situation: 'a child onto another row of the same list',
        over: {
          from: { parentId: CHAPTER_3, panelId: null },
          rows: [{ parentId: CHAPTER_3, childId: STORM, position: 0 }],
          filings: [],
          list: { panelId: SCENES, heldBy: CHAPTER_3 },
        },
        asks: false,
        answer: 'move',
        leaves: [{ itemId: STORM, parentId: CHAPTER_3 }],
      },
      {
        situation: 'a row from another Panel',
        over: { list: { panelId: DRAFTS, heldBy: null } },
        asks: true,
        answer: 'ask',
        leaves: [{ itemId: STORM, panelId: SCENES }],
      },
      {
        situation: 'a child from another parent',
        over: {
          from: { parentId: CHAPTER_3, panelId: null },
          rows: [{ parentId: CHAPTER_3, childId: STORM, position: 0 }],
          filings: [],
          list: { panelId: SCENES, heldBy: null },
        },
        asks: true,
        answer: 'ask',
        leaves: [{ itemId: STORM, parentId: CHAPTER_3 }],
      },
      {
        situation: 'a row from another Panel, with Shift held',
        over: { list: { panelId: DRAFTS, heldBy: null }, keys: { move: true, add: false } },
        asks: true,
        answer: 'move',
        leaves: [{ itemId: STORM, panelId: SCENES }],
      },
      {
        situation: 'a row from another Panel, with Ctrl or Option held',
        over: { list: { panelId: DRAFTS, heldBy: null }, keys: { move: false, add: true } },
        asks: true,
        answer: 'add',
        leaves: [{ itemId: STORM, panelId: SCENES }],
      },
      {
        situation: 'a row of the same Panel, with Ctrl held, which asked nothing to answer',
        over: { keys: { move: false, add: true } },
        asks: false,
        answer: 'move',
        leaves: [{ itemId: STORM, panelId: SCENES }],
      },
      {
        situation: 'an Inbox row onto an Inbox row',
        over: { filings: [], from: { parentId: null, panelId: null }, list: { panelId: null, heldBy: null } },
        asks: false,
        answer: 'move',
        leaves: [],
      },
    ])('$situation: asks=$asks, then $answer', ({ over, asks, answer, leaves }) => {
      const plan = planned(over);

      expect(plan).toMatchObject({ asks, answer, leaves, childIds: [STORM], order: [STORM] });
    });

    it('goes inside the end of what the parent holds', () => {
      const plan = planned({ rows: [{ parentId: CHAPTER_4, childId: FERRY, position: 0 }] });

      expect(plan.order).toEqual([FERRY, STORM]);
    });

    it('does nothing for an Item that is inside the row already and leaves nothing', () => {
      const plan = planDropOntoARow(
        drop({ rows: [{ parentId: CHAPTER_4, childId: STORM, position: 0 }], filings: [], from: { parentId: null, panelId: null } }),
      );

      expect(plan).toBeNull();
    });

    it('refuses more Items than a change takes', () => {
      const many = Array.from({ length: 51 }, (_, at) => `i-${at}`);

      const plan = planDropOntoARow(drop({ carried: many, filings: [] }));

      expect(plan).toEqual({ refused: expect.stringContaining('50') });
    });
  });
});

describe('Selection', () => {
  describe('a selection dropped onto a row is one change built from what is picked', () => {
    it('puts every Item inside in one change, each leaving the Panels of the Dashboard it was picked on', () => {
      const plan = planDropOntoARow({
        carried: [STORM, FERRY, FLASHBACK],
        target: CHAPTER_4,
        rows: [],
        filings: [
          { itemId: STORM, panelId: SCENES, position: 0 },
          { itemId: FERRY, panelId: DRAFTS, position: 0 },
        ] as Filing[],
        from: { parentId: null, panelId: SCENES },
        selectionPanels: [SCENES, DRAFTS],
        list: { panelId: SCENES, heldBy: null },
        keys: { move: false, add: false },
      }) as Exclude<RowDropPlan, { refused: string }>;

      expect(plan.childIds).toEqual([STORM, FERRY, FLASHBACK]);
      expect(plan.order).toEqual([STORM, FERRY, FLASHBACK]);
      expect(plan.leaves).toEqual([
        { itemId: STORM, panelId: SCENES },
        { itemId: FERRY, panelId: DRAFTS },
      ]);
      // One of them came from another Panel of the Dashboard, so the whole drop is one question.
      expect(plan.answer).toBe('ask');
    });

    it('asks nothing of a selection picked in the Inbox', () => {
      const plan = planDropOntoARow({
        carried: [STORM, FERRY],
        target: CHAPTER_4,
        rows: [],
        filings: [],
        from: { parentId: null, panelId: null },
        selectionPanels: [],
        list: { panelId: null, heldBy: null },
        keys: { move: false, add: false },
      }) as Exclude<RowDropPlan, { refused: string }>;

      expect(plan).toMatchObject({ childIds: [STORM, FERRY], leaves: [], answer: 'move' });
    });
  });
});

describe('Panels', () => {
  describe('putting Items inside a parent moves them out of the list they were picked in, and nowhere else', () => {
    const filed = (itemId: string, panelId: string): Filing => ({ itemId, panelId, position: 0 }) as Filing;
    const panels = [
      { id: SCENES, dashboardId: 'd-1' },
      { id: DRAFTS, dashboardId: 'd-1' },
      { id: 'p-other', dashboardId: 'd-2' },
    ];
    const pick = (over: Partial<Parameters<typeof leavesOfAPick>[0]>) =>
      leavesOfAPick({
        carried: [STORM, FERRY],
        target: CHAPTER_4,
        rows: [],
        filings: [filed(STORM, SCENES), filed(FERRY, DRAFTS), filed(FERRY, 'p-other')],
        panels,
        where: { panelId: SCENES, heldBy: null, dashboardId: 'd-1', selection: true },
        ...over,
      });

    it.each([
      {
        situation: 'a selection on a Dashboard leaves every Panel of that Dashboard it is on, and none of another Dashboard',
        over: {},
        leaves: [
          { itemId: STORM, panelId: SCENES },
          { itemId: FERRY, panelId: DRAFTS },
        ],
      },
      {
        situation: 'one row’s menu leaves only the Panel that row is on',
        over: { carried: [FERRY], where: { panelId: DRAFTS, heldBy: null, dashboardId: 'd-1', selection: false } },
        leaves: [{ itemId: FERRY, panelId: DRAFTS }],
      },
      {
        situation: 'a child picked in its parent’s list leaves that parent',
        over: {
          carried: [STORM],
          rows: [{ parentId: CHAPTER_3, childId: STORM, position: 0 }],
          filings: [],
          where: { panelId: null, heldBy: CHAPTER_3, dashboardId: null, selection: false },
        },
        leaves: [{ itemId: STORM, parentId: CHAPTER_3 }],
      },
      {
        situation: 'Items picked in the Inbox leave nothing',
        over: { filings: [], where: { panelId: null, heldBy: null, dashboardId: null, selection: true } },
        leaves: [],
      },
    ])('$situation', ({ over, leaves }) => {
      expect(pick(over as never)).toEqual(leaves);
    });

    it('sends no change for an Item already inside the parent with nothing to leave', () => {
      expect(
        planPuttingInside({ carried: [STORM], target: CHAPTER_4, rows: [{ parentId: CHAPTER_4, childId: STORM, position: 0 }], leaves: [] }),
      ).toEqual([]);
    });

    it('sends one change per 50 Items, each with its own leaves and the parent’s whole order at that point', () => {
      const carried = Array.from({ length: 60 }, (_, at) => `i-${at}`);
      const leaves = carried.map((itemId) => ({ itemId, panelId: SCENES }));

      const batches = planPuttingInside({ carried, target: CHAPTER_4, rows: [{ parentId: CHAPTER_4, childId: 'i-held', position: 0 }], leaves });

      expect(batches.map((batch) => batch.childIds.length)).toEqual([50, 10]);
      expect(batches[0]!.leaves).toEqual(leaves.slice(0, 50));
      expect(batches[1]!.leaves).toEqual(leaves.slice(50));
      expect(batches[0]!.order).toEqual(['i-held', ...carried.slice(0, 50)]);
      expect(batches[1]!.order).toEqual(['i-held', ...carried]);
    });
  });
});

describe('Panels', () => {
  describe('a child row ticked in a parent’s list on a Dashboard leaves that parent', () => {
    it('takes a child out of the parent unfolded under a row of the Dashboard, and out of no folded one', () => {
      const pick = (unfolded: string[]) =>
        leavesOfAPick({
          carried: [STORM],
          target: CHAPTER_4,
          rows: [
            { parentId: CHAPTER_3, childId: STORM, position: 0 },
            { parentId: FLASHBACK, childId: STORM, position: 0 },
          ],
          filings: [{ itemId: CHAPTER_3, panelId: SCENES, position: 0 } as Filing],
          panels: [{ id: SCENES, dashboardId: 'd-1' }],
          where: { panelId: null, heldBy: null, dashboardId: 'd-1', selection: true },
          unfolded: new Set(unfolded),
        });

      expect(pick([CHAPTER_3, FLASHBACK])).toEqual([{ itemId: STORM, parentId: CHAPTER_3 }]);
      expect(pick([])).toEqual([]);
    });
  });
});
