import { describe, expect, it } from 'vitest';
import type { SplitBlock } from '@cockpit/shared';
import { readSplit } from '../../../src/ai/split-cards.js';

/**
 * L1: reading what the model proposed as a split ("Brainstorming: a note
 * holding several ideas can't be taken apart", issue 1828): held to the blocks
 * it was shown, to 6 cards, and to titles that are one line.
 */

const blocks: SplitBlock[] = Array.from({ length: 50 }, (_, n) => ({ id: `p${n}`, kind: 'paragraph', text: `Paragraph ${n}` }));
const answer = (items: unknown) => JSON.stringify({ language: 'English', items });

describe('Triage', () => {
  describe('a proposed split is read as the cards it names, from the blocks it was shown', () => {
    it('maps numbers to block ids, in order, each block in the first card that names it', () => {
      expect(readSplit(answer([{ title: 'Rent', blocks: [3, 1] }, { title: 'Ferry', blocks: [1, 2] }]), blocks)).toEqual({
        cards: [
          { title: 'Rent', blockIds: ['p0', 'p2'] },
          { title: 'Ferry', blockIds: ['p1'] },
        ],
      });
    });

    it('drops a number outside the first 40 blocks, a card with no title or no block, and a card past the sixth', () => {
      const read = readSplit(
        answer([
          { title: 'Kept', blocks: [1, 41, 0, 2.5] },
          { title: '  ', blocks: [2] },
          { title: 'No block', blocks: [] },
          ...[3, 4, 5, 6, 7, 8].map((n) => ({ title: `Card ${n}`, blocks: [n] })),
        ]),
        blocks,
      );

      expect(read).toMatchObject({ cards: expect.any(Array) });
      const cards = (read as { cards: { title: string; blockIds: string[] }[] }).cards;
      expect(cards).toHaveLength(6);
      expect(cards[0]).toEqual({ title: 'Kept', blockIds: ['p0'] });
    });

    it('makes a title one line of at most 200 characters', () => {
      const read = readSplit(answer([{ title: `Two\nlines ${'x'.repeat(300)}`, blocks: [1] }]), blocks) as { cards: { title: string }[] };

      expect(read.cards[0]!.title).not.toMatch(/\n/);
      expect(read.cards[0]!.title.length).toBeLessThanOrEqual(200);
    });

    it.each([
      ['text that is not JSON', 'nope'],
      ['JSON that is not a language and items', JSON.stringify({ items: 'x' })],
      ['no usable card', answer([{ title: '', blocks: [1] }])],
      ['nothing at all', undefined],
    ])('discards %s, which leaves one card in the dialog', (_what, raw) => {
      expect(readSplit(raw, blocks)).toHaveProperty('discarded');
    });
  });
});
