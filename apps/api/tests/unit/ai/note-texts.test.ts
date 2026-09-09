import { describe, expect, it } from 'vitest';
import { readProposal } from '../../../src/ai/note-texts.js';

/**
 * L1: reading an answer back is a pure decision over a string, so every way an
 * answer can be unusable is provable here with no model in the room. What is
 * *done* about it - the Item keeping the mechanical title capture wrote - is
 * one level up, in apps/api/tests/integration/http/note-cleanup.test.ts.
 *
 * The answers below are the shapes a model can really produce, not invented
 * ones: text that is not JSON at all, a field left out, and a title handed
 * back unshortened, which is the failure that decided the model this runs on.
 */

const usable = JSON.stringify({
  language: 'English',
  title: 'Ask Novy about the Part 11 audit trail',
  message: 'A question about the Part 11 audit trail for the validation protocol.',
});

describe('Capture', () => {
  describe('a reading Cockpit cannot use is thrown away rather than tidied up', () => {
    const tooLongForATitle = 'x'.repeat(201);

    it.each([
      { situation: 'the answer carried no text at all', answer: undefined },
      { situation: 'the answer was prose rather than an answer', answer: 'Here is a title for you.' },
      { situation: 'the answer was JSON but not an answer', answer: '{"headline":"Novy"}' },
      {
        situation: 'the language was not named',
        answer: JSON.stringify({ title: 'Novy', message: 'Ring Novy.' }),
      },
      {
        situation: 'the title was the whole note handed back',
        answer: JSON.stringify({ language: 'English', title: tooLongForATitle, message: 'Ring Novy.' }),
      },
      {
        situation: 'the title ran over two lines',
        answer: JSON.stringify({ language: 'English', title: 'Novy\ncall', message: 'Ring Novy.' }),
      },
      {
        situation: 'the title said nothing',
        answer: JSON.stringify({ language: 'English', title: '   ', message: 'Ring Novy.' }),
      },
      {
        situation: 'the message said nothing',
        answer: JSON.stringify({ language: 'English', title: 'Novy', message: '' }),
      },
    ])('says why it was thrown away when $situation', ({ answer }) => {
      const read = readProposal(answer);

      expect(read).not.toHaveProperty('proposal');
      // The reason is the only place the difference between these is visible,
      // every one of them leaving the Item exactly as capture wrote it.
      expect('discarded' in read && read.discarded.length > 0).toBe(true);
    });

    it('keeps a usable reading exactly as it came, including the language it named', () => {
      expect(readProposal(usable)).toEqual({
        proposal: {
          language: 'English',
          title: 'Ask Novy about the Part 11 audit trail',
          message: 'A question about the Part 11 audit trail for the validation protocol.',
        },
      });
    });

    /**
     * A title of exactly the cap is usable and one character more is not, which
     * is the boundary the whole check turns on - and it is the same cap the
     * Item's own form enforces, so a reading Cockpit accepts is one a person
     * could have typed.
     */
    it('accepts a title as long as the form allows and refuses one longer', () => {
      const atTheCap = 'x'.repeat(200);

      expect(
        readProposal(JSON.stringify({ language: 'Dutch', title: atTheCap, message: 'Bellen.' })),
      ).toHaveProperty('proposal');
      expect(
        readProposal(JSON.stringify({ language: 'Dutch', title: `${atTheCap}x`, message: 'Bellen.' })),
      ).not.toHaveProperty('proposal');
    });
  });
});
