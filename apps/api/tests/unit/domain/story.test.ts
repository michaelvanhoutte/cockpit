import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import { captureItem } from '../../../src/domain/items.js';
import { applyKeepMyStory, applyProposedStory, applyUseStory, childrenForStory } from '../../../src/domain/story.js';
import { renderStoryBrief } from '../../../src/ai/prompts/write-a-story.v1.js';
import { readStory } from '../../../src/ai/story-text.js';

const MADE = '2026-11-19T10:00:00.000Z';
const LATER = '2026-11-19T10:05:00.000Z';

function aParent(overrides: Partial<Item> = {}): Item {
  return {
    ...captureItem(
      { commandId: '018f0000-0000-7000-8000-000000000001', workspaceId: 'ws-work', issuedAt: MADE, itemId: '018f0000-0000-7000-8000-000000000002', message: 'Chapter 3' },
      'tenant-default',
    ),
    description: 'Three notes about the crossing.',
    keepsStory: true,
    ...overrides,
  };
}

describe('Triage', () => {
  describe('a story Claude writes replaces a description that is still Claude\'s and waits as a Review once it is yours', () => {
    const situations: { situation: string; item: Item; becomes: Partial<Item> | null }[] = [
      {
        situation: 'a description nobody has edited is replaced',
        item: aParent(),
        becomes: { description: 'The crossing, now with the storm.', storyProposal: null },
      },
      {
        situation: 'a description you edited is kept and the new version waits',
        item: aParent({ textsSettledAt: MADE }),
        becomes: { description: 'Three notes about the crossing.', storyProposal: 'The crossing, now with the storm.', storyProposedAt: LATER },
      },
      {
        situation: 'a new version replaces the one already waiting',
        item: aParent({ textsSettledAt: MADE, storyProposal: 'An older version.', storyProposedAt: MADE }),
        becomes: { storyProposal: 'The crossing, now with the storm.', storyProposedAt: LATER },
      },
      {
        situation: 'a story the description already says changes nothing',
        item: aParent({ description: 'The crossing, now with the storm.' }),
        becomes: null,
      },
      {
        situation: 'a version already waiting, said again, changes nothing',
        item: aParent({ textsSettledAt: MADE, storyProposal: 'The crossing, now with the storm.', storyProposedAt: MADE }),
        becomes: null,
      },
      {
        situation: 'a story that says what your own description says takes a waiting Review away',
        item: aParent({ textsSettledAt: MADE, description: 'The crossing, now with the storm.', storyProposal: 'An older version.', storyProposedAt: MADE }),
        becomes: { description: 'The crossing, now with the storm.', storyProposal: null, storyProposedAt: null },
      },
    ];

    it.each(situations)('$situation', ({ item, becomes }) => {
      const written = applyProposedStory(item, 'The crossing, now with the storm.', LATER);

      if (becomes === null) expect(written).toBeNull();
      else expect(written).toMatchObject(becomes);
    });

    it('never moves what makes the texts yours or the clock other changes are measured against', () => {
      const proposed = applyProposedStory(aParent(), 'A new story.', LATER)!;
      const waiting = applyProposedStory(aParent({ textsSettledAt: MADE }), 'A new story.', LATER)!;

      expect(proposed).toMatchObject({ textsSettledAt: null, updatedAt: MADE });
      expect(waiting).toMatchObject({ textsSettledAt: MADE, updatedAt: MADE });
    });
  });

  describe('Use it makes Claude\'s version the description and Keep mine drops it', () => {
    const waiting = aParent({ textsSettledAt: MADE, storyProposal: 'Claude\'s version.', storyProposedAt: MADE });

    it('Use it replaces the description, which stays yours, and clears the Review', () => {
      expect(applyUseStory(waiting)).toMatchObject({ description: 'Claude\'s version.', textsSettledAt: MADE, storyProposal: null, storyProposedAt: null });
    });

    it('Keep mine leaves the description and clears the Review', () => {
      expect(applyKeepMyStory(waiting)).toMatchObject({ description: 'Three notes about the crossing.', textsSettledAt: MADE, storyProposal: null, storyProposedAt: null });
    });

    it('either one answered again, or with no Review waiting, changes nothing', () => {
      expect(applyUseStory(aParent())).toBeNull();
      expect(applyKeepMyStory(aParent())).toBeNull();
    });
  });

  describe('a rewrite reads at most 50 children, each cut to 1,000 characters', () => {
    const many = (count: number, text = 'x') => Array.from({ length: count }, (_, at) => ({ title: `${text}${at}`, description: text.repeat(3) }));

    it('reads the first 50 in their order and counts the ones left out', () => {
      const { read, leftOut } = childrenForStory(many(57));

      expect(read).toHaveLength(50);
      expect(read[0]!.title).toBe('x0');
      expect(read.at(-1)!.title).toBe('x49');
      expect(leftOut).toBe(7);
    });

    it('cuts a title and a description to 1,000 characters, never between the halves of one', () => {
      const long = 'a'.repeat(999) + '😀' + 'b'.repeat(50);
      const { read } = childrenForStory([{ title: long, description: long }, { title: 'short', description: null }]);

      expect(read[0]!.title).toBe('a'.repeat(999));
      expect(read[0]!.description).toBe('a'.repeat(999));
      expect(childrenForStory([{ title: 'c'.repeat(1_500), description: 'd'.repeat(1_500) }]).read[0]).toEqual({ title: 'c'.repeat(1_000), description: 'd'.repeat(1_000) });
      expect(read[1]).toEqual({ title: 'short', description: null });
    });

    it('sends the model no more than that, whatever it is handed', () => {
      const brief = renderStoryBrief({ title: 'Chapter 3', description: null, children: many(80, 'q'), held: 80 });

      expect(brief.match(/^\d+\. title:/gm)).toHaveLength(50);
      expect(brief).toContain('(the first 50 of 80)');
    });
  });

  describe('what Claude answers is a story, or nothing is changed', () => {
    it.each([
      { situation: 'a language and a story', answer: JSON.stringify({ language: 'English', story: ' Three notes about the crossing. ' }), read: { story: 'Three notes about the crossing.' } },
      { situation: 'text that is not JSON', answer: 'Sure! Here is a story', read: { discarded: 'the answer was not JSON' } },
      { situation: 'an answer with no story in it', answer: JSON.stringify({ language: 'English' }), read: { discarded: 'the answer was not a language and a story' } },
      { situation: 'an empty story', answer: JSON.stringify({ language: 'English', story: '  ' }), read: { discarded: 'the story was empty' } },
      { situation: 'a story that runs on past a description\'s worth', answer: JSON.stringify({ language: 'English', story: 'a'.repeat(4_001) }), read: { discarded: 'the story was too long' } },
      { situation: 'no answer at all', answer: undefined, read: { discarded: 'the answer carried no text' } },
    ])('$situation', ({ answer, read }) => {
      expect(readStory(answer)).toEqual(read);
    });
  });
});
