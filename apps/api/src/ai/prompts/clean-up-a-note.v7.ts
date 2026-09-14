import { TITLE_LENGTH } from '@cockpit/shared';
import type { DecisionHistoryEntry } from '../../domain/decision-history.js';
import { correctionStillVisible, type TextCorrectionEntry, type WhatStood } from '../../domain/text-corrections.js';

/**
 * The length a title is written towards, as against `TITLE_LENGTH`, which is
 * what the form and the column will store. Measured: across 29 captured notes
 * with the titles their author would have written, those titles run 17-55
 * characters against notes averaging 92 (`docs/text-learning.md`, "What is
 * wrong today"), while `v5` asked only for "at most 200" and answered near it.
 *
 * **Asked for as a ceiling and never as a floor**, which is the only form of
 * it a test can hold the model to: "about 50" is not assertable, and half the
 * measured titles sit well under it anyway. A note with less to say gets a
 * shorter title, never one padded out to reach this.
 */
export const TITLE_TARGET = 50;

/**
 * What Cockpit asks Claude for when a note has been captured, version 7.
 * `v6` ("Propose a title that names the work, not the note", issue 391)
 * changed what is asked for; this version adds a new kind of evidence rather
 * than changing the ask - what this account has actually corrected, and how
 * many of its other proposals simply stood ("Learn how you write from the
 * titles you correct", issue 394; `docs/text-learning.md`).
 *
 * **The wanted titles use their author's own vocabulary, not the note's
 * words - the one thing no general prompt rewrite could supply**
 * (`docs/text-learning.md`, "What is wrong today"). `corrections` and `stood`
 * are that evidence: every text this account has actually corrected, oldest
 * first, and how many of the rest were simply accepted. Read per account,
 * not per Workspace - how you write is a property of you, not of which
 * Workspace a note landed in (`docs/text-learning.md`, "Scope: per
 * account").
 *
 * Nothing else moves: language, the other readings, the Panel proposal, the
 * routing history and the shape of `schema` are `v6`'s.
 */
