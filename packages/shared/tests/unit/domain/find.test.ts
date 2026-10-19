import { describe, expect, it } from 'vitest';
import type { Item } from '../../../src/index.js';
import { findNeedle, searchTextOf, textMatches } from '../../../src/index.js';

/**
 * L1: the text a typed search runs over and how it matches, shared by Find
 * item and the MCP `find_items` tool so an app finds what a person typing
 * would. That Find draws its rows from it is
 * apps/web/tests/unit/itemFind.test.tsx; that `find_items` answers with it is
 * apps/api/tests/integration/http/find-items.test.ts.
 */

const anItem = (over: Partial<Item> = {}): Item =>
  ({ title: 'Untitled', description: null, nextAction: null, sender: null, ...over }) as Item;

/** Whether typing `typed` finds `item`, the way Find asks. */
const finds = (item: Item, typed: string) => textMatches(searchTextOf(item), findNeedle(typed));

describe('Dashboards', () => {
  describe('Find matches what is typed in an Item’s title, description, next action or sender, ignoring case', () => {
    it.each([
      { situation: 'the title', over: { title: 'Pay conselit.be' } },
      { situation: 'the description', over: { description: 'invoice from conselit.be' } },
      { situation: 'the next action', over: { nextAction: 'Call conselit.be' } },
      { situation: 'the sender', over: { sender: 'billing@conselit.be' } },
    ])('matches in $situation only', ({ over }) => {
      expect(finds(anItem(over), 'CONSELIT.BE')).toBe(true);
      expect(finds(anItem(), 'CONSELIT.BE')).toBe(false);
    });

    it.each([
      { situation: 'capitals typed against lower case', title: 'ring the plumber', typed: 'PLUMBER', found: true },
      { situation: 'lower case typed against capitals', title: 'Ring The Plumber', typed: 'the plumber', found: true },
      { situation: 'an accented capital against its lower case', title: 'Réunion à Liège', typed: 'LIÈGE', found: true },
      { situation: 'an accent left out, which is another letter', title: 'Réunion', typed: 'reunion', found: false },
      { situation: 'spaces around what is typed', title: 'Ring the plumber', typed: '  plumber  ', found: true },
      { situation: 'a word that is not there', title: 'Ring the plumber', typed: 'electrician', found: false },
    ])('with $situation, an Item is found: $found', ({ title, typed, found }) => {
      expect(finds(anItem({ title }), typed)).toBe(found);
    });

    it('matches nothing while nothing, or only spaces, is typed', () => {
      expect(findNeedle('   ')).toBe('');
      expect(finds(anItem({ title: 'Anything at all' }), '   ')).toBe(false);
      expect(finds(anItem({ title: 'Anything at all' }), '')).toBe(false);
    });

    it('does not run a match across two fields', () => {
      // The fields are one line apart, so words ending one and starting the next are not a phrase.
      expect(finds(anItem({ title: 'Ring', description: 'plumber' }), 'ring plumber')).toBe(false);
    });
  });
});
