import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeAiService, type CallFor, type ProposalRead } from '../../src/ai/index.js';

/** Whom these calls are for: nobody's, and no record is kept of them, the service being handed no recorder. */
const A_CONTRACT_RUN: CallFor = { accountName: 'contract-tests', itemId: null, triggeredBy: null };
import { TITLE_LENGTH } from '@cockpit/shared';
import { buildCleanUpANote, TITLE_TARGET } from '../../src/ai/prompts/clean-up-a-note.v11.js';
import type { DecisionHistoryEntry } from '../../src/domain/decision-history.js';
import type { TextCorrectionEntry, WhatStood } from '../../src/domain/text-corrections.js';

/**
 * The contract tier: the real Claude API, the real prompt, no fake anywhere
 * (docs/testing-strategy.md, "Third parties"). **Run on a pull request that
 * changes a prompt, and by hand, never on a schedule** - every case spends money and takes as long as the model does, and
 * the fakes one tier down are what every other test runs against.
 *
 * What only this tier can prove: that the prompt still gets the behaviours out
 * of the model that it was written to get. Every one of them was measured
 * failing before the prompt version that fixed it existed - a note answered in
 * the wrong language, a model filling in a fact the note never carried, a
 * model offering a reading for every note rather than the rare few that
 * genuinely support one ("Clean up a captured note into a clear title and a
 * fuller message", issue 296; "Offer the other readings when a captured note
 * says two things", issue 297), a model naming a panel for a note that fits
 * none of them ("Propose where a captured note belongs, without filing it
 * there", issue 298), a model that goes on repeating a proposal a person has
 * already corrected once ("Learn where notes belong from where you actually
 * file them", issue 299), a title at the storage cap naming the note rather
 * than the work, and a hedge about unstated detail that not one of 29 measured
 * notes contains ("Propose a title that names the work, not the note", issue
 * 391), and a proposal that keeps to general style rather than this person's
 * own vocabulary once a correction has shown it to it ("Learn how you write
 * from the titles you correct", issue 394) - and none of it is provable
 * against a fake, which answers whatever the test told it to.
 *
 * A failure here is the model or the prompt having drifted apart, and fixing it
 * is priority work. It is never fixed by running it again.
 */

const key = process.env.ANTHROPIC_API_KEY ?? '';

/**
 * A service whose calls are tallied under `name`, and said once at the end of
 * the run, so a prompt change can be priced from the same run that proved it
 * still holds - one per way of asking, since the two cost different amounts.
 */
function tallied(name: string): ClaudeAiService {
  // Cache reads and writes beside the uncached input, since what a call costs
  // turns on them ("Enable prompt caching on the note-cleanup prompt", issue 584).
  const spent = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  afterAll(() => console.log(`${name}: ${JSON.stringify(spent)}`));
  return new ClaudeAiService(key, process.env.ANTHROPIC_WORKSPACE_ID || undefined, (_model, usage) => {
    spent.calls += 1;
    spent.input += usage.input_tokens;
    spent.cacheRead += usage.cache_read_input_tokens ?? 0;
    spent.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    spent.output += usage.output_tokens;
  });
}
const reading = tallied('clean-up-a-note.v11 on capture');

const NO_STOOD: WhatStood | null = null;

/**
 * The call that writes a note's texts, on capture, where the same answer also
 * names a Panel. A correction no longer re-reads the rest of the inbox ("Cut
 * what cleaning up a captured note costs", issue 887), so this is the only way
 * a note's texts are written; it stays a table so every case below keeps its
 * place under it.
 */
const WAYS = [
  {
    situation: 'read on capture',
    ask: (note: string, corrections: readonly TextCorrectionEntry[]) =>
      reading.cleanUpNote(note, [], [], [], corrections, NO_STOOD, A_CONTRACT_RUN),
  },
];

