import { describe, expect, it } from 'vitest';
import { ClaudeAiService } from '../../src/ai/index.js';
import { TITLE_LENGTH } from '@cockpit/shared';
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

/**
 * Words that exist in one of the two languages and not the other, so a text can
 * be read as one or the other without a detector.
 *
 * **Each one has to be absent from the other language, not merely typical of
 * its own**, because these are asserted both ways. `over` and `van` were in the
 * Dutch list and are ordinary English words - "a question over the audit trail"
 * would have failed a correct English answer, on a nightly run that costs money
 * and whose failures are meant to be priority work rather than re-run.
 */
const MARKERS = {
  English: /\b(the|and|about|which|with)\b/i,
  Dutch: /\b(de|het|een|niet|voor|naar|zegt)\b/i,
};

/**
 * Reads one note, and none of the notes below is one the prompt carries.
 *
 * **That is the whole difference between testing the model and testing its
 * recall.** The prompt has three worked examples with their answers written
 * out, so a case that reuses one of them can be passed by copying the example -
 * and the drift this tier exists to catch would sail through, since a note it
 * has been shown the answer to is not a note it had to decide anything about.
 */
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
        note: 'cal invite for the CAPA review, need the deviation nr first',
        expected: 'English' as const,
        onlyIts: true,
      },
      {
        situation: 'a Dutch note',
        note: 'factuur leverancier nakijken, btw-nummer klopt volgens mij niet',
        expected: 'Dutch' as const,
        onlyIts: true,
      },
      {
        situation: 'a note that genuinely mixes the two',
        note: 'even nakijken of de backup gelukt is before the release tonight',
        expected: 'Dutch' as const,
        // A note that mixes them may keep a phrase of the other, which is right
        // rather than a translation - so this case asks only that it stayed in
        // its own language, not that the other is absent.
        onlyIts: false,
      },
    ])('answers $situation in its own language', async ({ note, expected, onlyIts }) => {
      const proposal = await read(note);

      expect(proposal.language).toContain(expected);
      // The named language is the model's own claim, so the texts are checked
      // as well: the failure being guarded against wrote fluent Dutch under the
      // heading "English".
      expect(proposal.message).toMatch(MARKERS[expected]);
      if (onlyIts) {
        const other = expected === 'English' ? 'Dutch' : 'English';
        expect(proposal.message).not.toMatch(MARKERS[other]);
        expect(proposal.title).not.toMatch(MARKERS[other]);
      }
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
        note: 'sign-off needed on the cleaning validation, who owns it',
        absent: [/monday|tuesday|wednesday|thursday|friday/i, /\bQA\b/, /manager/i],
      },
      {
        situation: 'a note that names a thing it never identifies',
        note: 'terugbellen over de klacht, hij was er niet blij mee',
        absent: [/\b(januari|februari|maart|april|juni|juli)\b/i, /€|\$|EUR/],
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
  describe('a note gets a name of its own rather than being handed back', () => {
    /**
     * **The note is deliberately short enough to be a legal title**, so handing
     * it back would validate and nothing below this tier would notice. That is
     * exactly the failure measured on a cheaper model: it returned the captured
     * note as the title, unshortened, on half the notes it was given.
     *
     * **Asserted as a property and not as a ratio.** "Under half the length"
     * was tried and is a tolerance rather than a rule - a perfectly good
     * 86-character title for a 171-character note failed it - and a threshold
     * picked to fit today's answer proves nothing about tomorrow's.
     */
    it('answers with a title that is not the note, and a message longer than it', async () => {
      const note =
        'sign-off needed on the cleaning validation, who owns it, and check whether the change ' +
        'control from last month already covers it or whether we have to raise a new one first';
      // A title this long is one the form would accept, which is what makes the
      // failure invisible to every tier below.
      expect(note.length).toBeLessThan(TITLE_LENGTH);

      const proposal = await read(note);

      expect(proposal.title).not.toBe(note);
      expect(proposal.title.length).toBeLessThan(note.length);
      // A name and a fuller text, rather than the same words twice.
      expect(proposal.message.length).toBeGreaterThan(proposal.title.length);
      expect(CLEAN_UP_A_NOTE.version).toBe('v1');
    });
  });
});
