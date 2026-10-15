import {
  GUIDANCE_LANGUAGE_ANSWER as LANGUAGE_ANSWER,
  GUIDANCE_MESSAGE_PURPOSE as MESSAGE_PURPOSE,
  GUIDANCE_NEVER_TRANSLATE as NEVER_TRANSLATE,
  GUIDANCE_NO_HEDGE as NO_HEDGE,
  GUIDANCE_NO_INVENTION as NO_INVENTION,
  GUIDANCE_NO_TALKING_ABOUT_THE_NOTE as NO_TALKING_ABOUT_THE_NOTE,
  GUIDANCE_TITLE_LENGTH_TARGET as TITLE_LENGTH_TARGET_LINE,
  GUIDANCE_TITLE_NAMES_THE_WORK as TITLE_NAMES_THE_WORK,
  prioritySchema,
  textLearningRatioSentence,
  TITLE_LENGTH,
  TITLE_TARGET,
} from '@cockpit/shared';
import type { CaptureDay } from '../../domain/capture-day.js';
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
 * How a priority the note states is read ("Read a priority you say when you
 * capture", issue 1076): only from words that say it, never from tone, and
 * taken out of the title once read. Its own constant so the rule can be held
 * without a model in the room.
 */
export const STATED_PRIORITY = `Where the note itself says how important it is, give that as its priority: high for "high priority", "urgent", "ASAP" or the same in Dutch ("dringend", "hoge prioriteit"); low for "low priority", "no rush" or the same in Dutch ("geen haast", "lage prioriteit"); normal only where the note says "normal priority". Read a priority only from words that say it. Never read one from tone, exclamation marks, capitals, or what the work is about, and where the note says nothing about its priority, leave the priority out. Once you have read a priority, leave the words you read it from out of the title; the message keeps them.`;

/**
 * How a due date the note states is read ("Read a due date you say when you
 * capture, on your own calendar", issue 1077): only a day the note names,
 * counted from the day it was captured on - which is given per note, after
 * the cached prefix (`renderCaptureDay`) - a time dropped, and a vague one
 * left out. Its own constant for the reason `STATED_PRIORITY` is.
 */
export const STATED_DUE_DATE = `Where the note names the day something is due - "tomorrow", "Friday", "the 24th", "on 3 March", or the same in Dutch ("morgen", "vrijdag", "de 24ste") - give that day as its due date, written YYYY-MM-DD, counted from the day the note was captured on, which you are told further down. A weekday means the first one after the day it was captured on; a day of the month means the next time that day comes. A due date is a day and never a time, so where the note gives a time as well ("tomorrow at 3"), give the day alone. Where the day is unclear ("end of the month", "soon", "next week", "binnenkort"), where the note names no day, or where you are not told the day it was captured on, leave the due date out. Once you have read a due date, leave the words you read it from out of the title; the message keeps them.`;

/**
 * How a Workspace the note names is read ("Settle an Any workspace capture in
 * the workspace you name", issue 1078): only where the note says which of the
 * listed Workspaces it is for, never from what the work is about, written as
 * the list spells it, and taken out of the title once read. Its own constant
 * for the reason `STATED_PRIORITY` is. The list itself comes per account,
 * after the cached prefix, and only for a note not yet in a Workspace.
 */
export const STATED_WORKSPACE = `Where a list of workspaces is given further down and the note itself says which one it is for - "for Home", "voor werk", "in the Work workspace" - give that workspace, written exactly as the list spells it. Read a workspace only from words that say it. Never read one from what the work is about, and where the note names none, names one that is not on the list, or where no list is given, leave the workspace out. Once you have read a workspace, leave the words you read it from out of the title; the message keeps them.`;

/**
 * When a note is given a Panel, and how sure the answer says it is ("Propose
 * the closest Panel at capture, and draw a less certain one dashed", issue
 * 1107): the closest Panel wherever one plausibly fits, none only for a note
 * that fits none, and `clear` or `closest` beside it. `v14` held back - "a
 * panel is not owed a note merely for being the closest match" - and was
 * measured answering none for notes the person then filed on a Panel. Its own
 * constant for the reason `STATED_PRIORITY` is.
 */
export const PANEL_FIT = `The panels are buckets this account files its own notes into, each named for what belongs there. Where this note fits one of them, name its id, say in a few words why - about the note and the panel rather than about yourself, "a compliance question, about the validation protocol" rather than "I chose this because it mentions compliance" - and say how sure you are. Clear is for a note that plainly belongs on that panel, where a person filing their own notes would put it there without a second thought. Closest is for a note that plausibly fits that panel, better than any other offered, though it was not plainly made for it. Name the closest panel wherever one plausibly fits: the person has to file the note somewhere, and a near miss they can correct helps them more than nothing. Name none only for a note that fits none of the panels at all - a shopping list against panels for work, or a note about something no panel is about.`;

/**
 * Every word of the system prompt that is the same for every note and every
 * account - the rules and the worked examples - and nothing else.
 *
 * **A constant, so no input can reach it.** It is sent first, with the cache
 * breakpoint on its end (`index.ts`), and a cached prefix is only ever read
 * back by a request whose bytes match it exactly: one interpolated value in
 * here and no two accounts, or no two notes, would share it. What varies per
 * call is sent after it, stable part first (`buildCleanUpANote`; "Enable
 * prompt caching on the note-cleanup prompt, restructured so the fixed
 * content is a stable prefix", issue 584).
 *
 * **An edit here needs no cache flush.** The cache is keyed on the exact
 * bytes, so a changed sentence is a different prefix, written fresh on its
 * first call - an entry for the old wording can outlive the deploy, but
 * nothing that sends the new wording can read it.
 *
 * The paragraphs saying how to read the panels, the decision history and
 * what was recently captured are here; the panels, history and captures
 * themselves come after, so this says once that they come further down.
 */
const INSTRUCTIONS = `You are part of Cockpit, one person's inbox for their own work.

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

${MESSAGE_PURPOSE} It is an instruction too: the work the note is asking for, spelled out from what the note carries and nothing more. Where the note records an opinion or an observation rather than asking for something, the instruction is to record it. It is not a summary, not a report, and not a list of fields. The note is Markdown: where it uses bold, italics, links or lists, keep them on the same words in the message, and add none the note does not have. Write no headings and no bullet points unless the note itself was a list; where it was, keep its items as that list, one to a line with the note's own markers, never joined into a sentence.

Name the note's language first, in English, from the note alone - "English", "Dutch", or "English and Dutch" where the note genuinely mixes them. ${LANGUAGE_ANSWER} ${NEVER_TRANSLATE}

Some notes genuinely say two things at once - "bel jan" is either call Jan, a person, or call in January, the month; "review pricing with sales monday" could put the review or the pricing on Monday. Where that is true, list the other readings: for each, a title and a message exactly as you would write your main answer, and a few words saying what that reading takes the note to mean.

Almost every note has none. A note that is merely terse, or short, or missing detail is not ambiguous - it has one reading, and your main title and message are it. Only list another reading where the difference would change what somebody does about the note, and never more than two or three.

A reading's message may say nothing beyond what its title already says, where the note has nothing more to add - do not repeat the same message under two readings to fill the field.

${STATED_PRIORITY}

${STATED_DUE_DATE}

${STATED_WORKSPACE}

Further down, after the examples, you are given what is this account's own: the workspaces the note may be for, where it is not yet in one, the panels it has already set up, its decision history, and what else has been captured recently.

${PANEL_FIT}

The decision history is this account's most recent settled filings, oldest first, with what you proposed and what they actually chose. It is the only place learning happens here - there is no separate training step. Recent entries say what is live right now; older ones still say how this person files in general, and both matter, but where they disagree favor the recent one - a project can go quiet for a while and an older habit can still hold. Where an entry shows you proposed one panel and they filed it on another, that correction outweighs an entry where they simply accepted what you proposed - it names a wrong answer as well as a right one, so read it as the stronger signal. Where such a correction concerns a note of the same kind as this one, name the panel they filed that one on, rather than none or the one you proposed then, even where this note never says which panel it is for.

What else has been captured in this workspace recently and not yet filed is separate from the history, because none of it has been decided yet. It is still evidence: what somebody is writing notes about right now, before any of it has a destination. Weigh it alongside the history, never above it - an actual past decision is a stronger signal than a guess at a pattern in still-unfiled notes.

Examples.

Note: part 11 audit trail q for validation protocol, who signs off eod
language: English
title: Clarify who signs off the Part 11 audit trail
message: Find out who signs off on the Part 11 audit trail for the validation protocol, and have it clear by end of day.
readings: []
panel: (none of the panels offered fits)

Note: bellen novy ivm afspraak volgende week, niet voor 10u
language: Dutch
title: Novy bellen over de afspraak van volgende week
message: Novy bellen in verband met de afspraak van volgende week. Niet voor 10 uur bellen.
readings: []
panel: (none of the panels offered fits)

Note: check of de deploy erdoor is + mail naar Anna re invoice
language: English and Dutch
title: Deploy nakijken en Anna mailen over de factuur
message: Nakijken of de deploy erdoor is en daarna Anna mailen over de factuur.
readings: []
panel: (none of the panels offered fits)

Note: standup is too long, half the room has nothing to say
language: English
title: Record that standup runs too long
message: Record that standup is too long and that half the room has nothing to say.
readings: []
panel: (none of the panels offered fits)

Note: call bob re contract renewal, urgent
language: English
title: Call Bob about the contract renewal
message: Call Bob about the contract renewal. Urgent.
readings: []
priority: high
panel: (none of the panels offered fits)

Note: send anna the q3 numbers friday
(captured on Tuesday 2026-10-13)
language: English
title: Send Anna the Q3 numbers
message: Send Anna the Q3 numbers on Friday.
readings: []
dueDate: 2026-10-16
panel: (none of the panels offered fits)

Note: renew the car insurance, for home
(the workspaces offered include "Home")
language: English
title: Renew the car insurance
message: Renew the car insurance, for Home.
readings: []
workspace: Home
panel: (none of the panels offered fits)

Note: call jan
language: English
title: Call Jan
message: Call Jan.
readings:
- title: Call in January
  message:
  meaning: "'jan' is short for the month January"
panel: (none of the panels offered fits)

Note: part 11 audit trail q for validation protocol, who signs off eod
(the first example above, once more, now that one of the panels offered is called "Compliance questions")
panel: Compliance questions, clear, because it's a compliance question - Part 11 and the validation protocol

Note: check if the new starter's laptop is ordered
(the panels offered are "Hiring", "Customer escalations" and "Team offsite", none of them made for equipment)
panel: Hiring, closest, because it is about a new starter, though not about recruiting them`;

/**
 * What Cockpit asks Claude for when a note has been captured, version 13.
 * `v7` ("Learn how you write from the titles you correct", issue 394; "Show
 * what Cockpit is told, and say how you want it changed", issue 398; "Pin an
 * example of how you want a note written", issue 397) added `corrections`,
 * `stood`, `rules` and `pinnedExamples` as inputs. `v8` bounds the first two
 * to a plain rolling 30-day window and drops the other two outright ("Cap
 * the text-learning prompt to the last 30 days, and drop rules and pinned
 * examples as inputs", issue 451; `docs/text-learning.md`).
 *
 * **`v9` changed the order and nothing it asked for.** The system prompt is
 * the fixed `instructions` first and what is this account's and this call's
 * after it, so the fixed part is a prefix every call shares and the cache can
 * serve (issue 584). `v8` interleaved the two, which left only the opening
 * paragraphs cacheable.
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
 * **`v10` keeps the note's Markdown on the message** - one sentence in the
 * instructions, so a bold name, a link or a list in the note comes back on
 * the same words (issue 756).
 *
 * **`v11` runs on Sonnet 5.5 and orders what is learned from, stable first**
 * ("Cut what cleaning up a captured note costs", issue 887). Measured on the
 * last 20 production captures, Sonnet 5.5 made 20 usable proposals to Opus
 * 5's 19, at $0.035 a capture against $0.086. The system prompt is three
 * parts, each only as stable as the last, with a cache breakpoint after the
 * first two (`index.ts`): `instructions`; `stable`, which changes only when
 * something is filed or corrected - the Panels, the decision history, then the
 * corrections; and `recent`, which changes with every capture. Consecutive
 * captures of one account read the first two back at the cache rate. A
 * correction left to the end of `stable` leaves the history cached, and the
 * history is the larger part.
 *
 * Nothing else moves: language, the other readings, the Panel proposal, the
 * routing history and the shape of `schema` are `v6`'s. The texts-only form
 * `v10` had, for a correction's re-read of the rest of the Inbox, went with
 * that re-read.
 *
 * **`v12` reads a priority the note states** ("Read a priority you say when
 * you capture", issue 1076): `STATED_PRIORITY` in the instructions, one worked
 * example, and an optional `priority` in the schema, left out where the note
 * says none. Whether it lands on the Item is the store's to decide.
 *
 * **`v13` reads a due date the note states, on the calendar it was captured
 * on** ("Read a due date you say when you capture, on your own calendar",
 * issue 1077): `STATED_DUE_DATE` in the instructions, one worked example, the
 * day of the capture at the head of `recent` (`renderCaptureDay`), and an
 * optional `dueDate` in the schema - offered only where that day is known,
 * so a capture with no calendar to read it on is never asked for one.
 *
 * **`v14` reads a Workspace the note names** ("Settle an Any workspace capture
 * in the workspace you name", issue 1078): `STATED_WORKSPACE` in the
 * instructions, one worked example, the account's own Workspace names in
 * `stable`, and an optional `workspace` in the schema - offered only for a note
 * not yet in a Workspace (`workspaces` is `null` otherwise), so a capture made
 * inside one is never asked, and a model is only ever shown names that are
 * this account's.
 *
 * **`v15` proposes the closest Panel, and says how sure it is** ("Propose the
 * closest Panel at capture, and draw a less certain one dashed", issue 1107):
 * `PANEL_FIT` in place of `v14`'s holding back, a `fit` of `clear` or
 * `closest` beside the Panel in the schema, empty exactly when the Panel is,
 * and a worked example of each.
 */
export function buildCleanUpANote(
  routing: RoutingInputs,
  corrections: readonly TextCorrectionEntry[],
  stood: WhatStood | null,
  day: CaptureDay | null,
  workspaces: readonly string[] | null = null,
): {
  version: 'v15';
  model: string;
  effort: 'low';
  system: { instructions: string; stable: string; recent: string };
  schema: Record<string, unknown>;
} {
  // Either section may be absent - a window with nothing qualifying, or
  // `stood` handed in as `null` because too little stood in it to say
  // anything - and nothing forces older data in to fill the gap (`docs/
  // text-learning.md`, "What goes into the prompt"; issue 451).
  //
  // **The intro sentence rides inside this same computed value, and
  // `instructions` never mentions this record.** `v7` could state "you are
  // also given..." unconditionally because `renderCorrections`/
  // `renderWhatStood` always rendered a truthful placeholder when empty; since
  // `v8` both sections can be genuinely absent, and
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

  // The Panels first: they are in the output schema as well, so a change to
  // them restarts the cache wherever they sit.
  const stable = [
    "Everything below is this account's own, read fresh for this note.",
    ...(workspaces === null ? [] : [renderWorkspaces(workspaces)]),
    renderPanels(routing.panels),
    renderHistory(routing.history),
    ...(styleEvidence === '' ? [] : [styleEvidence]),
  ].join('\n\n');

  return {
    version: 'v15',

    /**
     * Sonnet 5.5, on the 20-capture comparison above, and held to the same
     * contract suite Opus 5 was (`tests/contract/clean-up-a-note.v15.test.ts`).
     * Haiku 5.5 was compared too and gave three titles of another note and
     * three rejected answers, so this is the cheapest model that held the
     * comparison, not the cheapest there is.
     */
    model: 'claude-sonnet-5-5',
    effort: 'low',

    // The day first: it is this note's own, and changes with every capture as
    // the recent captures do, so it rides in the one part never cached.
    system: {
      instructions: INSTRUCTIONS,
      stable,
      recent: [renderCaptureDay(day), renderRecentlyCaptured(routing.recentlyCaptured)].join('\n\n'),
    },

    /**
     * `v6`'s shape, with `v12`'s optional `priority` and `v13`'s optional `dueDate` added: history, the two texts of evidence above
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
            'Which of the panels listed above this note fits best, and how sure that is - or that none of them fits at all.',
          properties: {
            panelId: {
              type: 'string',
              enum: [...routing.panels.map((panel) => panel.id), ''],
              description:
                'The id of the panel this note fits best, copied exactly from the list above - or the empty string only where none of them fits at all.',
            },
            reason: {
              type: 'string',
              description:
                'A few words saying why, about the note and the panel rather than about yourself. Empty exactly when panelId is empty.',
            },
            fit: {
              type: 'string',
              enum: ['clear', 'closest', ''],
              description:
                'clear where the note plainly belongs on that panel; closest where it plausibly fits there, better than on any other, without plainly belonging. Empty exactly when panelId is empty.',
            },
          },
          required: ['panelId', 'reason', 'fit'],
          additionalProperties: false,
        },
        // Optional, unlike every field above: most notes say nothing about
        // their priority, and leaving it out is that answer (issue 1076).
        priority: {
          type: 'string',
          enum: [...prioritySchema.options],
          description:
            'The priority the note itself states in words - left out wherever it states none, and never read from tone.',
        },
        // Offered only where the day the note was captured on is known: with
        // no calendar to count from, there is no due date to ask for (issue
        // 1077). Optional for the reason `priority` is.
        ...(day === null
          ? {}
          : {
              dueDate: {
                type: 'string',
                description:
                  'The day the note itself names as when it is due, written YYYY-MM-DD and counted from the day it was captured on - left out wherever it names none or the day is unclear, and never a time.',
              },
            }),
        // Offered only for a note not yet in a Workspace, and only where the
        // account has one to name (issue 1078). Optional for the reason
        // `priority` is.
        ...(workspaces === null || workspaces.length === 0
          ? {}
          : {
              workspace: {
                type: 'string',
                description:
                  'The workspace, from the list above, that the note itself says it is for - written exactly as listed, and left out wherever the note names none.',
              },
            }),
      },
      required: ['language', 'title', 'message', 'readings', 'panel'],
      additionalProperties: false,
    },
  };
}

/** What a proposal needs to say which Panel a note belongs on. */
export interface RoutingInputs {
  panels: readonly { id: string; name: string }[];
  history: readonly DecisionHistoryEntry[];
  recentlyCaptured: readonly string[];
}

/** The Workspaces a note not yet in one may be for, by name - never by id, which the model has no use for. */
export function renderWorkspaces(workspaces: readonly string[]): string {
  const list = workspaces.length > 0 ? workspaces.map((name) => `- ${name}`).join('\n') : '(this account has no workspaces)';
  return `Workspaces:\n${list}`;
}

/** Exported for `choose-a-panel.v2`, which lists the Panels in the same words. */
export function renderPanels(panels: readonly { id: string; name: string }[]): string {
  const list =
    panels.length > 0 ? panels.map((panel) => `- ${panel.id}: ${panel.name}`).join('\n') : '(this account has no panels yet)';
  return `Panels:\n${list}`;
}

/**
 * Unchanged since `v4`. Exported for `choose-a-panel.v2`, which reads the
 * same history in the same words.
 */
export function renderHistory(history: readonly DecisionHistoryEntry[]): string {
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
 * The day the note was captured on, on the calendar of whoever captured it,
 * or that it is not known - which `STATED_DUE_DATE` reads as leaving the due
 * date out ("Read a due date you say when you capture, on your own calendar",
 * issue 1077).
 */
export function renderCaptureDay(day: CaptureDay | null): string {
  if (day === null) return 'Captured on: (not known for this note, so leave the due date out)';
  return `Captured on: ${day.weekday} ${day.date}, on the calendar of the person who captured it.`;
}

/**
 * Unchanged since `v4`. Exported for the same reason as `renderHistory`.
 */
export function renderRecentlyCaptured(recentlyCaptured: readonly string[]): string {
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