/** `read` below, for one of `WAYS`. */
function readerFor(ask: (note: string, corrections: readonly TextCorrectionEntry[]) => Promise<ProposalRead>) {
  return async (note: string, corrections: readonly TextCorrectionEntry[] = []) => {
    const answer = await ask(note, corrections);
    if (!('proposal' in answer)) throw new Error(`nothing usable came back: ${answer.discarded}`);
    return answer.proposal;
  };
}

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
 * Every way the two texts can talk about the note instead of doing the work -
 * naming it, or announcing what it leaves unsaid.
 *
 * **One list for two rules, because a hedge is a sentence about the note.**
 * `v5` instructed the model to write exactly these ("say that the note does
 * not say which"); `v6` dropped that instruction, and this is what says it
 * stayed dropped.
 */
const TALKS_ABOUT_THE_NOTE = [
  /\b(the|this) note\b/i,
  /\b(de|deze) notitie\b/i,
  /\b(does|do)(n't| not) (say|specify|state|mention)\b/i,
  /\b(unspecified|unstated|unnamed|not specified|not stated|not mentioned)\b/i,
  /\bzegt niet\b/i,
  /\b(niet gespecificeerd|niet vermeld|niet genoemd|niet duidelijk welke)\b/i,
];

/**
 * A text that reports an observation rather than being one.
 *
 * **In both languages, because the answers are.** An English-only opener
 * cannot match a Dutch answer, and the prompt forbids translating - so a
 * Dutch case asserting this would have asserted nothing at all, while "Een
 * opmerking dat het team de notulen moet doorsturen" is exactly the register
 * failure it is here to catch.
 */
const REPORTS_RATHER_THAN_INSTRUCTS =
  /^(a|an|the|this|een|de|het|dit|deze)\s+(note|observation|opinion|view|remark|comment|message|reminder|notitie|opmerking|mening|bericht|herinnering|constatering|vaststelling)\b/i;

/**
 * Reads one note, and none of the notes below is one the prompt carries.
 *
 * **That is the whole difference between testing the model and testing its
 * recall.** The prompt has six worked examples with their answers written
 * out, so a case that reuses one of them can be passed by copying the example -
 * and the drift this tier exists to catch would sail through, since a note it
 * has been shown the answer to is not a note it had to decide anything about.
 *
 * `panels` defaults to none, for every case that is not itself about routing;
 * `history` and `recentlyCaptured` default to none for the same reason;
 * `corrections` and `stood` default to no evidence at all - nothing below is
 * about any of them unless a case names them.
 */
async function read(
  note: string,
  panels: readonly { id: string; name: string }[] = [],
  history: readonly DecisionHistoryEntry[] = [],
  recentlyCaptured: readonly string[] = [],
  corrections: readonly TextCorrectionEntry[] = [],
  stood: WhatStood | null = NO_STOOD,
) {
  const answer = await reading.cleanUpNote(note, panels, history, recentlyCaptured, corrections, stood, A_CONTRACT_RUN);
  // Said out loud, because a discarded answer is the one failure whose reason
  // is otherwise only in the logs of a scheduled run nobody was watching.
  if (!('proposal' in answer)) throw new Error(`nothing usable came back: ${answer.discarded}`);
  return answer.proposal;
}

const TWO_PANELS = [
  { id: '018f0000-0000-7000-8000-000000000005', name: 'Suppliers' },
  { id: '018f0000-0000-7000-8000-000000000006', name: 'Hiring' },
];

/** A full window of the decision history: 50 settled filings, alternating between two panels. */
function fiftyFilings(panels: readonly { id: string; name: string }[]): DecisionHistoryEntry[] {
  return Array.from({ length: 50 }, (_, i) => {
    const panel = panels[i % 2]!;
    return {
      capturedMessage: `${panel.name === 'Suppliers' ? 'leverancier' : 'kandidaat'} ${i} opvolgen`,
      itemTitle: `Follow up ${i}`,
      proposedPanelId: panel.id,
      proposedPanelName: panel.name,
      proposedPanelReason: `about ${panel.name.toLowerCase()}`,
      chosenPanelId: panel.id,
      chosenPanelName: panel.name,
      decidedAt: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T09:00:00.000Z`,
    };
  });
}

describe('Capture', () => {
  it('has a key to read a note with', () => {
    // Red rather than skipped: a contract run with no credential is a run that
    // proved nothing, and a skipped tier reads green from the outside.
    expect(key, 'set ANTHROPIC_API_KEY, or put it in apps/api/.dev.vars').not.toBe('');
  });

  describe.each(WAYS)('when a note is $situation', ({ ask }) => {
    const read = readerFor(ask);

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
     * The length rule ("Propose a title that names the work, not the note",
     * issue 391). `v5` gave the model one number, the 200-character storage cap,
     * and got titles written towards it; the wanted titles run 17-55 characters
     * from notes averaging 92 (docs/text-learning.md, "What is wrong today").
     *
     * **`TITLE_TARGET` is asserted as a ceiling because that is how the prompt
     * states it.** "About 50" is not a testable instruction, so the prompt asks
     * for 50 or fewer and this holds it to exactly that - the two move together
     * or neither means anything.
     */
    describe('a title names the work in as few words as it takes', () => {
      it('shortens a note of about ninety characters to a title at or under the target', async () => {
        const note =
          "cleaning validation sign-off still open, need to know if last month's change control covers it";
        // Under the storage cap, so handing it back whole would validate - which
        // is what makes this failure invisible to every tier below.
        expect(note.length).toBeLessThan(TITLE_LENGTH);

        const proposal = await read(note);

        expect(proposal.title.length).toBeLessThanOrEqual(TITLE_TARGET);
        expect(proposal.title).not.toBe(note);
        // This note carries more work than fits in a title, so the two texts are
        // not the same words twice. Asserted here and not as a general rule:
        // "Call Jan" is a correct answer to "call jan" under both fields.
        expect(proposal.message.length).toBeGreaterThan(proposal.title.length);
        // The cases in this file are only evidence about the version they ran
        // against, so the version is said out loud once.
        expect(buildCleanUpANote({ panels: [], history: [], recentlyCaptured: [] }, [], NO_STOOD).version).toBe('v11');
      });

      it('does not pad a note that is already shorter than the target', async () => {
        // Nothing here needs expanding - no abbreviation, no clipped sentence -
        // so a title longer than the note itself has had words put into it,
        // which the prompt forbids for a reason of its own.
        const note = 'factuur 2231 nog goedkeuren';
        expect(note.length).toBeLessThan(TITLE_TARGET);

        const proposal = await read(note);

        expect(proposal.title.length).toBeLessThanOrEqual(note.length);
      });

      /**
       * **The cap is asserted by `read` throwing, not by a line below it.**
       * `readProposal` refuses a title over `TITLE_LENGTH` or carrying a line
       * break, so a model that blows the cap on a note this long reaches this
       * case as a discarded proposal and a thrown error - and asserting the cap
       * again underneath that would be a line that cannot fail. What is left to
       * assert is the target, which a long note is where a model is likeliest
       * to miss.
       */
      it('answers a note far longer than the cap with one usable line', async () => {
        const note =
          'klant belde over de levering van vorige week, die is maar half aangekomen en de rest zou nog ' +
          'volgen, wil weten wanneer precies en of de factuur daarop aangepast wordt of dat we een ' +
          'creditnota sturen voor het ontbrekende deel';
        expect(note.length).toBeGreaterThan(TITLE_LENGTH);

        const proposal = await read(note);

        expect(proposal.title.length).toBeLessThanOrEqual(TITLE_TARGET);
      });
    });

    /**
     * The register rule ("Propose a title that names the work, not the note",
     * issue 391). `v5` asked for "the note written out as prose", and got prose
     * about the note; what was wanted is an instruction to do the thing.
     *
     * Each case asserts the failure it invites rather than the words a right
     * answer uses, for the reason a sibling case in this file was already found
     * to need: a title and a message are free-form prose in two languages, and
     * pinning an assertion to one phrasing fails correct answers.
     */
    describe('a description says what to do about the note, not what the note said', () => {
      it('turns a question into an instruction to go and answer it', async () => {
        const proposal = await read(
          'do we still need the separate onboarding checklist or can it fold into the handbook',
        );

        // The one case where the right answer's verb is genuinely constrained:
        // an open question becomes work to settle it, whatever the wording.
        // Asserted on the title and not on the two joined, because the title is
        // where the register was measured wrong - a noun phrase naming the note
        // rather than an imperative naming the work - and a message carrying the
        // verb would otherwise cover for a title that does not.
        expect(proposal.title).toMatch(
          /\b(check|verify|confirm|decide|determine|establish|review|assess|clarify|settle|find out|work out|figure out|look into|investigate)\b/i,
        );
        const written = `${proposal.title} ${proposal.message}`;
        for (const frame of TALKS_ABOUT_THE_NOTE) expect(written).not.toMatch(frame);
      });

      it('turns an opinion into an instruction to record it, not a report that it was held', async () => {
        const proposal = await read(
          'the release checklist has too many manual steps, we keep skipping half of them',
        );

        // An opinion is work to hold on to, not work to act on: "cut the manual
        // steps" would be a next step the note never asked for, which the rule
        // below this describe forbids outright.
        //
        // **No word of this list may appear in the note.** `keep` was in it and
        // the note says "we keep skipping half of them" - so a pure v5-style
        // restatement, echoing the note back, matched it and the case went green
        // on exactly the register it exists to reject.
        expect(`${proposal.title} ${proposal.message}`).toMatch(
          /\b(record|log|capture|note down|write down|flag|raise)\b/i,
        );
        expect(proposal.message).not.toMatch(REPORTS_RATHER_THAN_INSTRUCTS);
        // The other half of the same failure: a report attributes the opinion to
        // somebody instead of writing it down as the thing to hold on to.
        expect(proposal.message).not.toMatch(/\b(the author|the writer|somebody|someone)\b/i);
        const written = `${proposal.title} ${proposal.message}`;
        for (const frame of TALKS_ABOUT_THE_NOTE) expect(written).not.toMatch(frame);
      });

      it('carries a note that is already an instruction through as one', async () => {
        const note = 'stuur de notulen van dinsdag door naar het hele team';

        const proposal = await read(note);

        // Still the same work, rather than a sentence about a note that asked
        // for it - the verb the note came with survives, in the title as well as
        // in the message, which is the register half of this rule.
        expect(proposal.title).toMatch(/\b(stuur|sturen|doorsturen|versturen)\b/i);
        expect(proposal.message).toMatch(/\b(stuur|sturen|doorsturen|versturen)\b/i);
        expect(proposal.message).not.toMatch(REPORTS_RATHER_THAN_INSTRUCTS);
        const written = `${proposal.title} ${proposal.message}`;
        for (const frame of TALKS_ABOUT_THE_NOTE) expect(written).not.toMatch(frame);
      });
    });

    /**
     * `v10` ("Keep a note's formatting when Cockpit rewrites it", issue 756): a
     * note is Markdown, and the message keeps what it uses on the same words.
     * Only the model can prove it, so it is asserted here and nowhere lower.
     */
    describe('a note\'s formatting comes back on the same words', () => {
      it('bolds the same name', async () => {
        const proposal = await read('Ask **Jan** about the audit');

        expect(proposal.message).toContain('**Jan**');
      });

      it('keeps a two-item list as a list', async () => {
        // Asked five times, because a model that only sometimes joins the two
        // items into a sentence passes a single dispatch and fails the night it
        // does. One after another, so a rate limit cannot pass for drift.
        const messages: string[] = [];
        for (let pass = 0; pass < 5; pass += 1) {
          messages.push((await read('- order the new badges\n- book the room for the offsite')).message);
        }

        expect(messages.filter((message) => !/^\s*[-*] .+\n\s*[-*] /m.test(message))).toEqual([]);
      });

      it('links the same text to the same address', async () => {
        const proposal = await read('Read [the doc](https://x.test) before the call');

        expect(proposal.message).toContain('[the doc](https://x.test)');
      });

      it('keeps an italic word italic', async () => {
        const proposal = await read('Ask Jan whether the audit is *really* due on Friday');

        expect(proposal.message).toMatch(/(\*really\*|_really_)/);
      });
    });

    describe('a note without formatting gets none added', () => {
      it('comes back with no bold, headings or bullets', async () => {
        const proposal = await read(
          'Call Novy about the appointment next week. Not before ten in the morning.',
        );

        expect(proposal.message).not.toMatch(/\*|^#|^\s*[-*] |__/m);
      });
    });
    /**
     * The instruction that is gone ("Propose a title that names the work, not
     * the note", issue 391). `v5` told the model to say that the note does not
     * say which document, person or date it meant; across 29 notes with the
     * texts their author would have written, not one does that.
     *
     * Each note below refers to something it never fixes, which is exactly what
     * `v5` would have hedged about - and what the case under this one says must
     * not be filled in instead.
     */
    describe('neither text points out what the note does not say', () => {
      it.each([
        { situation: 'a document it never identifies', note: 'document moet nog naar de klant voor vrijdag' },
        { situation: 'a deadline it never fixes', note: 'dit moet af voor de audit' },
        { situation: 'no actor at all', note: 'sign-off needed on the cleaning validation' },
      ])('says nothing about the absence, for a note with $situation', async ({ note }) => {
        const proposal = await read(note);
        const written = `${proposal.title} ${proposal.message}`;

        for (const hedge of TALKS_ABOUT_THE_NOTE) expect(written).not.toMatch(hedge);
      });
    });

    /**
     * The rule that outranks the rest, and the guard on the one above it: a
     * model told to stop announcing what a note leaves out is a model invited to
     * fill it in instead. A note is a record of what somebody actually said, so
     * a message that quietly supplies the missing name, day or number is worse
     * than the clipped line it replaced.
     *
     * Checked as "nothing that was not there" rather than as "the right words",
     * because the second is a judgement and the first is not: every number in the
     * answer has to be one the note carried, and each note names the invention it
     * most invites.
     *
     * The first note is the one the describe above already read, deliberately:
     * not hedging and not inventing are the two halves of one risk, and only the
     * same note read for both says they hold together.
     */
    describe('nothing is added to a note that the note did not contain', () => {
      it.each([
        {
          situation: 'a note referring to a document it never names',
          note: 'document moet nog naar de klant voor vrijdag',
          absent: [/\b(offerte|contract|rapport|factuur|handleiding|bestek)\b/i, /€|\$|EUR/],
        },
        {
          situation: 'a note too terse to carry a reason or a date',
          note: 'terugbellen over de klacht',
          absent: [
            /\b(januari|februari|maart|april|juni|juli)\b/i,
            /\b(maandag|dinsdag|woensdag|donderdag|vrijdag)\b/i,
            /\b(omdat|zodat|because|so that)\b/i,
            /€|\$|EUR/,
          ],
        },
        {
          // `v5` read this note under this same rule, and it is the note the
          // hedge above most invites filling in: told not to say who is missing,
          // a model can name one instead.
          situation: 'a note that never says who or when',
          note: 'sign-off needed on the cleaning validation',
          absent: [/monday|tuesday|wednesday|thursday|friday/i, /\bQA\b/, /manager/i],
        },
      ])('invents no name, date, reason or number for $situation', async ({ note, absent }) => {
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
     * The floor under a shorter, sharper title: a note with almost nothing in it
     * must not be answered by inventing something to name. Either branch is a
     * pass, because `readProposal` discarding an unusable answer is the designed
     * behaviour and the Item keeps the mechanical title capture wrote.
     *
     * `read` is deliberately not used - it throws on a discard, which is the
     * outcome this case is here to allow.
     *
     * **The assertion is on what a proposal may contain, not that there is
     * one.** Non-empty, inside the cap and single-line are all `answerSchema`'s
     * doing, so asserting them here would be three lines that cannot fail; what
     * can fail is the model answering an empty note with something it made up.
     */
    describe('a note carrying almost nothing produces something usable or nothing at all', () => {
      it('answers a note of punctuation and emoji without inventing one, or with nothing', async () => {
        const answer = await ask('...!! 🙂', []);

        // A discard is a pass and there is nothing further to check on it: every
        // producer of that arm writes a non-empty reason, so asserting one here
        // would be the line this case's own comment argues against.
        if (!('proposal' in answer)) return;
        const written = `${answer.proposal.title} ${answer.proposal.message}`;
        // This note carries no digit, no weekday and no subject, so every one of
        // them in an answer is invented - the one class of invention a note this
        // empty lets a test check exhaustively.
        expect(written).not.toMatch(/\d/);
        expect(written).not.toMatch(
          /\b(monday|tuesday|wednesday|thursday|friday|maandag|dinsdag|woensdag|donderdag|vrijdag)\b/i,
        );
      });
    });

    /**
     * Ambiguity is meant to be rare ("Offer the other readings when a captured
     * note says two things", issue 297): a schema field that merely exists
     * invites filling it in, which is the same failure the language fix above
     * was written against - the model matching the shape of the prompt rather
     * than the note in front of it. This is what says the instruction not to
     * still holds.
     */
    describe('a note that is merely terse is not read as ambiguous', () => {
      it.each([
        { situation: 'a note with one clear subject', note: 'cal invite for the CAPA review, need the deviation nr first' },
        { situation: 'a note naming a thing it never identifies', note: 'terugbellen over de klacht, hij was er niet blij mee' },
        { situation: 'a note that is only short', note: 'sign-off needed on the cleaning validation, who owns it' },
      ])('offers no other reading for $situation', async ({ note }) => {
        const proposal = await read(note);
        expect(proposal.readings).toEqual([]);
      });
    });

    /**
     * The proof this feature rode in on, with the exact name the issue proved
     * it on (`jan`) deliberately not reused: `bel jan` names that pair verbatim
     * in this prompt's own instructions, and `call jan` is its fully worked-out
     * final example - a note built from either would pass by recall of text
     * already in the system prompt, not by the model reasoning about the note
     * in front of it (the same rule the notes above obey, stated in this file's
     * own class comment). `april` is the same shape of pun - a name that is
     * also, in full, a month, in both languages - and appears nowhere in the
     * prompt.
     *
     * Asked as "are these readings genuinely different" rather than "does one
     * say person and the other month", because the exact wording a correct
     * answer takes is not fixed: a title and a message are free-form prose, and
     * pinning the assertion to one phrasing a correct Dutch answer would not use
     * is the failure a sibling case in this file was found to have.
     */
    describe('a note that genuinely reads two ways offers more than the one', () => {
      it.each([
        { situation: 'an English note', note: 'call april' },
        { situation: 'a Dutch note', note: 'bel april' },
      ])('offers readings that are genuinely different from each other, for $situation', async ({ note }) => {
        const proposal = await read(note);

        // The main answer is one of the two readings, so the note supports at
        // least two total between the title and what `readings` adds.
        expect(proposal.readings.length).toBeGreaterThanOrEqual(1);
        const titles = [proposal.title, ...proposal.readings.map((r) => r.title)];
        expect(new Set(titles.map((title) => title.toLowerCase())).size).toBe(titles.length);
      });
    });
  });

  /**
   * A compliance-flavoured note offered a panel plainly made for compliance
   * questions ("Propose where a captured note belongs, without filing it
   * there", issue 298) - the same shape the prompt's own worked example is,
   * deliberately neither the same note nor the same panel name as that
   * example (`clean-up-a-note.v11.ts`'s last example pairs "Compliance
   * questions" with the Part 11 audit trail note). A pass on the exact note
   * and panel name the prompt was shown the answer to would prove recall
   * rather than generalisation - the failure this tier exists to catch, per
   * this file's own class comment. Panel ids are ordinary UUIDs here, exactly
   * the shape a real account's are, so a pass here is not proving something a
   * shorter id would not.
   */
  describe('a note is offered the panel it clearly belongs on, where one does', () => {
    const panels = [
      { id: '018f0000-0000-7000-8000-000000000001', name: 'Regulatory questions' },
      { id: '018f0000-0000-7000-8000-000000000002', name: 'Weekend ideas' },
    ];
    const COMPLIANCE_NOTE = 'gdpr data retention policy needs sign-off before next month’s audit';

    it('names the panel and says why, in terms of the note rather than of itself', async () => {
      const proposal = await read(COMPLIANCE_NOTE, panels);

      expect(proposal.panel?.panelId).toBe(panels[0]!.id);
      expect(proposal.panel?.reason.length).toBeGreaterThan(0);
      // The reason reads as an explanation of the note, not a report of what a
      // model did - "I chose this because" is the failure this line guards.
      expect(proposal.panel?.reason.toLowerCase()).not.toContain('i chose');
      expect(proposal.panel?.reason.toLowerCase()).not.toContain('model');
    });

    /**
     * Proposing nothing is the common, right answer for most notes ("Propose
     * where a captured note belongs, without filing it there", issue 298) -
     * checked here rather than assumed, because a schema field that exists
     * invites filling it in, the exact failure "a note that is merely terse
     * is not read as ambiguous" above already guards for `readings`.
     */
    it('proposes nothing for a note that fits none of the panels offered', async () => {
      const proposal = await read('milk, eggs, bread - stop on the way home', panels);
      expect(proposal.panel).toBeNull();
    });

    it('never names a panel it was not offered', async () => {
      const proposal = await read(COMPLIANCE_NOTE, panels);
      if (proposal.panel) {
        expect(panels.map((panel) => panel.id)).toContain(proposal.panel.panelId);
      }
    });
  });

  /**
   * **Not held on capture: "a proposal follows a correction recorded in the
   * decision history".** On Sonnet 5.5 a note that fits either panel, after
   * one loosely similar filing overrode a proposal, gets no panel, five times
   * out of five: it wants more evidence from the history than one example
   * before it names a panel. Kept on Sonnet for its cost ("Cut what cleaning
   * up a captured note costs", issue 887). The same property is held where it
   * moves an Item afterwards, by the refresh a filing triggers
   * (`choose-a-panel.v2.test.ts`).
   */

  describe.each(WAYS)('when a note is $situation', ({ ask }) => {
    const read = readerFor(ask);

    /**
     * The property this whole file's newest describe exists for ("Learn how you
     * write from the titles you correct", issue 394): a correction shows the
     * model this person's own vocabulary, not a rule stated in words - the same
     * shape "a proposal follows a correction recorded in the decision history"
     * above already proves for which Panel a note belongs on.
     *
     * `NOVY_SHAPED_NOTE` deliberately reuses the note's own subject (a person
     * named Novy) rather than a fresh one, so a title that comes back with this
     * account's own past spelling of that name is unambiguous evidence the
     * correction was read, not a coincidence of the model's own judgement -
     * nothing in the general prompt could otherwise motivate this exact
     * spelling.
     */
    describe('a proposal uses the vocabulary this account has corrected into its titles before', () => {
      it('spells a name the way this account has always corrected it to, not the way the note spells it', async () => {
        const NOVY_SHAPED_NOTE = 'novi bellen over levering volgende week';
        const corrections: TextCorrectionEntry[] = [
          {
            itemId: 'item-1',
            capturedMessage: 'novi bellen over de afspraak maandag',
            proposedTitle: 'Novi bellen over de afspraak maandag',
            proposedDescription: null,
            settledTitle: 'Novy bellen over de afspraak maandag',
            settledDescription: null,
            recordedAt: '2026-08-01T09:00:00.000Z',
          },
          {
            itemId: 'item-2',
            capturedMessage: 'novi mailen ivm factuur',
            proposedTitle: 'Novi mailen in verband met de factuur',
            proposedDescription: null,
            settledTitle: 'Novy mailen in verband met de factuur',
            settledDescription: null,
            recordedAt: '2026-08-05T09:00:00.000Z',
          },
        ];

        const proposal = await read(NOVY_SHAPED_NOTE, corrections);

        expect(proposal.title).toMatch(/\bNovy\b/);
        expect(proposal.title).not.toMatch(/\bNovi\b/i);
      });
    });

    /**
     * The corrections section outranks the general guidance "on vocabulary and
     * length", stated in exactly those words for the reason this case exists:
     * an earlier version said corrections outrank the guidance with no scope
     * limit, which read as licensing the language rule and the no-invention
     * rule to bend too - the same failure `v5`'s translation regression
     * measured at roughly one English note in three (this file's first
     * describe block). Dutch-worded corrections are the sharpest test of
     * exactly that: nothing about them should read as permission to answer an
     * English note in Dutch.
     */
    describe('a correction never licenses breaking the language rule or inventing detail', () => {
      it('answers an English note in English, even with Dutch-worded corrections on record', async () => {
        const corrections: TextCorrectionEntry[] = [
          {
            itemId: 'item-1',
            capturedMessage: 'bel novy over de afspraak',
            proposedTitle: 'Call Novy about the appointment',
            proposedDescription: null,
            settledTitle: 'Novy bellen over de afspraak',
            settledDescription: null,
            recordedAt: '2026-08-01T09:00:00.000Z',
          },
        ];

        const proposal = await read(
          'cal invite for the CAPA review, need the deviation nr first',
          corrections,
        );

        expect(proposal.language).toContain('English');
        expect(proposal.title).not.toMatch(MARKERS.Dutch);
        expect(proposal.message).not.toMatch(MARKERS.Dutch);
      });
    });
  });

  /**
   * What only the real API can say ("Enable prompt caching on the
   * note-cleanup prompt, restructured so the fixed content is a stable
   * prefix", issue 584): a request that asks for its fixed half to be kept and
   * one that gets it kept answer identically, so the usage the API reports is
   * the only evidence the second happened. The two notes differ, as a real
   * account's back-to-back captures do; their account, and so their panels,
   * does not. Both ways of asking are held to it, since each sends a fixed half
   * of its own.
   */
  describe('notes read back to back for one account pay the full rate for the fixed instructions only once', () => {
    it('reads the fixed instructions back at the lower rate on the second of two notes', async () => {
      const usages: Anthropic.Usage[] = [];
      const service = new ClaudeAiService(key, process.env.ANTHROPIC_WORKSPACE_ID || undefined, (_model, usage) => {
        usages.push(usage);
      });

      expect('proposal' in (await service.cleanUpNote('offerte leverancier nog aftekenen', [], [], [], [], NO_STOOD, A_CONTRACT_RUN))).toBe(true);
      expect('proposal' in (await service.cleanUpNote('book the room for the CAPA review', [], [], [], [], NO_STOOD, A_CONTRACT_RUN))).toBe(true);

      expect(usages[1]!.cache_read_input_tokens ?? 0).toBeGreaterThan(0);
    });

    /**
     * "Cut what cleaning up a captured note costs" (issue 887): the history and
     * the corrections are cached beside the instructions, so what the second
     * note pays the full rate for is its own few lines and the recently
     * captured notes. The history is what makes the prefix large, so a second
     * note that read only the instructions back would still be paying for most
     * of the prompt, and would fail the last assertion.
     */
    it('reads the history back at the lower rate too, paying the full rate only for the note and the recent notes', async () => {
      const usages: Anthropic.Usage[] = [];
      const service = new ClaudeAiService(key, process.env.ANTHROPIC_WORKSPACE_ID || undefined, (_model, usage) => {
        usages.push(usage);
      });
      const history = fiftyFilings(TWO_PANELS);

      expect('proposal' in (await service.cleanUpNote('offerte leverancier nog aftekenen', TWO_PANELS, history, ['still waiting'], [], NO_STOOD, A_CONTRACT_RUN))).toBe(true);
      expect('proposal' in (await service.cleanUpNote('book the room for the CAPA review', TWO_PANELS, history, ['and another'], [], NO_STOOD, A_CONTRACT_RUN))).toBe(true);

      const first = usages[0]!;
      const second = usages[1]!;
      const read = second.cache_read_input_tokens ?? 0;
      expect(read).toBeGreaterThanOrEqual((first.cache_creation_input_tokens ?? 0) + (first.cache_read_input_tokens ?? 0));
      expect(second.input_tokens).toBeLessThan(read / 4);
    });
  });

  /**
   * The upper end of what a real account hands this prompt: the decision
   * history is capped at 50 entries ("Cap the routing prompt to the last 50
   * decisions on panels that still exist, and drop the correction override",
   * issue 450), so a full window is the largest the per-account half after
   * the cached instructions gets. Answered at all is the property - `read`
   * throws on anything that will not parse or validate.
   */
  describe('an account with a full decision history still gets a usable proposal', () => {
    it('answers with a proposal when fifty past filings ride along with the note', async () => {
      await read('factuur van de leverancier klopt niet, nakijken', TWO_PANELS, fiftyFilings(TWO_PANELS));
    });
  });
});
