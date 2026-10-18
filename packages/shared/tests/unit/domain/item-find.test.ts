import { describe, expect, it } from 'vitest';
import { searchTextOf, textMatches, type Item } from '../../../src/index.js';

/**
 * L1: how *Find item* matches what is typed - the title, description, next
 * action and sender, ignoring case, and nothing by meaning. The rule the screen
 * and a connected app's `find_items` both read (issue 1240). That the screen
 * lists what it finds, and where each is, is apps/web/tests/unit/itemFind.test.tsx.
 */

const anItem = (fields: Partial<Item> = {}): Item =>
  ({ title: 'Pay the invoice', description: null, nextAction: null, sender: null, ...fields }) as Item;

describe('Dashboards', () => {
  describe('Find matches what is typed in the title, description, next action or sender, ignoring case', () => {
    it.each([
      { situation: 'the title', item: anItem({ title: 'File the VAT return' }), typed: 'vat', matches: true },
      { situation: 'the description', item: anItem({ description: 'about the Landlord' }), typed: 'LANDLORD', matches: true },
      { situation: 'the next action', item: anItem({ nextAction: 'Ask for the number' }), typed: 'ask for', matches: true },
      { situation: 'the sender', item: anItem({ sender: 'Claude' }), typed: 'claud', matches: true },
      { situation: 'text typed with spaces around it', item: anItem(), typed: '  invoice  ', matches: true },
      { situation: 'text in none of them', item: anItem({ sender: 'Claude' }), typed: 'landlord', matches: false },
      { situation: 'nothing typed, which matches nothing', item: anItem(), typed: '   ', matches: false },
      { situation: 'a meaning rather than the words', item: anItem({ title: 'Pay the bill' }), typed: 'invoice', matches: false },
    ])('$situation', ({ item, typed, matches }) => {
      expect(textMatches(item, typed)).toBe(matches);
    });

    it('builds one lowercased line of the four fields, so a keystroke only scans it', () => {
      expect(
        searchTextOf(anItem({ title: 'A', description: 'B', nextAction: 'C', sender: 'D' })),
      ).toBe('a\nb\nc\nd');
    });
  });
});
