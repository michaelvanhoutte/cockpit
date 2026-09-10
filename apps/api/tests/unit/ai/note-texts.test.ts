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
  readings: [],
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
      const read = readProposal(answer, []);

      expect(read).not.toHaveProperty('proposal');
      // The reason is the only place the difference between these is visible,
      // every one of them leaving the Item exactly as capture wrote it.
      expect('discarded' in read && read.discarded.length > 0).toBe(true);
    });

    it('keeps a usable reading exactly as it came, including the language it named', () => {
      expect(readProposal(usable, [])).toEqual({
        proposal: {
          language: 'English',
          title: 'Ask Novy about the Part 11 audit trail',
          message: 'A question about the Part 11 audit trail for the validation protocol.',
          readings: [],
          panel: null,
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
        readProposal(
          JSON.stringify({ language: 'Dutch', title: atTheCap, message: 'Bellen.', readings: [] }),
          [],
        ),
      ).toHaveProperty('proposal');
      expect(
        readProposal(
          JSON.stringify({ language: 'Dutch', title: `${atTheCap}x`, message: 'Bellen.', readings: [] }),
          [],
        ),
      ).not.toHaveProperty('proposal');
    });
  });

  /**
   * "Offer the other readings when a captured note says two things" (issue
   * 297): each one stands or falls on its own, and the count offered is
   * whatever survives - never repaired up or down to a fixed number.
   */
  describe('a reading that would not fit the two boxes it would land in is dropped, not the whole answer', () => {
    const answer = (readings: unknown[]) =>
      JSON.stringify({
        language: 'English',
        title: 'Call Jan',
        message: 'Ring Jan.',
        readings,
      });

    it('keeps a reading whose title and meaning are both usable, message included', () => {
      const read = readProposal(
        answer([{ title: 'Call in January', message: '', meaning: "'jan' is short for January" }]),
        [],
      );

      expect(read).toEqual({
        proposal: {
          language: 'English',
          title: 'Call Jan',
          message: 'Ring Jan.',
          readings: [
            { title: 'Call in January', message: '', meaning: "'jan' is short for January" },
          ],
          panel: null,
        },
      });
    });

    it.each([
      {
        situation: 'its title is the note handed back unshortened',
        reading: { title: 'x'.repeat(201), message: '', meaning: 'too long to name the note' },
      },
      {
        situation: 'its title runs over two lines',
        reading: { title: 'Call\nJan', message: '', meaning: 'broken over two lines' },
      },
      {
        situation: 'it says nothing about what it means',
        reading: { title: 'Call in January', message: '', meaning: '' },
      },
    ])('drops a reading where $situation, keeping the rest', ({ reading }) => {
      const usable = { title: 'Call Jan (person)', message: '', meaning: "'jan' is a person's name" };

      const read = readProposal(answer([reading, usable]), []);

      expect('proposal' in read && read.proposal.readings).toEqual([usable]);
    });

    it('reports none where the model found only the one reading', () => {
      const read = readProposal(answer([]), []);

      expect('proposal' in read && read.proposal.readings).toEqual([]);
    });

    /**
     * The rarer ask riding on this call must not make the one it is already
     * relied on fragile. Checked as "no readings field at all" and "readings
     * is not even an array" - the two shapes a `readings` gone wrong could
     * actually take - rather than only the well-formed empty list above.
     */
    it.each([
      {
        situation: 'the field was left out entirely',
        answer: JSON.stringify({ language: 'English', title: 'Call Jan', message: 'Ring Jan.' }),
      },
      {
        situation: 'the field was not an array',
        answer: JSON.stringify({
          language: 'English',
          title: 'Call Jan',
          message: 'Ring Jan.',
          readings: 'none',
        }),
      },
    ])('still cleans up the note when $situation', ({ answer: malformed }) => {
      const read = readProposal(malformed, []);

      expect(read).toEqual({
        proposal: {
          language: 'English',
          title: 'Call Jan',
          message: 'Ring Jan.',
          readings: [],
          panel: null,
        },
      });
    });
  });

  /**
   * "Propose where a captured note belongs, without filing it there" (issue
   * 298): a panel proposal riding on this same call must not make the two
   * texts it is already relied on fragile, the same rule `readings` above
   * already obeys - and the panel itself is read no less strictly than a
   * reading is, plus one check neither text needs: an id the call did not
   * actually offer is never trusted back ("Never trust a panel id back").
   */
  describe('a panel proposal is read no less strictly, and never trusted back', () => {
    const answer = (panel: unknown) =>
      JSON.stringify({
        language: 'English',
        title: 'Part 11 audit trail question',
        message: 'A question about the Part 11 audit trail.',
        readings: [],
        panel,
      });

    it('keeps a panel proposal whose id was genuinely offered', () => {
      const read = readProposal(
        answer({ panelId: 'panel-1', reason: "it's a compliance question" }),
        ['panel-1', 'panel-2'],
      );

      expect('proposal' in read && read.proposal.panel).toEqual({
        panelId: 'panel-1',
        reason: "it's a compliance question",
      });
    });

    it.each([
      { situation: 'the empty string - the model proposing nothing', panelId: '' },
      { situation: 'an id never offered on this call', panelId: 'panel-9' },
    ])('reads $situation as no proposal, leaving the texts untouched', ({ panelId }) => {
      const read = readProposal(answer({ panelId, reason: 'a reason' }), ['panel-1', 'panel-2']);

      expect('proposal' in read && read.proposal.panel).toBeNull();
      expect('proposal' in read && read.proposal.title).toBe('Part 11 audit trail question');
    });

    /**
     * `reason` is required and non-empty the same way a reading's `meaning`
     * is: a proposal that would not say why is not a proposal, and there is
     * no runtime check of the command's own schema between this and the
     * store for a self-sent command (`propose_item_panel` is never posted
     * through `commandSchemas`), so this read is the only place that rule is
     * actually enforced.
     */
    it('reads a named panel with no reason as no proposal', () => {
      const read = readProposal(answer({ panelId: 'panel-1', reason: '' }), ['panel-1']);

      expect('proposal' in read && read.proposal.panel).toBeNull();
    });

    it.each([
      { situation: 'the field was left out entirely', panel: undefined },
      { situation: 'the field was not an object', panel: 'panel-1' },
      { situation: 'the field had no reason at all', panel: { panelId: 'panel-1' } },
    ])('still cleans up the note when $situation', ({ panel }) => {
      const raw = panel === undefined
        ? JSON.stringify({
            language: 'English',
            title: 'Part 11 audit trail question',
            message: 'A question about the Part 11 audit trail.',
            readings: [],
          })
        : answer(panel);

      const read = readProposal(raw, ['panel-1']);

      expect(read).toEqual({
        proposal: {
          language: 'English',
          title: 'Part 11 audit trail question',
          message: 'A question about the Part 11 audit trail.',
          readings: [],
          panel: null,
        },
      });
    });
  });
});