export function buildCleanUpANote(
  panels: readonly { id: string; name: string }[],
  history: readonly DecisionHistoryEntry[],
  recentlyCaptured: readonly string[],
  correction: string | null,
  corrections: readonly TextCorrectionEntry[],
  stood: WhatStood,
): {
  version: 'v7';
  model: string;
  effort: 'low';
  system: string;
  schema: Record<string, unknown>;
} {
  const panelList =
    panels.length > 0
      ? panels.map((panel) => `- ${panel.id}: ${panel.name}`).join('\n')
      : '(this account has no panels yet)';

  return {
    version: 'v7',

    /**
     * Unchanged since `v1`, which measured a cheaper model handing the
     * captured note straight back as the title, unshortened, on half the
     * notes it was given - the one thing this whole feature exists to stop.
     * Asking for a shorter, imperative title is a harder judgement than
     * asking for a long one, not an easier one, so nothing here loosens with
     * `v7`. The contract tests are what would notice if that stopped being
     * true.
     */
    model: 'claude-opus-5',
    effort: 'low',

    system: `You are part of Cockpit, one person's inbox for their own work.

Somebody has just captured a note by typing or dictating it in a hurry, on a phone or in a car. What arrives is clipped, abbreviated, half-typed, unpunctuated, and often mixes English and Dutch in one line. You write two texts for it: a title naming the work it is asking for, and a message saying what to do about it that still makes sense to them in two weeks.

You may:
- expand an abbreviation the note itself uses
- correct spelling and punctuation
- finish a sentence the note leaves clipped
- put a dictated run of words into a readable order

You may not add anything the note does not contain. Not a fact, not a name, not a date, not a number, not a reason, and not a next step. Where the note refers to something it never states - a document, a person, a decision, a deadline - leave it exactly as the note left it: do not choose one, and do not say that the note never says which. Write what the note carries and stop there. If you are unsure whether something is in the note, it is not.

Neither text talks about the note. What lands in front of this person is a piece of their own work, not a report about something they typed, so never write "the note", "this note" or "de notitie" in either text.

The title names the work in the fewest words that could only be this note. Write it as an instruction - "Run only the impacted CI tests", "Novy bellen over de afspraak" - not as a label. One line, no line breaks, no trailing full stop, and never the whole note handed back unshortened.

Keep it to ${TITLE_TARGET} characters or fewer, and go well under that wherever the note carries less - a title is never padded out to reach a length. ${TITLE_LENGTH} characters is only what the form will store; it is not what to write towards.

The message says what to do about the note, written out in full sentences so it makes sense again in two weeks. It is an instruction too: the work the note is asking for, spelled out from what the note carries and nothing more. Where the note records an opinion or an observation rather than asking for something, the instruction is to record it. It is not a summary, not a report, and not a list of fields. Write no headings and no bullet points unless the note itself was a list.

Name the note's language first, in English, from the note alone - "English", "Dutch", or "English and Dutch" where the note genuinely mixes them. Then write the title and the message in that language. Never translate a note into another language, whatever language the examples below are in.

You are also given this account's own record of the titles and messages you have proposed before, and how they were received - the strongest evidence of this person's own vocabulary and length available, and it outranks the general guidance above on vocabulary and length wherever the two disagree. It never overrides the language rule above, and never licenses adding anything the note itself does not contain.

${renderCorrections(corrections)}

${renderWhatStood(stood)}

Some notes genuinely say two things at once - "bel jan" is either call Jan, a person, or call in January, the month; "review pricing with sales monday" could put the review or the pricing on Monday. Where that is true, list the other readings: for each, a title and a message exactly as you would write your main answer, and a few words saying what that reading takes the note to mean.

Almost every note has none. A note that is merely terse, or short, or missing detail is not ambiguous - it has one reading, and your main title and message are it. Only list another reading where the difference would change what somebody does about the note, and never more than two or three.

A reading's message may say nothing beyond what its title already says, where the note has nothing more to add - do not repeat the same message under two readings to fill the field.

You are also given the panels this account has already set up - buckets it files its own notes into, each named for what belongs there. Where this note clearly belongs on one of them, name its id and say in a few words why, about the note and the panel rather than about yourself - "a compliance question, about the validation protocol" rather than "I chose this because it mentions compliance". Most notes belong on none of them: a panel is not owed a note merely for being the closest match, and naming the wrong one costs more than naming none. Only name one where you are confident a person filing their own notes would put it there themselves.

Panels:
${panelList}

You are also given this account's own decision history: every note filed so far, oldest first, with what you proposed and what they actually chose. It is the only place learning happens here - there is no separate training step. Recent entries say what is live right now; older ones say how this person files in general, and both matter, but where they disagree favor the recent one - a project can go quiet for weeks and a habit from a year ago can still hold. Where an entry shows you proposed one panel and they filed it on another, that correction outweighs an entry where they simply accepted what you proposed - it names a wrong answer as well as a right one, so read it as the stronger signal.

${renderHistory(history)}

${renderCorrection(correction)}

You are also given what else has been captured in this workspace recently and not yet filed - separate from the history above, because none of it has been decided yet. It is still evidence: what somebody is writing notes about right now, before any of it has a destination. Weigh it alongside the history, never above it - an actual past decision is a stronger signal than a guess at a pattern in still-unfiled notes.

${renderRecentlyCaptured(recentlyCaptured)}

Examples.

Note: part 11 audit trail q for validation protocol, who signs off eod
language: English
title: Clarify who signs off the Part 11 audit trail
message: Find out who signs off on the Part 11 audit trail for the validation protocol, and have it clear by end of day.
readings: []
panel: (none of the panels offered clearly fit)

Note: bellen novy ivm afspraak volgende week, niet voor 10u
language: Dutch
title: Novy bellen over de afspraak van volgende week
message: Novy bellen in verband met de afspraak van volgende week. Niet voor 10 uur bellen.
readings: []
panel: (none of the panels offered clearly fit)

Note: check of de deploy erdoor is + mail naar Anna re invoice
language: English and Dutch
title: Deploy nakijken en Anna mailen over de factuur
message: Nakijken of de deploy erdoor is en daarna Anna mailen over de factuur.
readings: []
panel: (none of the panels offered clearly fit)

Note: standup is too long, half the room has nothing to say
language: English
title: Record that standup runs too long
message: Record that standup is too long and that half the room has nothing to say.
readings: []
panel: (none of the panels offered clearly fit)

Note: call jan
language: English
title: Call Jan
message: Call Jan.
readings:
- title: Call in January
  message:
  meaning: "'jan' is short for the month January"
panel: (none of the panels offered clearly fit)

Note: part 11 audit trail q for validation protocol, who signs off eod
(the first example above, once more, now that one of the panels offered is called "Compliance questions")
panel: Compliance questions, because it's a compliance question - Part 11 and the validation protocol`,

    /**
     * Unchanged in shape from `v6`: history, the correction, the two texts of
     * evidence above and recent captures are read material, not something the
     * answer reports back, so nothing here names any of them. `title` and
     * `message` say what they now ask for; `TITLE_LENGTH` stays the cap,
     * since the schema is what the Item's own two fields will accept and a
     * target has no place in it.
     */
    schema: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          description:
            'The language the note itself is written in, named in English, decided from the note alone and before writing either text.',
        },
        title: {
          type: 'string',
          description:
            `The work this note is asking for, named as an instruction on one line that could only be this note - at most ${TITLE_TARGET} characters, and never more than ${TITLE_LENGTH}, in the language named above.`,
        },
        message: {
          type: 'string',
          description:
            'What to do about the note, written out so it still makes sense in two weeks, adding nothing the note does not contain and never saying what the note leaves unsaid, in the language named above.',
        },
        readings: {
          type: 'array',
          description:
            'The other ways this note could genuinely be read, where the difference would change what somebody does about it. Empty for almost every note.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'This reading\'s title, exactly as the main title is written.',
              },
              message: {
                type: 'string',
                description:
                  'This reading\'s message, exactly as the main message is written - may be empty where there is nothing more to add beyond the title.',
              },
              meaning: {
                type: 'string',
                description: 'A few words saying what this reading takes the note to mean.',
              },
            },
            required: ['title', 'message', 'meaning'],
            additionalProperties: false,
          },
        },
        panel: {
          type: 'object',
          description:
            'Which of the panels listed above this note belongs on, or that none of them genuinely fits - the common case, and a real answer.',
          properties: {
            panelId: {
              type: 'string',
              enum: [...panels.map((panel) => panel.id), ''],
              description:
                'The id of the one panel this note clearly belongs on, copied exactly from the list above - or the empty string where none of them does.',
            },
            reason: {
              type: 'string',
              description:
                'A few words saying why, about the note and the panel rather than about yourself. Empty exactly when panelId is empty.',
            },
          },
          required: ['panelId', 'reason'],
          additionalProperties: false,
        },
      },
      required: ['language', 'title', 'message', 'readings', 'panel'],
      additionalProperties: false,
    },
  };
}

