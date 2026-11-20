import type { Item } from '@cockpit/shared';

/**
 * A parent's story ("Brainstorming: a parent's description goes stale as
 * children join or leave", issue 1827): what Claude writes a description from,
 * and what happens to what it writes.
 */

/** The most children a rewrite reads: the first ones in the parent's order, so a parent of 400 costs what one of 50 does. */
export const STORY_CHILDREN_READ = 50;

/** The most of one child's title or description a rewrite reads. */
export const STORY_CHILD_TEXT_READ = 1_000;

/** The most of the parent's own description a rewrite reads, as the voice it is written in. */
export const STORY_PARENT_TEXT_READ = 2_000;

/** One child as a rewrite reads it. */
export interface StoryChild {
  title: string;
  description: string | null;
}

/** Cut to `max` characters, never between the halves of one. */
export function cutForStory(text: string, max: number): string {
  if (text.length <= max) return text;
  const lead = text.charCodeAt(max - 1);
  return text.slice(0, lead >= 0xd800 && lead <= 0xdbff ? max - 1 : max);
}

/**
 * The children a rewrite reads: the first `STORY_CHILDREN_READ` in the order
 * given, each with its title and description cut to `STORY_CHILD_TEXT_READ`
 * characters. What was left out is counted, so the prompt can say so.
 */
export function childrenForStory(children: readonly StoryChild[]): { read: StoryChild[]; leftOut: number } {
  const read = children.slice(0, STORY_CHILDREN_READ).map((child) => ({
    title: cutForStory(child.title, STORY_CHILD_TEXT_READ),
    description: child.description === null ? null : cutForStory(child.description, STORY_CHILD_TEXT_READ),
  }));
  return { read, leftOut: Math.max(0, children.length - read.length) };
}

/**
 * What a rewrite does with Claude's text, by whose the description is: still
 * Claude's (`textsSettledAt` null) it is replaced silently, and once it is
 * yours it is kept and the text waits as a proposal for a Review. Null where
 * there is nothing to do - the text is what the description already says, or
 * what already waits.
 *
 * `updatedAt` is left where it is, for the reason `applyProposedTexts` gives.
 */
export function applyProposedStory(item: Item, story: string, at: string): Item | null {
  if (item.textsSettledAt === null) {
    if (item.description === story && !item.storyProposal) return null;
    return { ...item, description: story, storyProposal: null, storyProposedAt: null };
  }
  if (item.description === story) {
    // The person's own words already say it: nothing to review, and a Review left waiting is moot.
    return item.storyProposal ? { ...item, storyProposal: null, storyProposedAt: null } : null;
  }
  if (item.storyProposal === story) return null;
  return { ...item, storyProposal: story, storyProposedAt: at };
}

/** *Use it*: Claude's version is the description, and it stays the person's. Null where no Review waits. */
export function applyUseStory(item: Item): Item | null {
  if (!item.storyProposal) return null;
  return { ...item, description: item.storyProposal, storyProposal: null, storyProposedAt: null };
}

/** *Keep mine*: Claude's version is dropped. Null where no Review waits. */
export function applyKeepMyStory(item: Item): Item | null {
  if (!item.storyProposal) return null;
  return { ...item, storyProposal: null, storyProposedAt: null };
}
