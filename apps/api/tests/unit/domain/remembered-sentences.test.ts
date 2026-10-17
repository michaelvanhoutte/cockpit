import { describe, expect, it } from 'vitest';
import { REMEMBERED_SENTENCES_SHOWN } from '@cockpit/shared';
import { sentencesThatFit, type RememberedSentence } from '../../../src/domain/remembered-sentences.js';

/**
 * L1: which remembered sentences a proposal is shown ("Remember an edit as a
 * sentence you confirm", issue 1163).
 */

const sentence = (over: Partial<RememberedSentence> & { id: string }): RememberedSentence => ({
  sentence: `sentence ${over.id}`,
  action: 'reply to a mail',
  workspaceId: null,
  sourceKind: 'gmail',
  useCount: 0,
  createdAt: '2026-10-17T10:00:00.000Z',
  ...over,
});

describe('Agents', () => {
  describe('a remembered sentence shapes the proposals it fits, and only those', () => {
    it.each([
      { situation: 'a mail sentence for the same kind of mail', one: { sourceKind: 'gmail' }, item: { sourceKind: 'gmail', workspaceId: 'a' }, fits: true },
      { situation: 'a mail sentence for another kind of source', one: { sourceKind: 'gmail' }, item: { sourceKind: 'teams', workspaceId: 'a' }, fits: false },
      { situation: 'a sentence for every workspace, for an Item in one', one: { workspaceId: null }, item: { sourceKind: 'gmail', workspaceId: 'a' }, fits: true },
      { situation: 'a sentence for every workspace, for an Item in none yet', one: { workspaceId: null }, item: { sourceKind: 'gmail', workspaceId: null }, fits: true },
      { situation: 'a sentence naming the Item’s workspace', one: { workspaceId: 'a' }, item: { sourceKind: 'gmail', workspaceId: 'a' }, fits: true },
      { situation: 'a sentence naming another workspace', one: { workspaceId: 'b' }, item: { sourceKind: 'gmail', workspaceId: 'a' }, fits: false },
      { situation: 'a sentence naming a workspace, for an Item in none yet', one: { workspaceId: 'a' }, item: { sourceKind: 'gmail', workspaceId: null }, fits: false },
    ])('$situation', ({ one, item, fits }) => {
      expect(sentencesThatFit(item, [sentence({ id: '1', ...one })]).length).toBe(fits ? 1 : 0);
    });

    it('shows the most used first, a tie going to the newer', () => {
      const shown = sentencesThatFit({ sourceKind: 'gmail', workspaceId: null }, [
        sentence({ id: 'old', createdAt: '2026-10-01T10:00:00.000Z' }),
        sentence({ id: 'used', useCount: 3, createdAt: '2026-09-01T10:00:00.000Z' }),
        sentence({ id: 'new', createdAt: '2026-10-10T10:00:00.000Z' }),
      ]);

      expect(shown.map((one) => one.id)).toEqual(['used', 'new', 'old']);
    });

    it('shows no more than the bound', () => {
      const many = Array.from({ length: REMEMBERED_SENTENCES_SHOWN + 5 }, (_, at) => sentence({ id: String(at) }));

      expect(sentencesThatFit({ sourceKind: 'gmail', workspaceId: null }, many)).toHaveLength(REMEMBERED_SENTENCES_SHOWN);
    });
  });
});
