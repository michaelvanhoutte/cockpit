import { describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { fixedLineKindId, type BoardCard, type ItemLink, type LineKind, type Whiteboards } from '@cockpit/shared/board';
import { boardDrawnAhead } from '../../../src/whiteboard/boardDrawn';
import { linksOnTheBoard, nearestSides, type Rect } from '../../../src/whiteboard/links';

/**
 * F1 for which links a whiteboard draws and where each meets a card
 * ("Brainstorming: the whiteboard can't show how Items connect", issue 1831),
 * and how a change to them is drawn before the server answers. What the read
 * carries is the API's (apps/api/tests/integration/http/item-links.test.ts);
 * that a dot really drags into a link is the browser walk's.
 */
const LEADS_TO: LineKind = { id: fixedLineKindId('ws', 'leads_to'), name: 'Leads to', style: 'solid', colour: 'slate', arrow: true, role: 'leads_to' };
const RELATED: LineKind = { id: fixedLineKindId('ws', 'related'), name: 'Related', style: 'solid', colour: 'grey', arrow: false, role: 'related' };
const KINDS = [LEADS_TO, RELATED];

const aCard = (itemId: string): BoardCard => ({ id: `card-${itemId}`, dashboardId: 'dash', itemId, boxId: null, x: 0, y: 0 });
const aLink = (fromItemId: string, toItemId: string, kindId = LEADS_TO.id): ItemLink => ({ id: `${fromItemId}-${toItemId}`, fromItemId, toItemId, kindId, label: null });
const nothingUnfolded = () => [];

describe('Whiteboard', () => {
  describe('a link is drawn on a board only where both its Items are drawn there', () => {
    it.each([
      { situation: 'both Items have a card here', cards: ['storm', 'ferry'], unfolded: {}, drawn: [{ from: 'card-storm', to: 'card-ferry', inside: [null, null] }] },
      { situation: 'only one Item has a card here', cards: ['storm'], unfolded: {}, drawn: [] },
      { situation: 'one Item is inside a parent unfolded here', cards: ['storm', 'chapter'], unfolded: { chapter: ['ferry'] }, drawn: [{ from: 'card-storm', to: 'card-chapter', inside: [null, 'ferry'] }] },
      { situation: 'one Item is inside a parent folded here', cards: ['storm', 'chapter'], unfolded: {}, drawn: [] },
      { situation: 'it joins a parent to an Item inside it', cards: ['storm'], unfolded: { storm: ['ferry'] }, drawn: [] },
    ])('when $situation', ({ cards, unfolded, drawn }) => {
      const held = unfolded as Record<string, string[]>;
      const on = linksOnTheBoard([aLink('storm', 'ferry')], KINDS, { cards: cards.map(aCard) }, (itemId) => held[itemId] ?? []);
      expect(on.map((one) => ({ from: one.from.cardId, to: one.to.cardId, inside: [one.from.inside, one.to.inside] }))).toEqual(drawn);
    });

    it('draws a link of a kind the board does not know as Related', () => {
      const [drawn] = linksOnTheBoard([aLink('storm', 'ferry', 'a-deleted-kind')], KINDS, { cards: [aCard('storm'), aCard('ferry')] }, nothingUnfolded);
      expect(drawn?.kind).toBe(RELATED);
    });
  });

  describe('a link leaves and meets each card at the middle of its nearest side', () => {
    const card = (x: number, y: number): Rect => ({ x, y, w: 200, h: 60 });
    it.each([
      { situation: 'to the right', to: card(400, 0), sides: ['right', 'left'], at: [{ x: 200, y: 30 }, { x: 400, y: 30 }] },
      { situation: 'to the left', to: card(-400, 20), sides: ['left', 'right'], at: [{ x: 0, y: 30 }, { x: -200, y: 50 }] },
      { situation: 'below', to: card(40, 200), sides: ['bottom', 'top'], at: [{ x: 100, y: 60 }, { x: 140, y: 200 }] },
      { situation: 'above, a little across', to: card(150, -300), sides: ['top', 'bottom'], at: [{ x: 100, y: 0 }, { x: 250, y: -240 }] },
    ])('for a card $situation', ({ to, sides, at }) => {
      const ends = nearestSides(card(0, 0), to);
      expect([ends.from.side, ends.to.side]).toEqual(sides);
      expect([
        { x: ends.from.x, y: ends.from.y },
        { x: ends.to.x, y: ends.to.y },
      ]).toEqual(at);
    });
  });

  describe('a change to links, kinds or free lines is drawn before the server answers', () => {
    const whiteboards = (over: Partial<Whiteboards> = {}): Whiteboards => ({ layouts: [], boxes: [], cards: [], lineKinds: KINDS, links: [], lines: [], ...over });
    const aSnapshot = (over: Partial<Whiteboards> = {}) => ({ workspace: { id: 'ws' }, whiteboards: whiteboards(over) }) as unknown as WorkspaceSnapshot;
    const envelope = { commandId: 'c', issuedAt: '2026-11-21T10:00:00.000Z', workspaceId: 'ws' };

    it('draws a link made, once however often it is sent, and takes one removed away', () => {
      const change = { name: 'link_items', payload: { ...envelope, linkId: 'l1', fromItemId: 'storm', toItemId: 'ferry', kindId: LEADS_TO.id } } as const;
      const once = boardDrawnAhead(aSnapshot(), change);
      expect(boardDrawnAhead(once, change).whiteboards!.links).toEqual([aLink('storm', 'ferry')].map((one) => ({ ...one, id: 'l1' })));
      expect(boardDrawnAhead(once, { name: 'unlink_items', payload: { ...envelope, linkId: 'l1' } }).whiteboards!.links).toEqual([]);
    });

    it('draws the links of a kind deleted as Related', () => {
      const blocks: LineKind = { id: 'blocks', name: 'Blocks', style: 'dashed', colour: 'rose', arrow: true, role: null };
      const drawn = boardDrawnAhead(aSnapshot({ lineKinds: [...KINDS, blocks], links: [aLink('storm', 'ferry', 'blocks')] }), {
        name: 'delete_line_kind',
        payload: { ...envelope, kindId: 'blocks' },
      });
      expect(drawn.whiteboards!.lineKinds).toEqual(KINDS);
      expect(drawn.whiteboards!.links.map((one) => one.kindId)).toEqual([RELATED.id]);
    });

    it('draws a free line on its board and its label once typed', () => {
      const drawn = boardDrawnAhead(aSnapshot(), { name: 'draw_line', payload: { ...envelope, lineId: 'line', dashboardId: 'dash', x1: 0, y1: 0, x2: 100, y2: 40, label: '' } });
      const labelled = boardDrawnAhead(drawn, { name: 'set_line_label', payload: { ...envelope, lineId: 'line', label: 'Act two' } });
      expect(labelled.whiteboards!.lines).toEqual([{ id: 'line', dashboardId: 'dash', x1: 0, y1: 0, x2: 100, y2: 40, label: 'Act two' }]);
    });
  });
});
