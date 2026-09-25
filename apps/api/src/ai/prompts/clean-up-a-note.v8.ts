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
import { correctionStillVisible, type TextCorrectionEntry, type WhatStood } from '../../domain/text-corrections.js';

/**
 * Re-exported rather than defined here since `v6` ("Propose a title that
 * names the work, not the note", issue 391) - the value lives in
 * `packages/shared` beside the length-target sentence
 * `GUIDANCE_TITLE_LENGTH_TARGET` carries, so there is never a second number
 * that drifts from this one.
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
 * of a list by position, which is what stops a reorder from silently
 * rebinding a sentence to the wrong prompt slot.
 */

/**
 * What Cockpit asks Claude for when a note has been captured, version 8.
 * `v7` ("Learn how you write from the titles you correct", issue 394; "Show
 * what Cockpit is told, and say how you want it changed", issue 398; "Pin an
 * example of how you want a note written", issue 397) added `corrections`,
 * `stood`, `rules` and `pinnedExamples` as inputs. `v8` bounds the first two
 * to a plain rolling 30-day window and drops the other two outright ("Cap
 * the text-learning prompt to the last 30 days, and drop rules and pinned
 * examples as inputs", issue 451; `docs/text-learning.md`).
 *
 * **The wanted titles use their author's own vocabulary, not the note's
 * words - the one thing no general prompt rewrite could supply**
 * (`docs/text-learning.md`, "What is wrong today"). `corrections` and `stood`
 * are that evidence, each already bounded to the last 30 days by the caller
 * (`store.ts`'s `textLearningContext`) before it reaches here - `corrections`
 * with no minimum count, `stood` handed in as `null` wherever fewer than 3
 * texts stood in the window, since a floor that low is a coin flip rather
 * than a pattern. Read per account, not per Workspace - how you write is a
 * property of you, not of which Workspace a note landed in (`docs/text-
 * learning.md`, "Scope: per account").
 *
 * **No `rules` or `pinnedExamples` parameter any more.** An account's own
 * written rules and pinned examples are still stored but nothing reads or
 * writes them - this prompt learns purely from what this account actually
 * does.
 *
 * Nothing else moves: language, the other readings, the Panel proposal, the
 * routing history and the shape of `schema` are `v6`'s.
 */
