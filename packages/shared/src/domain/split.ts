import type { Addition } from './addition.js';
import type { Attachment } from './attachment.js';
import type { Item } from './item.js';

/**
 * *Split* ("Brainstorming: a note holding several ideas can't be taken apart",
 * issue 1828): an Item's words and files read as blocks, which the dialog draws
 * at once and Claude proposes cards for. The dialog and the store both read
 * the blocks through `splitBlocksOf`, so a block id means the same text on both
 * sides and a command names blocks, never carries their words.
 */

/** The most blocks Claude is shown; the rest are drawn and stay in the original until you drag them. */
export const SPLIT_BLOCKS_READ = 40;

/** The most Items Claude proposes. */
export const SPLIT_ITEMS_PROPOSED = 6;

/** The most Items one Split makes: what Claude proposed and what you added. */
export const SPLIT_ITEMS_AT_ONCE = 20;

/** How much of one block Claude reads: enough to tell what it is about. */
export const SPLIT_BLOCK_TEXT_READ = 1_000;

export type SplitBlock =
  | { id: string; kind: 'paragraph'; text: string }
  | { id: string; kind: 'addition'; text: string; createdAt: string }
  | { id: string; kind: 'attachment'; text: string; contentType: string };

/** What the words of an Item are cut into: one paragraph per blank line. */
export function paragraphsOf(description: string | null): string[] {
  return (description ?? '')
    .split(/\n\s*\n/)
    .map((text) => text.trim())
    .filter((text) => text !== '');
}

/** The paragraphs, the Additions in the order they were made, then the files: the order the dialog draws them in. */
export function splitBlocksOf(
  item: Pick<Item, 'description'>,
  additions: readonly Pick<Addition, 'id' | 'message' | 'createdAt'>[],
  attachments: readonly Pick<Attachment, 'id' | 'filename' | 'contentType'>[],
): SplitBlock[] {
  return [
    ...paragraphsOf(item.description).map((text, n): SplitBlock => ({ id: `p${n}`, kind: 'paragraph', text })),
    ...[...additions]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .filter((addition) => addition.message.trim() !== '')
      .map((addition): SplitBlock => ({ id: `a-${addition.id}`, kind: 'addition', text: addition.message.trim(), createdAt: addition.createdAt })),
    ...attachments.map((file): SplitBlock => ({ id: `f-${file.id}`, kind: 'attachment', text: file.filename, contentType: file.contentType })),
  ];
}

/** One card Claude proposes: the name of a new Item and the blocks that go in it. */
export interface SplitCard {
  title: string;
  blockIds: string[];
}

/**
 * What the proposal route answers. `cards` is null where Claude could not be
 * asked or wrote nothing usable, and the dialog then draws one card holding
 * every block.
 */
export interface SplitProposal {
  cards: SplitCard[] | null;
}

/**
 * The description a new Item holds from the blocks that went into it: its
 * paragraphs in the order they are drawn, one blank line apart. An Addition or
 * a file moves to it as it is, and is never written out here.
 */
export function wordsOfBlocks(blocks: readonly SplitBlock[]): string {
  return blocks
    .filter((block) => block.kind === 'paragraph')
    .map((block) => block.text)
    .join('\n\n');
}
