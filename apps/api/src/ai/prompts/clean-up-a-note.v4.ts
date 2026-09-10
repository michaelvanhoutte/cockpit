import { TITLE_LENGTH } from '@cockpit/shared';
import type { DecisionHistoryEntry } from '../../domain/decision-history.js';

/**
 * What Cockpit asks Claude for when a note has been captured, version 4. `v3`
 * ("Propose where a captured note belongs, without filing it there", issue
 * 298) asked the same call to also name a Panel; this version does not change
 * what is asked for - `schema` is untouched - but changes what the call reads
 * before answering: the account's own decision history, and what else has
 * been captured lately and not yet filed ("Learn where notes belong from
 * where you actually file them", issue 299). A prompt is a versioned file
 * reviewed like code (architecture, "AI layer"), and this much of the system
 * prompt changing, plus a third and fourth parameter this call is not shaped
 * like before, earns the next version rather than an edit.
 *
 * **A function now, not a plain object.** Every version before this one was
 * the same call for every account, so it could be a constant; a routing
 * proposal cannot be, because the Panels it chooses among are that account's
 * own and change from one call to the next. `buildCleanUpANote` is called
 * once per note, with the Panels the Item's Workspace holds at that moment.
 *
 * **`panelId` is constrained to the ids handed in, by the schema itself, not
 * only by the prompt asking nicely.** `enum` on the field is what makes the
 * model structurally unable to answer with an id it was not given - belt and
 * suspenders, because `command-service.ts` checks again at the moment it
 * would write, which is what also catches a Panel deleted in the window
 * between building this call and its answer landing ("Never trust a panel id
 * back", issue 298).
 *
 * **The empty string is "none", the same idiom `readings` uses for "none
 * found".** A schema field that only accepts a real id would make "nothing
 * fits" impossible to say rather than the common, welcome answer it is
 * ("Proposing nothing is a real answer and often the right one", issue 298) -
 * so it is asked for exactly as directly as everything else here, an answer
 * every note gets rather than a value that can be left out.
 *
 * **The four worked examples below stay exactly as `v2` wrote them, panel
 * left empty.** None of the Panels they would be measured against exist
 * outside a real account, so inventing one for a canned example would teach
 * the model to expect a Panel of that name rather than to read the ones it is
 * actually given. The fifth is new, and is the one place this file shows what
 * naming a Panel looks like - the first note once more, with one Panel now on
 * offer, worked out for `panel` alone: its language, title and message would
 * say nothing a second time that the first example didn't already.
 *
 * **`history` and `recentlyCaptured` are rendered as prose sections, not as
 * more worked examples.** A worked example is answered whole, so it teaches
 * the shape of a correct *answer*; history and recent captures are read
 * material the model reasons over before answering, the same as the Panel
 * list above them - not something a fixed example could stand in for without
 * being wrong for every account that is not the one it was written about.
 */
export function buildCleanUpANote(
  panels: readonly { id: string; name: string }[],
  history: readonly DecisionHistoryEntry[],
  recentlyCaptured: readonly string[],
): {
  version: 'v4';
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
    version: 'v4',

    /**
     * Unchanged from `v3`: nothing about reading more before answering
     * changes what the model has to be to answer the rest of this well, and
     * the contract tests are what would notice if that stopped being true.
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
     * The shape the answer is constrained to. `panel` is last, after the two
     * texts and the readings, because nothing about naming a destination needs
     * to be committed to before either text is - unlike `language`, which has
     * to come first for the reason `v1`'s own note gives.
     *
     * Unchanged from `v3`: history and recent captures are read material, not
     * something the answer reports back, so nothing here names either.
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
 * The decision-history section, or a line saying there is none yet - every
 * account's first note ever proposed for reads this, and there is nothing to
 * read back at it.
 *
 * One line per entry, oldest first, each dated ("Learn where notes belong
 * from where you actually file them", issue 299: recency is made legible
 * rather than enforced by a window, since a fixed cutoff cannot tell a
 * project that has gone quiet from one that never existed): the date, the
 * note, and either that it was accepted, that nothing was proposed, or - the
 * stronger signal - both what was proposed and what was chosen where the two
 * differ.
 */
function renderHistory(history: readonly DecisionHistoryEntry[]): string {
  if (history.length === 0) return 'Decision history: (nothing filed yet)';

  const lines = history.map((entry) => {
    const date = entry.decidedAt.slice(0, 10);
    const note = entry.capturedMessage ?? entry.itemTitle;
    // Compared by id, never by name: two Panels of one Workspace can share a
    // display name, and comparing names would misread an override as an
    // accept the moment they do.
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
 * The recently-captured section, or a line saying there is none - most Inbox
 * refreshes have nothing else waiting, and that is the common, unremarkable
 * case rather than a gap in the read.
 */
function renderRecentlyCaptured(recentlyCaptured: readonly string[]): string {
  if (recentlyCaptured.length === 0) {
    return 'Recently captured, not yet filed: (nothing else waiting right now)';
  }

  const lines = recentlyCaptured.map((note) => `- "${note}"`);
  return `Recently captured, not yet filed, most recent first:\n${lines.join('\n')}`;
}
