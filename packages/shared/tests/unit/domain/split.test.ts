import { describe, expect, it } from 'vitest';
import { paragraphsOf, splitBlocksOf, wordsOfBlocks } from '../../../src/domain/split.js';

/**
 * L1: an Item's words, Additions and files read as blocks ("Brainstorming: a
 * note holding several ideas can't be taken apart", issue 1828), the same way
 * on the API and in the dialog, so a block id means the same text on both.
 */

describe('Triage', () => {
  describe('an Item is read as blocks in their own order', () => {
    it('cuts the description at blank lines, then lists Additions oldest first, then files', () => {
      const blocks = splitBlocksOf(
        { description: 'One idea.\n\n\n  Another idea.\nOn two lines.\n\n' },
        [
          { id: 'b', message: 'Later', createdAt: '2026-11-02T10:00:00.000Z' },
          { id: 'a', message: 'Earlier', createdAt: '2026-11-01T10:00:00.000Z' },
          { id: 'c', message: '   ', createdAt: '2026-11-03T10:00:00.000Z' },
        ],
        [{ id: 'f', filename: 'quote.pdf', contentType: 'application/pdf' }],
      );

      expect(blocks.map((block) => [block.id, block.text])).toEqual([
        ['p0', 'One idea.'],
        ['p1', 'Another idea.\nOn two lines.'],
        ['a-a', 'Earlier'],
        ['a-b', 'Later'],
        ['f-f', 'quote.pdf'],
      ]);
    });

    it('holds nothing for an Item with no description, Addition or file', () => {
      expect(splitBlocksOf({ description: null }, [], [])).toEqual([]);
      expect(paragraphsOf('')).toEqual([]);
    });

    it('writes a new Item’s description from its paragraphs alone, a blank line apart', () => {
      const blocks = splitBlocksOf({ description: 'A\n\nB' }, [{ id: 'x', message: 'Added', createdAt: '2026-11-01T10:00:00.000Z' }], []);

      expect(wordsOfBlocks(blocks)).toBe('A\n\nB');
    });
  });
});
