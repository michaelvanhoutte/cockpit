import { describe, expect, it } from 'vitest';
import type { ChildRow } from '@cockpit/shared';
import { cardUnder, clickRenames, dropAnswers, f2Renames, renameStillWanted, type Frame, type TitleClick } from '../../../src/whiteboard/gestures';

/**
 * L1 for what a gesture on the whiteboard comes to ("Brainstorming: cards on
 * the whiteboard can't be nested, combined or moved between boxes", issue
 * 1830): which card a drop is on, what may be done there, and when a click on
 * a title or F2 renames. Where each is sent, and that the pointer really reaches
 * them, is the board's walk (`tests/e2e/whiteboard.test.ts`).
 */
const frames: Frame[] = [
  { id: 'chapter', x: 0, y: 0, w: 220, h: 80 },
  { id: 'storm', x: 300, y: 0, w: 220, h: 80 },
  { id: 'over-storm', x: 400, y: 20, w: 220, h: 80 },
];
const none = new Set<string>();
const row = (parentId: string, childId: string): ChildRow => ({ parentId, childId, position: 0 });
const plain: TitleClick = { x: 10, y: 10, detail: 1, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false };

describe('Whiteboard', () => {
  describe('a card let go on another card asks what to do with the two', () => {
    it.each([
      { situation: 'a point on one card', at: { x: 50, y: 40 }, leaving: none, over: 'chapter' },
      { situation: 'a point on open space', at: { x: 250, y: 40 }, leaving: none, over: null },
      { situation: 'a point where two overlap, the one drawn last', at: { x: 450, y: 40 }, leaving: none, over: 'over-storm' },
      { situation: 'the card being dragged, which is not a card to drop on', at: { x: 50, y: 40 }, leaving: new Set(['chapter']), over: null },
    ])('finds $over for $situation', ({ at, leaving, over }) => {
      expect(cardUnder(frames, at, leaving)).toBe(over);
    });

    it.each([
      { situation: 'an Item with nothing to do with the card', itemId: 'ferry', rows: [] as ChildRow[], offers: ['inside', 'combine'] },
      { situation: 'an Item let go on its own card', itemId: 'chapter', rows: [] as ChildRow[], offers: ['combine'] },
      { situation: 'an Item that already holds the card', itemId: 'volume', rows: [row('volume', 'chapter')], offers: ['combine'] },
      { situation: 'an Item that holds something that holds the card', itemId: 'book', rows: [row('book', 'volume'), row('volume', 'chapter')], offers: ['combine'] },
      { situation: 'an Item already inside the card', itemId: 'ferry', rows: [row('chapter', 'ferry')], offers: ['combine'] },
    ])('offers $offers for $situation', ({ itemId, rows, offers }) => {
      expect(dropAnswers(itemId, 'chapter', rows)).toEqual(offers);
    });
  });

  describe('renaming in place works from a click on the selected title or F2', () => {
    const selectedPress = { x: 10, y: 10, wasSelected: true };

    it.each([
      { situation: 'a second click on the title of what was selected', press: selectedPress, click: plain, readOnly: false, renames: true },
      { situation: 'the click that selects it', press: { ...selectedPress, wasSelected: false }, click: plain, readOnly: false, renames: false },
      { situation: 'a click with no press before it', press: null, click: plain, readOnly: false, renames: false },
      { situation: 'the second click of a double-click, which opens the Item', press: selectedPress, click: { ...plain, detail: 2 }, readOnly: false, renames: false },
      { situation: 'a Shift-click, which toggles the selection', press: selectedPress, click: { ...plain, shiftKey: true }, readOnly: false, renames: false },
      { situation: 'a Ctrl-click', press: selectedPress, click: { ...plain, ctrlKey: true }, readOnly: false, renames: false },
      { situation: 'the end of a drag', press: selectedPress, click: { ...plain, x: 60 }, readOnly: false, renames: false },
      { situation: 'a board that is only to look at', press: selectedPress, click: plain, readOnly: true, renames: false },
    ])('a click renames: $situation is $renames', ({ press, click, readOnly, renames }) => {
      expect(clickRenames(press, click, readOnly)).toBe(renames);
    });

    it.each([
      { situation: 'the card is still the only one selected', selected: ['ferry'], wanted: true },
      { situation: 'another card was clicked meanwhile', selected: ['storm'], wanted: false },
      { situation: 'a second was added to the selection', selected: ['ferry', 'storm'], wanted: false },
      { situation: 'nothing is selected, as after a drag elsewhere', selected: [] as string[], wanted: false },
    ])('a rename waiting out a double-click goes ahead: $situation is $wanted', ({ selected, wanted }) => {
      expect(renameStillWanted(selected, 'ferry')).toBe(wanted);
    });

    const ready = { readOnly: false, selected: 1, typing: false, windowOpen: false, focusOnBoard: true };
    it.each([
      { situation: 'one card or box selected on the board', state: ready, renames: true },
      { situation: 'nothing selected', state: { ...ready, selected: 0 }, renames: false },
      { situation: 'two selected', state: { ...ready, selected: 2 }, renames: false },
      { situation: 'a field being typed in', state: { ...ready, typing: true }, renames: false },
      { situation: 'a window or menu open', state: { ...ready, windowOpen: true }, renames: false },
      { situation: 'the focus outside the board', state: { ...ready, focusOnBoard: false }, renames: false },
      { situation: 'a board that is only to look at', state: { ...ready, readOnly: true }, renames: false },
    ])('F2 renames: $situation is $renames', ({ state, renames }) => {
      expect(f2Renames(state)).toBe(renames);
    });
  });
});
