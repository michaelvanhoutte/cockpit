import { describe, expect, it } from 'vitest';
import { ACCOUNT_WIDE, type RememberedSentenceList, type RememberedSentenceView } from '@cockpit/shared';
import type { CommandArgs } from '../../src/api/queries';
import { sentencesDrawnOver } from '../../src/rememberedSentencesDrawnAhead';

/**
 * F1: what each sentence change draws over the list the server sent. That the
 * controls send them, and that the window draws the result, is
 * tests/unit/components/SentencesAtOnce.test.tsx; when they stop being drawn is
 * tests/unit/changeQueue.test.ts.
 */

const AT = '2026-10-21T09:00:00.000Z';
const A = '018f0000-0000-7000-8000-0000000000a1';
const B = '018f0000-0000-7000-8000-0000000000a2';
const C = '018f0000-0000-7000-8000-0000000000a3';

const sentence = (over: Partial<RememberedSentenceView> & { id: string }): RememberedSentenceView => ({
  sentence: `Sentence ${over.id}`,
  action: 'reply to a mail',
  sourceKind: 'gmail',
  workspaceId: null,
  workspaceName: null,
  useCount: 2,
  lastUsedAt: '2026-10-20T09:00:00.000Z',
  createdAt: '2026-10-16T10:00:00.000Z',
  ...over,
});

const held: RememberedSentenceList = { sentences: [sentence({ id: A, sentence: 'Sign as Michael.' }), sentence({ id: B, sentence: 'Dutch, short.' })] };
const over = sentencesDrawnOver((id) => (id === 'ws-work' ? 'Work' : undefined));

const remembered = (sentenceId: string, words: string, workspaceId = ACCOUNT_WIDE): CommandArgs => ({
  name: 'remember_sentence',
  payload: { commandId: `c-${sentenceId}`, issuedAt: AT, workspaceId, sentenceId, sentence: words, action: 'reply to a mail', sourceKind: 'gmail' },
});
const reworded = (sentenceId: string, words: string): CommandArgs => ({
  name: 'edit_remembered_sentence',
  payload: { commandId: `c-edit-${sentenceId}`, issuedAt: AT, workspaceId: ACCOUNT_WIDE, sentenceId, sentence: words },
});
const forgotten = (sentenceId: string): CommandArgs => ({
  name: 'delete_remembered_sentence',
  payload: { commandId: `c-gone-${sentenceId}`, issuedAt: AT, workspaceId: ACCOUNT_WIDE, sentenceId },
});

const ids = (list: RememberedSentenceList) => list.sentences.map((one) => one.id);

describe('Agents', () => {
  describe('a sentence change is drawn as the server will have it', () => {
    it('puts a remembered sentence first, unused, and for every workspace unless it names one', () => {
      const everywhere = over(held, [remembered(C, 'Never promise a date.')]);

      expect(ids(everywhere)).toEqual([C, A, B]);
      expect(everywhere.sentences[0]).toMatchObject({
        sentence: 'Never promise a date.',
        action: 'reply to a mail',
        workspaceId: null,
        workspaceName: null,
        useCount: 0,
        lastUsedAt: null,
        createdAt: AT,
      });
      expect(over(held, [remembered(C, 'Never promise a date.', 'ws-work')]).sentences[0]).toMatchObject({
        workspaceId: 'ws-work',
        workspaceName: 'Work',
      });
    });

    it('draws a remembered sentence once, as the server keeps the same one once', () => {
      expect(ids(over(held, [remembered(A, 'Sign as Michael, again.')]))).toEqual([A, B]);
      expect(over(held, [remembered(A, 'Sign as Michael, again.')]).sentences[0]?.sentence).toBe('Sign as Michael.');
    });

    it('gives a reworded sentence its new words, as one line, and changes nothing else about it', () => {
      const drawn = over(held, [reworded(A, '  Sign as Michael.\n\nShort.  ')]);

      expect(drawn.sentences[0]).toEqual({ ...held.sentences[0], sentence: 'Sign as Michael. Short.' });
      expect(drawn.sentences[1]).toEqual(held.sentences[1]);
    });

    it('takes a forgotten sentence out of the list and leaves the others', () => {
      expect(ids(over(held, [forgotten(A)]))).toEqual([B]);
    });

    it('draws changes made one after the other in the order they were made', () => {
      const drawn = over(held, [remembered(C, 'First words.'), reworded(C, 'Second words.'), forgotten(A)]);

      expect(drawn.sentences.map((one) => [one.id, one.sentence])).toEqual([
        [C, 'Second words.'],
        [B, 'Dutch, short.'],
      ]);
    });

    it('never writes into the list the server sent', () => {
      const before = structuredClone(held);

      over(held, [remembered(C, 'New.'), reworded(A, 'Changed.'), forgotten(B)]);

      expect(held).toEqual(before);
    });

    it('leaves the list alone for a change that is not about a sentence', () => {
      const other = { name: 'set_priority', payload: { commandId: 'c', issuedAt: AT, workspaceId: 'ws-work', itemId: A, priority: 'high' } } as unknown as CommandArgs;

      expect(over(held, [other])).toEqual(held);
    });
  });
});
