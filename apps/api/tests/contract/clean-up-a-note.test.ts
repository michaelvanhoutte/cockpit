import { describe, expect, it } from 'vitest';
import { ClaudeAiService } from '../../src/ai/index.js';
import { CLEAN_UP_A_NOTE } from '../../src/ai/prompts/clean-up-a-note.v1.js';

/**
 * The contract tier: the real Claude API, the real prompt, no fake anywhere
 * (docs/testing-strategy.md, "Third parties"). **Scheduled, never on a pull
 * request** - every case spends money and takes as long as the model does, and
 * the fakes one tier down are what every other test runs against.
 *
 * What only this tier can prove: that the prompt still gets the two behaviours
 * out of the model that it was written to get. Both were measured failing
 * before it existed ("Clean up a captured note into a clear title and a fuller
 * message", issue 296) - a note answered in the wrong language, and a model
 * filling in a fact the note never carried - and neither is provable against a
 * fake, which answers whatever the test told it to.
 *
 * A failure here is the model or the prompt having drifted apart, and fixing it
 * is priority work. It is never fixed by running it again.
 */

const key = process.env.ANTHROPIC_API_KEY ?? '';
const reading = new ClaudeAiService(key, process.env.ANTHROPIC_WORKSPACE_ID || undefined);

/** Words that only appear in one of the two languages, in prose of this length. */
const MARKERS = {
  English: /\b(the|and|about|which|with)\b/i,
  Dutch: /\b(de|het|een|niet|van|voor|over|naar)\b/i,
};

async function read(note: string) {
  const answer = await reading.cleanUpNote(note);
  // Said out loud, because a discarded answer is the one failure whose reason
  // is otherwise only in the logs of a scheduled run nobody was watching.
  if (!('proposal' in answer)) throw new Error(`nothing usable came back: ${answer.discarded}`);
  return answer.proposal;
}

describe('Capture', () => {
  it('has a key to read a note with', () => {
    // Red rather than skipped: a contract run with no credential is a run that
    // proved nothing, and a skipped tier reads green from the outside.
    expect(key, 'set ANTHROPIC_API_KEY, or put it in apps/api/.dev.vars').not.toBe('');
  });

  /**
   * The rule the prompt was rewritten for. An instruction not to translate was
   * measured turning roughly one English note in three into Dutch, because the
   * prompt's own examples are in both languages and the model matched them
   * rather than the note; naming the language as the first field is the fix,
   * and this is what says the fix still holds.
   */
  describe('a note is read back in the language it was written in', () => {
    it.each([
      {
        situation: 'an English note',
        note: 'part 11 audit trail q for validation protocol, who signs off eod',
        expected: 'English' as const,
      },
      {
        situation: 'a Dutch note',
        note: 'bellen novy ivm afspraak volgende week, niet voor 10u',
        expected: 'Dutch' as const,
      },
      {
        situation: 'a note written mostly in Dutch with an English phrase in it',
        note: 'check of de deploy erdoor is voor de release van morgen',
        expected: 'Dutch' as const,
      },
    ])('answers $situation in its own language', async ({ note, expected }) => {
      const proposal = await read(note);

      expect(proposal.language).toContain(expected);
      const other = expected === 'English' ? 'Dutch' : 'English';
      // The named language is the model's own claim, so the texts are checked
      // as well: the failure being guarded against wrote fluent Dutch under the
      // heading "English".
      expect(proposal.message).toMatch(MARKERS[expected]);
      expect(proposal.message).not.toMatch(MARKERS[other]);
      expect(proposal.title).not.toMatch(MARKERS[other]);
    });
  });

  /**
   * The rule that outranks the rest. A note is a record of what somebody
   * actually said, so a message that quietly supplies the missing name, day or
   * number is worse than the clipped line it replaced.
   *
   * Checked as "nothing that was not there" rather than as "the right words",
   * because the second is a judgement and the first is not: every number in the
   * answer has to be one the note carried, and each note names the invention it
   * most invites.
   */
  describe('nothing is added to a note that the note did not contain', () => {
    it.each([
      {
        situation: 'a note that never says who or when',
        note: 'audit trail q for validation protocol, who signs off',
        absent: [/monday|tuesday|wednesday|thursday|friday/i, /\bQA\b/, /manager/i],
      },
      {
        situation: 'a note that names a thing it never identifies',
        note: 'mail anna re invoice, she asked twice already',
        absent: [/\b(january|february|march|april|may|june|july)\b/i, /€|\$|EUR/],
      },
    ])('invents no name, date or number for $situation', async ({ note, absent }) => {
      const proposal = await read(note);
      const written = `${proposal.title} ${proposal.message}`;

      for (const invention of absent) expect(written).not.toMatch(invention);

      // And every number in the answer is one the note had: numbers are the
      // one class of invention that can be checked exhaustively rather than
      // guessed at.
      for (const number of written.match(/\d+/g) ?? []) {
        expect(note).toContain(number);
      }
    });
  });

  /**
   * The failure that decided the model. A cheaper one was measured handing the
   * captured note straight back as the title, unshortened, on half the notes it
   * was given - which is the one thing this whole feature exists to stop.
   */
  describe('a note gets a title shorter than the note itself', () => {
    it('does not hand a long note back as its own title', async () => {
      const note =
        'part 11 audit trail q for validation protocol, who signs off eod, and check whether the ' +
        'change control from last month covers it or whether we need a new one before the audit';

      const proposal = await read(note);

      expect(proposal.title.length).toBeLessThan(note.length / 2);
      expect(proposal.message.length).toBeGreaterThan(proposal.title.length);
      expect(CLEAN_UP_A_NOTE.version).toBe('v1');
    });
  });
});
