import { describe, expect, it } from 'vitest';
import type { Item, WorkspaceSnapshot } from '@cockpit/shared';
import type { BoardBox } from '@cockpit/shared/board';
import { boardDrawnAhead } from '../../../src/whiteboard/boardDrawn';
import { boxAt, relativeTo, whyNotPlaceable } from '../../../src/whiteboard/layout';
import { settledShare } from '../../../src/whiteboard/DashboardViews';
import { drawnAhead } from '../../../src/drawnAhead';
import { boardLayoutOf } from '../../../src/boardLayout';

/**
 * L1 for the whiteboard's own reckoning ("Brainstorming: give every Dashboard a
 * whiteboard of its own", issue 1829): which box a card lands in, what a drop
 * of an Inbox row says, where a let-go divider settles, and how a change is
 * drawn before the server answers. What the server stores is the API's.
 */
const aBox = (over: Partial<BoardBox>): BoardBox => ({
  id: 'box',
  dashboardId: 'dash',
  parentBoxId: null,
  label: '',
  colour: null,
  x: 0,
  y: 0,
  w: 400,
  h: 300,
  collapsed: false,
  ...over,
});

const people = aBox({ id: 'people', label: 'People', x: 100, y: 100 });
const mentors = aBox({ id: 'mentors', label: 'Mentors', parentBoxId: 'people', x: 20, y: 60, w: 200, h: 150 });

function aSnapshot(over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    workspace: { id: 'ws', tenantId: 't' },
    items: [{ id: 'a', title: 'Ferry scene', completedAt: null } as Item],
    filings: [],
    children: [],
    panels: [{ id: 'panel', kind: 'items', dashboardId: 'dash' }],
    whiteboards: { layouts: [], boxes: [people, mentors], cards: [] },
    ...over,
  } as unknown as WorkspaceSnapshot;
}

describe('Whiteboard', () => {
  describe('a card or box lands in the innermost box under it, placed relative to that box', () => {
    it.each([
      { situation: 'open space', point: { x: 20, y: 20 }, box: null, place: { x: 20, y: 20 } },
      { situation: 'a box', point: { x: 400, y: 150 }, box: 'people', place: { x: 300, y: 50 } },
      { situation: 'a box inside a box', point: { x: 150, y: 220 }, box: 'mentors', place: { x: 30, y: 60 } },
    ])('on $situation', ({ point, box, place }) => {
      const boxes = [people, mentors];
      const into = boxAt(boxes, point);
      expect(into?.id ?? null).toBe(box);
      expect(relativeTo(boxes, into, point)).toEqual(place);
    });

    it('never lands a box in itself or a box it holds, and not in what a collapsed box hides', () => {
      expect(boxAt([people, mentors], { x: 150, y: 220 }, new Set(['people', 'mentors']))).toBeNull();
      expect(boxAt([{ ...people, collapsed: true }, mentors], { x: 150, y: 220 })).toBeNull();
    });
  });

  describe('an Inbox row dropped on the board is refused, with a line saying where to give it a place first', () => {
    it.each([
      { situation: 'an Item in the Inbox', over: {}, line: 'Ferry scene is in the Inbox. File it on a Panel or put it inside an Item first.' },
      { situation: 'an Item filed on a Panel', over: { filings: [{ itemId: 'a', panelId: 'panel', position: 0 }] }, line: null },
      { situation: 'an Item inside another', over: { children: [{ parentId: 'p', childId: 'a', position: 0 }] }, line: null },
    ])('$situation', ({ over, line }) => {
      expect(whyNotPlaceable(aSnapshot(over as Partial<WorkspaceSnapshot>), 'a')).toBe(line);
    });
  });

  describe('the divider settles where it is let go, and shuts a pane when dragged to its edge', () => {
    it.each([
      { situation: 'to the left edge', share: 0.03, settles: 0 },
      { situation: 'in the middle', share: 0.55, settles: 0.55 },
      { situation: 'to the right edge', share: 0.97, settles: 1 },
    ])('let go $situation', ({ share, settles }) => {
      expect(settledShare(share)).toBe(settles);
    });
  });

  describe('the layout and divider are remembered per Dashboard, and drawn the moment they are chosen', () => {
    const envelope = { commandId: 'c', issuedAt: '2026-11-20T10:00:00.000Z', workspaceId: 'ws' };
    it('reads Panels at 40% for a Dashboard never switched, and each Dashboard’s own choice after', () => {
      let snapshot = aSnapshot();
      expect(boardLayoutOf(snapshot, 'dash')).toEqual({ view: 'panels', splitShare: 0.4 });
      snapshot = drawnAhead(snapshot, { name: 'set_dashboard_view', payload: { ...envelope, dashboardId: 'dash', view: 'side' } });
      snapshot = drawnAhead(snapshot, { name: 'set_dashboard_split', payload: { ...envelope, dashboardId: 'dash', splitShare: 0.25 } });
      expect(boardLayoutOf(snapshot, 'dash')).toEqual({ view: 'side', splitShare: 0.25 });
      expect(boardLayoutOf(snapshot, 'other')).toEqual({ view: 'panels', splitShare: 0.4 });
    });
  });

  describe('a change on the board is drawn the moment it is made', () => {
    const envelope = { commandId: 'c', issuedAt: '2026-11-20T10:00:00.000Z', workspaceId: 'ws' };
    const boards = (snapshot: WorkspaceSnapshot) => snapshot.whiteboards!;
    it.each([
      {
        situation: 'a card placed',
        change: { name: 'place_card', payload: { ...envelope, cardId: 'k', dashboardId: 'dash', itemId: 'a', boxId: 'people', x: 10, y: 50 } },
        expect: (s: WorkspaceSnapshot) => expect(boards(s).cards).toEqual([{ id: 'k', dashboardId: 'dash', itemId: 'a', boxId: 'people', x: 10, y: 50 }]),
      },
      {
        situation: 'a box drawn',
        change: { name: 'draw_box', payload: { ...envelope, boxId: 'new', dashboardId: 'dash', parentBoxId: null, label: 'Places', colour: null, x: 0, y: 0, w: 200, h: 100 } },
        expect: (s: WorkspaceSnapshot) => expect(boards(s).boxes.map((one) => one.label)).toEqual(['People', 'Mentors', 'Places']),
      },
      {
        situation: 'a box deleted with what it holds',
        change: { name: 'delete_box', payload: { ...envelope, boxId: 'people' } },
        expect: (s: WorkspaceSnapshot) => expect(boards(s).boxes).toEqual([]),
      },
      {
        situation: 'a box collapsed',
        change: { name: 'set_box_collapsed', payload: { ...envelope, boxId: 'mentors', collapsed: true } },
        expect: (s: WorkspaceSnapshot) => expect(boards(s).boxes.find((one) => one.id === 'mentors')?.collapsed).toBe(true),
      },
    ])('$situation', ({ change, expect: check }) => {
      check(boardDrawnAhead(aSnapshot(), change as never));
    });
  });
});