export function buildCleanUpANote(
  panels: readonly { id: string; name: string }[],
  history: readonly DecisionHistoryEntry[],
  recentlyCaptured: readonly string[],
  corrections: readonly TextCorrectionEntry[],
  stood: WhatStood | null,
): {
  version: 'v8';
  model: string;
  effort: 'low';
  system: string;
  schema: Record<string, unknown>;
} {
  const panelList =
    panels.length > 0
      ? panels.map((panel) => `- ${panel.id}: ${panel.name}`).join('\n')
      : '(this account has no panels yet)';

  // Either section may be absent - a window with nothing qualifying, or
  // `stood` handed in as `null` because too little stood in it to say
  // anything - and nothing forces older data in to fill the gap (`docs/
  // text-learning.md`, "What goes into the prompt"; issue 451).
  //
  // **The intro sentence rides inside this same computed value, not fixed in
  // the template below.** `v7` could state "you are also given..." unconditionally
  // because `renderCorrections`/`renderWhatStood` always rendered a truthful
  // placeholder when empty; `v8`'s sections can both be genuinely absent, and
  // a fixed sentence claiming evidence exists with nothing following it would
  // tell the model it has vocabulary evidence it was never actually given -
  // worst for a new or quiet account, exactly the population likeliest to
  // need cautious defaults.
  const styleEvidenceSections = [renderCorrections(corrections), renderWhatStood(stood)].filter(
    (section): section is string => section !== null,
  );
  const styleEvidence =
    styleEvidenceSections.length === 0
      ? ''
      : `You are also given this account's own record of the titles and messages you have proposed in the last 30 days and how they were received - the strongest evidence of this person's own vocabulary and length available, and it outranks the built-in guidance above on vocabulary and length wherever the two disagree. It never overrides the language rule above, and never licenses adding anything the note itself does not contain.\n\n${styleEvidenceSections.join('\n\n')}`;

  return {
    version: 'v8',

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

${NO_INVENTION} Not a fact, not a name, not a date, not a number, not a reason, and not a next step. ${NO_HEDGE} Write what the note carries and stop there. If you are unsure whether something is in the note, it is not.

${NO_TALKING_ABOUT_THE_NOTE} What lands in front of this person is a piece of their own work, not a report about something they typed, so never write "the note", "this note" or "de notitie" in either text.

${TITLE_NAMES_THE_WORK} Write it as an instruction - "Run only the impacted CI tests", "Novy bellen over de afspraak" - not as a label. One line, no line breaks, no trailing full stop, and never the whole note handed back unshortened.

${TITLE_LENGTH_TARGET_LINE} ${TITLE_LENGTH} characters is only what the form will store; it is not what to write towards.

${MESSAGE_PURPOSE} It is an instruction too: the work the note is asking for, spelled out from what the note carries and nothing more. Where the note records an opinion or an observation rather than asking for something, the instruction is to record it. It is not a summary, not a report, and not a list of fields. Write no headings and no bullet points unless the note itself was a list.

Name the note's language first, in English, from the note alone - "English", "Dutch", or "English and Dutch" where the note genuinely mixes them. ${LANGUAGE_ANSWER} ${NEVER_TRANSLATE}

${styleEvidence}

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
 * Every correction this account made in the last 30 days, oldest first - a
 * wrong answer named beside the right one, so it is read as the stronger of
 * the two kinds of evidence `docs/text-learning.md` describes ("What goes
 * into the prompt"). No minimum count: even a single correction in the
 * window is the strongest signal this whole prompt carries, regardless of
 * how many others exist alongside it.
 *
 * **Bounded by the caller, not here.** `corrections` arrives already windowed
 * to the last 30 days (`store.ts`'s `textLearningContext`) - unlike `v7`,
 * which capped a whole-table read at a fixed count in this render
 * (`CORRECTIONS_LIMIT`), the same shift `decisionHistoryForWorkspace`
 * (`repo.ts`) already made for the routing prompt ("Cap the routing prompt to
 * the last 50 decisions on panels that still exist, and drop the correction
 * override", issue 450).
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

/**
 * `null` where the window carries nothing to show - no qualifying rows, or
 * every one of them a reverted correction `renderOneTextCorrection` skips -
 * so the section is simply absent from the prompt rather than a placeholder
 * line claiming there is nothing to learn from (`docs/text-learning.md`,
 * "What goes into the prompt"; issue 451).
 */
function renderCorrections(corrections: readonly TextCorrectionEntry[]): string | null {
  const lines = corrections.map(renderOneTextCorrection).filter((line): line is string => line !== null);
  if (lines.length === 0) return null;
  return `Corrections, oldest first:\n${lines.join('\n')}`;
}

/**
 * How many proposed texts simply stood, beside how many were corrected, and
 * a bounded sample of the ones that stood - the weaker of the two kinds of
 * evidence `docs/text-learning.md` describes, present so a handful of
 * corrections is never mistaken for systematic failure ("What goes into the
 * prompt", "That ratio is the point of the second section").
 *
 * **`null` where the caller found too little to say anything.** `stood`
 * arrives already windowed to the last 30 days and already gated at a floor
 * of 3 unchanged texts (`store.ts`'s `textLearningContext`, `domain/text-
 * corrections.ts`'s `deriveWhatStoodForPrompt`) - below that floor, a sample
 * is a coin flip read as a pattern, so the whole section is simply absent
 * rather than shown on too little evidence (issue 451).
 *
 * **"Texts", not "titles"**: a row counts as corrected the moment either the
 * title or the description was edited (`correctedItemIds`, `store.ts`), so a
 * line claiming "titles" specifically would overclaim for an account whose
 * only edits were to descriptions.
 */
function renderWhatStood(stood: WhatStood | null): string | null {
  if (stood === null) return null;

  const ratio = textLearningRatioSentence(stood.proposedTotal, stood.correctedTotal);
  const lines = stood.sample.map((title) => `- "${title}"`);
  return `What stood: ${ratio} A sample of the titles nobody changed - weaker evidence than a correction, since it may mean good, tolerable, or simply not worth fixing:\n${lines.join('\n')}`;
}