/**
 * Unchanged since `v4`.
 */
function renderHistory(history: readonly DecisionHistoryEntry[]): string {
  if (history.length === 0) return 'Decision history: (nothing filed yet)';

  const lines = history.map((entry) => {
    const date = entry.decidedAt.slice(0, 10);
    const note = entry.capturedMessage ?? entry.itemTitle;
    const outcome =
      entry.proposedPanelId === null
        ? `filed on ${entry.chosenPanelName} (nothing was proposed)`
        : entry.proposedPanelId === entry.chosenPanelId
          ? `filed on ${entry.chosenPanelName} (accepted the proposal)`
          : `you proposed ${entry.proposedPanelName}, but it was filed on ${entry.chosenPanelName} instead`;
    return `${date}: "${note}" — ${outcome}`;
  });

  return `Decision history, oldest first:\n${lines.join('\n')}`;
}

/**
 * The correction section, or a line saying none has been written - most
 * Workspaces have none yet, either because nobody has corrected the nightly
 * summary or because there is no summary yet to correct ("Show what the
 * system learned, in a sentence you can correct", issue 301).
 *
 * **Framed as outranking the history above it, not merely joining it.** A
 * correction is a person overriding what the system inferred on its own, in
 * their own words, which is a stronger and more direct signal than any
 * pattern read out of the history - the same reason an override entry in the
 * history itself outranks an accept.
 */
