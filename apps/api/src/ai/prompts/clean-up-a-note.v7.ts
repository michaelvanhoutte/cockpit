import {
  GUIDANCE_LANGUAGE_ANSWER as LANGUAGE_ANSWER,
  GUIDANCE_MESSAGE_PURPOSE as MESSAGE_PURPOSE,
  GUIDANCE_NEVER_TRANSLATE as NEVER_TRANSLATE,
  GUIDANCE_NO_HEDGE as NO_HEDGE,
  GUIDANCE_NO_INVENTION as NO_INVENTION,
  GUIDANCE_NO_TALKING_ABOUT_THE_NOTE as NO_TALKING_ABOUT_THE_NOTE,
  GUIDANCE_TITLE_LENGTH_TARGET as TITLE_LENGTH_TARGET_LINE,
  GUIDANCE_TITLE_NAMES_THE_WORK as TITLE_NAMES_THE_WORK,
  textLearningRatioSentence,
  TITLE_LENGTH,
  TITLE_TARGET,
} from '@cockpit/shared';
import type { DecisionHistoryEntry } from '../../domain/decision-history.js';
import type { PinnedExampleEntry } from '../../domain/pinned-text-examples.js';
import { correctionStillVisible, type TextCorrectionEntry, type WhatStood } from '../../domain/text-corrections.js';

/**
 * Re-exported rather than defined here since `v6` ("Propose a title that
 * names the work, not the note", issue 391) - the value now lives in
 * `packages/shared` so the window that shows "what Cockpit is told" (`docs/
 * text-learning.md`, "Where you see it, and change it") can build the same
 * length-target sentence `GUIDANCE_TITLE_LENGTH_TARGET` carries without
 * risking a second number that drifts from this one.
 *
 * **Asked for as a ceiling and never as a floor**, which is the only form of
 * it a test can hold the model to: "about 50" is not assertable, and half the
 * measured titles sit well under it anyway. A note with less to say gets a
 * shorter title, never one padded out to reach this.
 */
export { TITLE_TARGET };

