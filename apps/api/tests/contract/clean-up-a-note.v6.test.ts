import { describe, expect, it } from 'vitest';
import { ClaudeAiService } from '../../src/ai/index.js';
import { TITLE_LENGTH } from '@cockpit/shared';
import { buildCleanUpANote, TITLE_TARGET } from '../../src/ai/prompts/clean-up-a-note.v6.js';
import type { DecisionHistoryEntry } from '../../src/domain/decision-history.js';

/**
 * The contract tier: the real Claude API, the real prompt, no fake anywhere
 * (docs/testing-strategy.md, "Third parties"). **Scheduled, never on a pull
 * request** - every case spends money and takes as long as the model does, and
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
 * file them", issue 299), and - measured against 29 notes with the texts
 * their author would have written - a title at the storage cap naming the
 * note rather than the work, and a hedge about unstated detail that not one
 * of those 29 contains ("Propose a title that names the work, not the note",
 * issue 391) - and none of it is provable against a fake, which answers
 * whatever the test told it to.
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
 * Every way the two texts can talk about the note instead of doing the work -
 * naming it, or announcing what it leaves unsaid.
 *
 * **One list for two rules, because a hedge is a sentence about the note.**
 * `v5` instructed the model to write exactly these ("say that the note does
 * not say which"); `v6` drops that instruction, and this is what says it
 * stopped happening rather than merely stopped being asked for.
 */