function renderCorrection(correction: string | null): string {
  if (correction === null) {
    return 'This person has not written a correction to what Cockpit has learned.';
  }
  return `This person has written the following correction to what Cockpit has learned about their filing patterns - treat it as the most direct signal available, ahead of any pattern read out of the history above: "${correction}"`;
}

/**
 * Unchanged since `v4`.
 */
function renderRecentlyCaptured(recentlyCaptured: readonly string[]): string {
  if (recentlyCaptured.length === 0) {
    return 'Recently captured, not yet filed: (nothing else waiting right now)';
  }

  const lines = recentlyCaptured.map((note) => `- "${note}"`);
  return `Recently captured, not yet filed, most recent first:\n${lines.join('\n')}`;
}

/**
 * The most recent `CORRECTIONS_LIMIT` corrections this account has ever made
 * to a proposed title or description, oldest first - a wrong answer named
 * beside the right one, so it is read as the stronger of the two kinds of
 * evidence `docs/text-learning.md` describes ("What goes into the prompt").
 *
 * **Capped here, in the render, not at the query.** `textCorrectionsForAccount`
 * (`repo.ts`) reads the whole table with no retrieval step, the same
 * convention `decisionHistoryForWorkspace` follows - this is where volume is
 * bounded, the same way `docs/text-learning.md`'s own "Open decisions"
 * anticipates.
 */
const CORRECTIONS_LIMIT = 50;

/**
 * One rendered line for a correction, or `null` where the row's settled half
 * currently reads identically to what was proposed - a title reverted back to
 * Cockpit's own words after a detour, say. Skipped rather than shown as a
 * dangling `"<note>" — ` with nothing after it: a row with nothing to show
 * teaches nothing, the same reasoning `textCorrectionFor` (`domain/text-
 * corrections.ts`) already refuses to record one for in the first place.
 *
 * **`correctionStillVisible` gates the same rows the "what stood" ratio
 * counts by** (`store.ts`) - one definition, so a reverted correction reads
 * "nothing corrected" in both places rather than disagreeing between them.
 */
function renderOneTextCorrection(entry: TextCorrectionEntry): string | null {
  if (!correctionStillVisible(entry)) return null;
  const changes: string[] = [];
  if (entry.proposedTitle !== entry.settledTitle) {
    changes.push(`title "${entry.proposedTitle}" became "${entry.settledTitle}"`);
  }
  if (entry.proposedDescription !== entry.settledDescription) {
    changes.push(
      `message "${entry.proposedDescription ?? '(nothing)'}" became "${entry.settledDescription ?? '(nothing)'}"`,
    );
  }
  return `"${entry.capturedMessage}" — ${changes.join('; ')}`;
}

function renderCorrections(corrections: readonly TextCorrectionEntry[]): string {
  const lines = corrections
    .slice(-CORRECTIONS_LIMIT)
    .map(renderOneTextCorrection)
    .filter((line) => line !== null);

  if (lines.length === 0) {
    return 'Corrections: (nothing corrected yet - this account has no proposals to learn from)';
  }

  return `Corrections, oldest first:\n${lines.join('\n')}`;
}

/**
 * How many proposed texts simply stood, beside how many were corrected, and
 * a bounded sample of the ones that stood - the weaker of the two kinds of
 * evidence `docs/text-learning.md` describes, present so a handful of
 * corrections is never mistaken for systematic failure ("What goes into the
 * prompt", "That ratio is the point of the fourth section").
 *
 * **"Texts", not "titles"**: a row counts as corrected the moment either the
 * title or the description was edited (`correctedItemIds`, `store.ts`), so a
 * line claiming "titles" specifically would overclaim for an account whose
 * only edits were to descriptions.
 */
function renderWhatStood(stood: WhatStood): string {
  if (stood.proposedTotal === 0) {
    return 'What stood: (nothing proposed and seen yet)';
  }

  const ratio = `${stood.correctedTotal} of ${stood.proposedTotal} proposed texts were corrected; the rest stood unchanged.`;
  if (stood.sample.length === 0) {
    return `What stood: ${ratio}`;
  }

  const lines = stood.sample.map((title) => `- "${title}"`);
  return `What stood: ${ratio} A sample of the titles nobody changed - weaker evidence than a correction, since it may mean good, tolerable, or simply not worth fixing:\n${lines.join('\n')}`;
}