/**
 * Each guidance sentence below is imported by name from `packages/shared`
 * and interpolated at the exact spot it already occupied in the system
 * prompt, aliased to a shorter local name for readability - never read out
 * of the array by position, which is what makes "the lines shown are the
 * ones the prompt actually carries" (this issue's own test case) true by
 * construction, and what stops a reorder of the shared list from silently
 * rebinding a sentence to the wrong prompt slot.
 */

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
 *
 * **`rules` is new since `v7` shipped** ("Show what Cockpit is told, and say
 * how you want it changed", issue 398): an account's own explicit rules for
 * how a title and a message are written, in their own words, rendered ahead
 * of `corrections` and `stood` - the top of the precedence `docs/text-
 * learning.md`'s "What goes into the prompt" states, since a rule is an
 * instruction rather than evidence to weigh.
 */
export function buildCleanUpANote(
  panels: readonly { id: string; name: string }[],
  history: readonly DecisionHistoryEntry[],
  recentlyCaptured: readonly string[],
  corrections: readonly TextCorrectionEntry[],
  stood: WhatStood,
  rules: string | null = null,
  pinnedExamples: readonly PinnedExampleEntry[] = [],
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

${renderTextLearningRules(rules)}

${NO_INVENTION} Not a fact, not a name, not a date, not a number, not a reason, and not a next step. ${NO_HEDGE} Write what the note carries and stop there. If you are unsure whether something is in the note, it is not.

${NO_TALKING_ABOUT_THE_NOTE} What lands in front of this person is a piece of their own work, not a report about something they typed, so never write "the note", "this note" or "de notitie" in either text.

${TITLE_NAMES_THE_WORK} Write it as an instruction - "Run only the impacted CI tests", "Novy bellen over de afspraak" - not as a label. One line, no line breaks, no trailing full stop, and never the whole note handed back unshortened.

${TITLE_LENGTH_TARGET_LINE} ${TITLE_LENGTH} characters is only what the form will store; it is not what to write towards.

${MESSAGE_PURPOSE} It is an instruction too: the work the note is asking for, spelled out from what the note carries and nothing more. Where the note records an opinion or an observation rather than asking for something, the instruction is to record it. It is not a summary, not a report, and not a list of fields. Write no headings and no bullet points unless the note itself was a list.

Name the note's language first, in English, from the note alone - "English", "Dutch", or "English and Dutch" where the note genuinely mixes them. ${LANGUAGE_ANSWER} ${NEVER_TRANSLATE}

You are also given this account's own evidence of how it writes: examples chosen deliberately, and a record of the titles and messages you have proposed before and how they were received - together the strongest evidence of this person's own vocabulary and length available, and it outranks the built-in guidance above on vocabulary and length wherever the two disagree. It never overrides the language rule above, never licenses adding anything the note itself does not contain, and never outranks this account's own rules at the top of this prompt, which come ahead of it too.

${renderPinnedExamples(pinnedExamples)}

${renderCorrections(corrections)}

${renderWhatStood(stood)}

Some notes genuinely say two things at once - "bel jan" is either call Jan, a person, or call in January, the month; "review pricing with sales monday" could put the review or the pricing on Monday. Where that is true, list the other readings: for each, a title and a message exactly as you would write your main answer, and a few words saying what that reading takes the note to mean.

Almost every note has none. A note that is merely terse, or short, or missing detail is not ambiguous - it has one reading, and your main title and message are it. Only list another reading where the difference would change what somebody does about the note, and never more than two or three.

A reading's message may say nothing beyond what its title already says, where the note has nothing more to add - do not repeat the same message under two readings to fill the field.

You are also given the panels this account has already set up - buckets it files its own notes into, each named for what belongs there. Where this note clearly belongs on one of them, name its id and say in a few words why, about the note and the panel rather than about yourself - "a compliance question, about the validation protocol" rather than "I chose this because it mentions compliance". Most notes belong on none of them: a panel is not owed a note merely for being the closest match, and naming the wrong one costs more than naming none. Only name one where you are confident a person filing their own notes would put it there themselves.

Panels:
${panelList}

You are also given this account's own decision history: its most recent settled filings, oldest first, with what you proposed and what they actually chose. It is the only place learning happens here - there is no separate training step. Recent entries say what is live right now; older ones still say how this person files in general, and both matter, but where they disagree favor the recent one - a project can go quiet for a while and an older habit can still hold. Where an entry shows you proposed one panel and they filed it on another, that correction outweighs an entry where they simply accepted what you proposed - it names a wrong answer as well as a right one, so read it as the stronger signal.

${renderHistory(history)}

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
     * Unchanged in shape from `v6`: history, the two texts of evidence above
     * and recent captures are read material, not something the answer
     * reports back, so nothing here names any of them. `title` and `message`
     * say what they now ask for; `TITLE_LENGTH` stays the cap, since the
     * schema is what the Item's own two fields will accept and a target has
     * no place in it.
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
 * The account's own rules for how a title and a message are written, or a
 * line saying none have been written yet - every account's starting
 * condition ("Show what Cockpit is told, and say how you want it changed",
 * issue 398).
 *
 * **Rendered before the built-in guidance that follows it, not after.** A
 * rule contradicting that guidance has to read as overriding it, which only
 * holds if it is read first - the guidance itself is never removed or
 * shortened for having one, since disagreeing with a sentence still there is
 * how a person's own rule is meant to work. It is also read before the
 * account's own record of corrections and what stood, and before the
 * examples at the end of this prompt - the top of the precedence `docs/
 * text-learning.md`'s "What goes into the prompt" states for this section.
 */
function renderTextLearningRules(rules: string | null): string {
  if (rules === null) {
    return 'This person has not written any rules for how their titles and messages should be written.';
  }
  return `This person has written the following rule(s) for how their titles and messages should be written - the most direct signal available in this whole prompt, ahead of the guidance above, the examples below, and every correction or pattern that follows: "${rules}"`;
}

/**
 * One rendered line for a pinned example: the note, and the title and
 * message chosen for it - a direct worked example, unlike a correction,
 * which names a wrong answer as well as a right one ("Pin an example of how
 * you want a note written", issue 397).
 */
function renderOnePinnedExample(example: PinnedExampleEntry): string {
  const parts = [`title: "${example.title}"`];
  if (example.description !== null) parts.push(`message: "${example.description}"`);
  return `"${example.note}" — ${parts.join('; ')}`;
}

/**
 * The account's own pinned examples, or a line saying none have been added
 * yet - every account's starting condition ("Pin an example of how you want
 * a note written", issue 397).
 *
 * **Rendered ahead of `renderCorrections`/`renderWhatStood`, after
 * `renderTextLearningRules`** - the precedence `docs/text-learning.md`'s
 * "What goes into the prompt" states: a rule you wrote outranks every
 * example, and an example you chose outranks a correction that merely
 * happened.
 *
 * **Never capped.** Unlike `CORRECTIONS_LIMIT`/`STOOD_SAMPLE_LIMIT` below,
 * every pinned row is rendered whatever the account's volume of ordinary
 * corrections grows to - a pinned row was chosen, and `docs/text-
 * learning.md`'s own "Open decisions" recommends keeping every one of them
 * for exactly that reason.
 */
function renderPinnedExamples(pinnedExamples: readonly PinnedExampleEntry[]): string {
  if (pinnedExamples.length === 0) {
    return 'Pinned examples: (nothing pinned yet)';
  }
  const lines = pinnedExamples.map(renderOnePinnedExample);
  return `Pinned examples - chosen deliberately, the strongest evidence of vocabulary available in this prompt after this person's own rules above, ahead of the corrections and what-stood evidence that follow:\n${lines.join('\n')}`;
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
  // Filtered before capped: a reverted row inside the trailing window would
  // otherwise take a slot from an older, still-visible correction, and could
  // empty the window entirely while `correctedItemIds` (`store.ts`, built
  // from the full, uncapped list) still reports a nonzero corrected count -
  // the same "two sections disagree" failure `renderOneTextCorrection`'s own
  // comment names.
  const lines = corrections
    .map(renderOneTextCorrection)
    .filter((line) => line !== null)
    .slice(-CORRECTIONS_LIMIT);

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

  // Shared with the window's own "how it is doing" line (`packages/shared`),
  // so the two can never say the same ratio two different ways.
  const ratio = textLearningRatioSentence(stood.proposedTotal, stood.correctedTotal);
  if (stood.sample.length === 0) {
    return `What stood: ${ratio}`;
  }

  const lines = stood.sample.map((title) => `- "${title}"`);
  return `What stood: ${ratio} A sample of the titles nobody changed - weaker evidence than a correction, since it may mean good, tolerable, or simply not worth fixing:\n${lines.join('\n')}`;
}
