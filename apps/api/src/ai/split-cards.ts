import { z } from 'zod';
import { SPLIT_BLOCKS_READ, SPLIT_ITEMS_PROPOSED, TITLE_LENGTH, type SplitBlock, type SplitCard } from '@cockpit/shared';

/**
 * Reading what the model proposed as a split ("Brainstorming: a note holding
 * several ideas can't be taken apart", issue 1828). Pure and apart from the
 * call, as `story-text.ts` is: every way an answer can be unusable ends in no
 * proposal, which the dialog meets as one card holding every block.
 */

/** The cards proposed, or why Claude proposed none - which changes nothing but what the dialog first draws. */
export type SplitProposed = { cards: SplitCard[] } | { discarded: string };

const answerShape = z.object({
  language: z.string(),
  items: z.array(z.object({ title: z.string(), blocks: z.array(z.number()) })),
});

/**
 * **Held to what was offered**: a block number outside the blocks shown, or one
 * already in an earlier card, is dropped; a card is at most `SPLIT_ITEMS_PROPOSED`
 * and names only the first `SPLIT_BLOCKS_READ` blocks; a title is one line of at
 * most `TITLE_LENGTH`, and a card with no title or no block is dropped.
 */
export function readSplit(raw: unknown, blocks: readonly SplitBlock[]): SplitProposed {
  if (typeof raw !== 'string') return { discarded: 'the answer carried no text' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { discarded: 'the answer was not JSON' };
  }
  const answer = answerShape.safeParse(parsed);
  if (!answer.success) return { discarded: 'the answer was not a language and items' };
  const shown = blocks.slice(0, SPLIT_BLOCKS_READ);
  const taken = new Set<number>();
  const cards: SplitCard[] = [];
  for (const proposed of answer.data.items) {
    if (cards.length === SPLIT_ITEMS_PROPOSED) break;
    const title = proposed.title.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, TITLE_LENGTH).trim();
    const numbers = proposed.blocks.filter((n) => Number.isInteger(n) && n >= 1 && n <= shown.length && !taken.has(n));
    if (title === '' || numbers.length === 0) continue;
    for (const n of numbers) taken.add(n);
    cards.push({ title, blockIds: [...new Set(numbers)].sort((a, b) => a - b).map((n) => shown[n - 1]!.id) });
  }
  if (cards.length === 0) return { discarded: 'the answer proposed no item' };
  return { cards };
}
