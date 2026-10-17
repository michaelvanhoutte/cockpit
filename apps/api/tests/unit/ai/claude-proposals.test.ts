import { describe, expect, it } from 'vitest';
import { readClaudeProposals } from '../../../src/ai/claude-proposals.js';

/**
 * L1: reading what the model proposed doing with an Item is a pure decision over
 * a string ("Propose what to do with each item before you look", issue 1161).
 * What is done with it - written onto the Item, or the Item keeping none - is one
 * level up, in apps/api/tests/integration/http/claude-proposals.test.ts.
 */

const FOLDERS = ['C:\\GitHub\\Cockpit', '/home/me/site'];

/** One proposal in the answer's own flat shape, every field present. */
function said(fields: Partial<Record<'destination' | 'label' | 'folder' | 'prompt' | 'why', string>>) {
  return { destination: 'cowork', label: 'Draft the reply', folder: '', prompt: 'Draft a reply to Els.', why: '', ...fields };
}

const answer = (...proposals: object[]) => JSON.stringify({ proposals });

describe('Agents', () => {
  describe('an answer becomes a proposal only if it fits; otherwise the Item keeps none', () => {
    it('keeps one Cowork proposal with its folder and prompt', () => {
      expect(readClaudeProposals(answer(said({ folder: '2' })), FOLDERS)).toEqual({
        proposals: [{ destination: 'cowork', label: 'Draft the reply', folder: '/home/me/site', prompt: 'Draft a reply to Els.' }],
      });
    });

    it('keeps two proposals, in the order given', () => {
      const read = readClaudeProposals(
        answer(said({ destination: 'code', label: 'Fix it', folder: '1', prompt: 'Fix the bug.' }), said({})),
        FOLDERS,
      );

      expect('proposals' in read && read.proposals.map((one) => one.destination)).toEqual(['code', 'cowork']);
    });

    it('reads "nothing" as a proposal of nothing, not an empty prompt', () => {
      const read = readClaudeProposals(
        answer(said({ destination: 'nothing', label: '', prompt: '', why: 'A quote to keep.' })),
        FOLDERS,
      );

      expect(read).toEqual({ proposals: [{ destination: 'nothing', why: 'A quote to keep.' }] });
    });

    it.each([
      { situation: 'a destination other than Cowork or Code', text: answer(said({ destination: 'slack' })) },
      { situation: 'an empty prompt', text: answer(said({ prompt: '   ' })) },
      { situation: 'nothing with no reason', text: answer(said({ destination: 'nothing', prompt: '', why: '' })) },
      { situation: 'nothing beside an action', text: answer(said({}), said({ destination: 'nothing', why: 'No.' })) },
      { situation: 'more than three actions', text: answer(said({}), said({}), said({}), said({})) },
      { situation: 'no proposal at all', text: answer() },
      { situation: 'a folder it was not offered', text: answer(said({ folder: '3' })) },
      { situation: 'a folder by its path rather than its number', text: answer(said({ folder: 'C:\\GitHub\\Cockpit' })) },
      { situation: 'a field left out', text: JSON.stringify({ proposals: [{ destination: 'cowork', prompt: 'Do it.' }] }) },
      { situation: 'text that is not JSON', text: 'I would send this to Cowork.' },
      { situation: 'no text at all', text: undefined },
    ])('keeps none for $situation', ({ text }) => {
      expect(readClaudeProposals(text, FOLDERS)).toHaveProperty('discarded');
    });
  });
});