const TALKS_ABOUT_THE_NOTE = [
  /\b(the|this) note\b/i,
  /\b(de|deze) notitie\b/i,
  /\b(does|do)(n't| not) (say|specify|state|mention)\b/i,
  /\b(unspecified|unstated|unnamed|not specified|not stated|not mentioned)\b/i,
  /\bzegt niet\b/i,
  /\b(niet gespecificeerd|niet vermeld|niet genoemd|niet duidelijk welke)\b/i,
];

/** A text that reports an observation rather than being one. */
const REPORTS_RATHER_THAN_INSTRUCTS =
  /^(a|an|the|this)\s+(note|observation|opinion|view|remark|comment|message|reminder)\b/i;

/**
 * Reads one note, and none of the notes below is one the prompt carries.
 *
 * **That is the whole difference between testing the model and testing its
 * recall.** The prompt has six worked examples with their answers written
 * out, so a case that reuses one of them can be passed by copying the example -
 * and the drift this tier exists to catch would sail through, since a note it
 * has been shown the answer to is not a note it had to decide anything about.
 *
 * `panels` defaults to none, for every case that is not itself about routing:
 * a note being read for its title and message is not made more or less
 * ambiguous by what panels happen to exist. `history`, `recentlyCaptured` and
 * `correction` default to none for the same reason - nothing below is about
 * them unless a case names them.
 */
async function read(
  note: string,
  panels: readonly { id: string; name: string }[] = [],
  history: readonly DecisionHistoryEntry[] = [],
  recentlyCaptured: readonly string[] = [],
  correction: string | null = null,
) {
  const answer = await reading.cleanUpNote(note, panels, history, recentlyCaptured, correction);
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
   * The length rule ("Propose a title that names the work, not the note",
   * issue 391). `v5` gave the model one number, the 200-character storage cap,
   * and got titles written towards it; the wanted titles run 17-55 characters
   * from notes averaging 92 (docs/text-learning.md, "What is wrong today").
   *
   * **`TITLE_TARGET` is asserted as a ceiling because that is how the prompt
   * states it.** "About 50" is not a testable instruction, so the prompt asks
   * for 50 or fewer and this holds it to exactly that - the two move together
   * or neither means anything.
   *
   * This replaces `v5`'s "a note gets a name of its own rather than being
   * handed back": a note handed back unshortened is a title longer than the
   * target, which the first case below fails on a tighter bound than "shorter
   * than the note" ever did.
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
      expect(buildCleanUpANote([], [], [], null).version).toBe('v6');
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
      for (const frame of TALKS_ABOUT_THE_NOTE) expect(proposal.message).not.toMatch(frame);
    });

    it('turns an opinion into an instruction to record it, not a report that it was held', async () => {
      const proposal = await read(
        'the release checklist has too many manual steps, we keep skipping half of them',
      );

      // An opinion is work to keep, not work to act on: "cut the manual steps"
      // would be a next step the note never asked for, which the rule below
      // this describe forbids outright.
      expect(`${proposal.title} ${proposal.message}`).toMatch(
        /\b(record|log|capture|keep|note down|write down|flag|raise)\b/i,
      );
      expect(proposal.message).not.toMatch(REPORTS_RATHER_THAN_INSTRUCTS);
      // The other half of the same failure: a report attributes the opinion to
      // somebody instead of writing it down as the thing to keep.
      expect(proposal.message).not.toMatch(/\b(the author|the writer|somebody|someone)\b/i);
      for (const frame of TALKS_ABOUT_THE_NOTE) expect(proposal.message).not.toMatch(frame);
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
      for (const frame of TALKS_ABOUT_THE_NOTE) expect(proposal.message).not.toMatch(frame);
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
      const answer = await reading.cleanUpNote('...!! 🙂', [], [], [], null);

      if (!('proposal' in answer)) {
        expect(answer.discarded.length).toBeGreaterThan(0);
        return;
      }
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

  /**
   * A compliance-flavoured note offered a panel plainly made for compliance
   * questions ("Propose where a captured note belongs, without filing it
   * there", issue 298) - the same shape the prompt's own worked example is,
   * deliberately neither the same note nor the same panel name as that
   * example (`clean-up-a-note.v6.ts`'s last example pairs "Compliance
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
   * The property the POC measured ("Learn where notes belong from where you
   * actually file them", issue 299): a correction changes the *next* proposal
   * for a note like the one that was corrected, without anybody telling the
   * model a rule. This is the whole reason the decision history exists rather
   * than a rule engine - the same shape of note offered nothing to name a
   * panel by itself, and would keep offering nothing without the correction
   * below to read.
   *
   * `COMPLIANCE_NOTE` from the describe above is deliberately not reused: a
   * note the panel-naming case already passed on its own would prove nothing
   * about the history mattering, since a plainly-compliance note might name
   * the panel unaided. `LAURENS_SHAPED_NOTE` is worded to fit either panel
   * equally - a genuine sign-off question that never says which team owns it -
   * so naming one over the other is a call the history alone can be driving.
   */
  describe('a proposal follows a correction recorded in the decision history', () => {
    const panels = [
      { id: '018f0000-0000-7000-8000-000000000003', name: 'Compliance questions' },
      { id: '018f0000-0000-7000-8000-000000000004', name: 'Laurens' },
    ];
    const LAURENS_SHAPED_NOTE = 'sign-off needed before we can close this out, who owns it';

    it('proposes the corrected panel for a similar note, after an override names it', async () => {
      const history: DecisionHistoryEntry[] = [
        {
          capturedMessage: 'part 11 audit trail q for validation protocol, who signs off eod',
          itemTitle: 'Part 11 audit trail question',
          proposedPanelId: panels[0]!.id,
          proposedPanelName: 'Compliance questions',
          proposedPanelReason: 'a compliance question, about the validation protocol',
          chosenPanelId: panels[1]!.id,
          chosenPanelName: 'Laurens',
          decidedAt: '2026-08-01T09:00:00.000Z',
        },
      ];

      const proposal = await read(LAURENS_SHAPED_NOTE, panels, history);

      expect(proposal.panel?.panelId).toBe(panels[1]!.id);
    });
  });

  /**
   * The property `write_routing_summary`/`set_routing_summary_correction`
   * exist for ("Show what the system learned, in a sentence you can
   * correct", issue 301): a person's own written correction steers a
   * proposal, on its own, with no matching entry in the decision history at
   * all - the history in this case is empty, so a pass here cannot be the
   * history-following case above under another name.
   */
  describe('a proposal follows a Workspace-level correction, with no matching history entry', () => {
    const panels = [
      { id: '018f0000-0000-7000-8000-000000000005', name: 'Compliance questions' },
      { id: '018f0000-0000-7000-8000-000000000006', name: 'Laurens' },
    ];
    const LAURENS_SHAPED_NOTE = 'sign-off needed before we can close this out, who owns it';

    it('proposes the panel the correction names, with an empty history', async () => {
      const correction =
        'Sign-off and audit-trail questions that do not name a specific person go to Laurens, not Compliance questions.';

      const proposal = await read(LAURENS_SHAPED_NOTE, panels, [], [], correction);

      expect(proposal.panel?.panelId).toBe(panels[1]!.id);
    });
  });
});
