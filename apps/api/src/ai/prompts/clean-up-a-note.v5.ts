import { TITLE_LENGTH } from '@cockpit/shared';
import type { DecisionHistoryEntry } from '../../domain/decision-history.js';

/**
 * What Cockpit asks Claude for when a note has been captured, version 5. `v4`
 * ("Learn where notes belong from where you actually file them", issue 299)
 * added the decision history and recent captures; this version adds one more
 * read, a Workspace's own correction of what the nightly summary said it
 * learned ("Show what the system learned, in a sentence you can correct",
 * issue 301) - "the correction is an input to the proposals like anything
 * else". Nothing about what is asked for changes; `schema` is untouched.
 *
 * `correction` is `string | null` rather than defaulting to an empty string:
 * null is "nothing has ever been written here", a fact worth rendering
 * differently from an empty section, the same way `history` and
 * `recentlyCaptured` each render their own "nothing yet" line rather than an
 * empty one.
 */
export function buildCleanUpANote(
  panels: readonly { id: string; name: string }[],
  history: readonly DecisionHistoryEntry[],
  recentlyCaptured: readonly string[],
  correction: string | null,
): {
  version: 'v5';
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
    version: 'v5',

    /**
     * Unchanged from `v4`: nothing about reading one more thing before
     * answering changes what the model has to be to answer the rest of this
     * well, and the contract tests are what would notice if that stopped
     * being true.
     */
    model: 'claude-opus-5',
    effort: 'low',

    system: `You are part of Cockpit, one person's inbox for their own work.

Somebody has just captured a note by typing or dictating it in a hurry, on a phone or in a car. What arrives is clipped, abbreviated, half-typed, unpunctuated, and often mixes English and Dutch in one line. You write two texts for it: a title it can be found by, and a message that still makes sense to them in two weeks.

You may:
- expand an abbreviation the note itself uses
- correct spelling and punctuation
- finish a sentence the note leaves clipped
- put a dictated run of words into a readable order

You may not add anything the note does not contain. Not a fact, not a name, not a date, not a number, not a reason, and not a next step. Where the note refers to something it never states - a document, a person, a decision, a deadline - say that the note does not say which, rather than choosing one. If you are unsure whether something is in the note, it is not.

The title is the shortest text that names this note and no other. One line, no line breaks, at most ${TITLE_LENGTH} characters, no trailing full stop, and never the whole note handed back unshortened.

The message is the note written out as prose. It is not a summary, not a report about the note, and not a list of fields. Do not open it with "The note says" or "This note is about". Write no headings and no bullet points unless the note itself was a list.

Name the note's language first, in English, from the note alone - "English", "Dutch", or "English and Dutch" where the note genuinely mixes them. Then write the title and the message in that language. Never translate a note into another language, whatever language the examples below are in.

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
title: Part 11 audit trail question for the validation protocol
message: A question about the Part 11 audit trail, for the validation protocol. Needs to be clear by end of day who signs off on it; the note does not say who that is.
readings: []
panel: (none of the panels offered clearly fit)

Note: bellen novy ivm afspraak volgende week, niet voor 10u
language: Dutch
title: Novy bellen over de afspraak van volgende week
message: Novy bellen in verband met de afspraak van volgende week. Niet voor 10 uur bellen. De notitie zegt niet welke afspraak het is.
readings: []
panel: (none of the panels offered clearly fit)

Note: check of de deploy erdoor is + mail naar Anna re invoice
language: English and Dutch
title: Deploy nakijken en Anna mailen over de factuur
message: Nakijken of de deploy erdoor is. Daarna Anna mailen over de factuur; de notitie zegt niet welke factuur of wat erover gemaild moet worden.
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
     * Unchanged from `v4`: history, the correction and recent captures are
     * read material, not something the answer reports back, so nothing here
     * names any of them.
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
            `The shortest single line that names this note and no other, at most ${TITLE_LENGTH} characters, in the language named above.`,
        },
        message: {
          type: 'string',
          description:
            'The note written out as prose so it still makes sense in two weeks, adding nothing the note does not contain, in the language named above.',
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
 * Unchanged from `v4`'s own `renderHistory`.
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
 * Unchanged from `v4`'s own `renderRecentlyCaptured`.
 */
function renderRecentlyCaptured(recentlyCaptured: readonly string[]): string {
  if (recentlyCaptured.length === 0) {
    return 'Recently captured, not yet filed: (nothing else waiting right now)';
  }

  const lines = recentlyCaptured.map((note) => `- "${note}"`);
  return `Recently captured, not yet filed, most recent first:\n${lines.join('\n')}`;
}
