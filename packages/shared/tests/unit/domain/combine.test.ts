import { describe, expect, it } from 'vitest';
import { combinedTitle, itemFromASource, panelTheFirstIsOn, parentDescription, stitchedDescription } from '../../../src/domain/combine.js';
import { NAME_MAX_LENGTH, type Item } from '../../../src/domain/item.js';

/**
 * L1: what Combine works out before it sends one change ("Brainstorming:
 * related loose notes can't be brought together", issue 1826). What the dialog
 * does with it is apps/web/tests/unit/components/CombineDialog.test.tsx.
 */

const note = (title: string, over: Partial<Item> = {}): Item => ({ id: title, title, description: null, source: 'internal', ...over }) as Item;

describe('Triage', () => {
  describe('Combine writes the new Item\'s texts from the parts and what you add', () => {
    it('titles it after the first Item and says how many more are with it', () => {
      expect(combinedTitle([note('Storm scene')])).toBe('Combined: Storm scene');
      expect(combinedTitle([note('Storm scene'), note('Ferry'), note('Gulls')])).toBe('Combined: Storm scene +2');
    });

    it('keeps the title within a name, cut with an ellipsis', () => {
      const title = combinedTitle([note('x'.repeat(200)), note('y')]);
      expect(title).toHaveLength(NAME_MAX_LENGTH);
      expect(title.endsWith('…')).toBe(true);
    });

    it.each([
      { situation: 'with nothing added', note: '', expected: 'This brings together “A”, “B” and “C”.' },
      { situation: 'with your words added on one line', note: '  the\ncrossing ', expected: 'This brings together “A”, “B” and “C”. the crossing' },
    ])('describes a new parent $situation', ({ note: added, expected }) => {
      expect(parentDescription([note('A'), note('B'), note('C')], added)).toBe(expected);
    });

    it('stitches a Merge from your words and each part under its title, in the order picked', () => {
      const parts = [note('A', { description: 'About A' }), note('B')];
      expect(stitchedDescription(parts, 'Chapter 3')).toBe('Chapter 3\n\nA\nAbout A\n\nB');
    });
  });

  describe('a new parent is made where the first Item was', () => {
    const panels = [
      { id: 'here', dashboardId: 'today' },
      { id: 'elsewhere', dashboardId: 'later' },
    ];

    it.each([
      { situation: 'filed on a Panel of the open Dashboard', filings: [{ itemId: 'a', panelId: 'here' }], expected: 'here' },
      { situation: 'filed on another Dashboard only', filings: [{ itemId: 'a', panelId: 'elsewhere' }], expected: 'elsewhere' },
      { situation: 'on both, preferring the open Dashboard', filings: [{ itemId: 'a', panelId: 'elsewhere' }, { itemId: 'a', panelId: 'here' }], expected: 'here' },
      { situation: 'in the Inbox', filings: [{ itemId: 'b', panelId: 'here' }], expected: null },
    ])('$situation', ({ filings, expected }) => {
      expect(panelTheFirstIsOn('a', 'today', filings, panels)).toBe(expected);
    });
  });

  describe('an Item from a source cannot be merged', () => {
    it('finds the first one from a source, and none among Items captured here', () => {
      expect(itemFromASource([note('A'), note('B', { source: 'gmail' })])?.title).toBe('B');
      expect(itemFromASource([note('A'), note('B')])).toBeUndefined();
    });
  });
});
