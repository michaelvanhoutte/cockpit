import type { DecisionHistoryEntry } from '../../domain/decision-history.js';

/**
 * What Cockpit asks Claude for once a night, per Workspace: a plain-English
 * summary of how notes actually get filed there, read back on a settings
 * screen and correctable in a sentence ("Show what the system learned, in a
 * sentence you can correct", issue 301).
 *
 * **Reads the same decision history `clean-up-a-note` reads, and nothing
 * else.** No recently-captured section: this is not proposing anything for
 * one note, it is describing a pattern across every settled filing, so what
 * is still sitting unfiled has nothing to add. `buildSummarizeFilingPatterns`
 * is only ever called where the history is non-empty - a fresh Workspace with
 * nothing filed yet has no pattern to summarize, and the job that calls this
 * (`jobs/enrichment.ts`'s `summarizeWorkspace`) simply does not, the same way
 * `cleanUpACapturedNote` never calls its own model for an Item with no
 * captured message.
 *
 * **The summary is always written in English**, unlike the note-cleanup
 * prompt: it is the system's own account of a pattern across many notes in
 * however many languages they were written in, not a rewrite of any one of
 * them, so there is no single note language for it to match.
 *
 * **Same model and effort as `clean-up-a-note`** (`claude-opus-5` at
 * `effort: 'low'`), as a starting point rather than a fresh measurement: this
 * is the same account reading the same shape of history to answer a related
 * question, and the contract test is what would notice if that choice stops
 * holding up for a summary specifically.
 */
export function buildSummarizeFilingPatterns(history: readonly DecisionHistoryEntry[]): {
  version: 'v1';
  model: string;
  effort: 'low';
  system: string;
  schema: Record<string, unknown>;
} {
  return {
    version: 'v1',
    model: 'claude-opus-5',
    effort: 'low',

    system: `You are part of Cockpit, one person's inbox for their own work.

Every night, you read this person's whole filing history for one Workspace - every note they have filed so far, oldest first, with what Cockpit proposed and what they actually chose - and write a short, plain-English summary of the pattern in how they file things. Somebody reads this summary on a settings screen; it is the one place they can see what the system believes about how they work, and correct it in a sentence if it is wrong.

Write two or three sentences, in plain English, as if describing this person's habits to a colleague who has never seen their filing. Name the kinds of notes that go where, and how you can tell - a topic, a person, a phrase, a pattern in what gets overridden. Where an override recurs - the same kind of note corrected the same way more than once - say so plainly: that is the strongest signal in the history, because it names a wrong answer as well as a right one.

Say what is live right now, not only what is true in general, where the history shows it: a project that has filled the last several entries and then gone quiet is worth naming, the same way a project that has come back after a gap is. Recency matters here exactly as it does when proposing a single note's destination - a habit from months ago can still hold, but where the history disagrees with itself over time, the more recent pattern is the one to describe as current.

Write about the pattern, never about a single note - do not quote or describe one specific note by name unless it is the clearest example of a pattern that recurs elsewhere in the history too. This is read by the person whose notes these are, so write to them directly rather than about them in the third person - "you" and "your", not "they" and "their".

Say nothing this history does not actually show. A short history with only one or two entries may not have a pattern worth naming yet - say so plainly rather than inventing structure that is not there.

Decision history, oldest first:
${renderHistory(history)}`,

    schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'Two or three plain-English sentences describing the pattern in how this person files their notes, written directly to them, naming what is live right now where the history shows it.',
        },
      },
      required: ['summary'],
      additionalProperties: false,
    },
  };
}

/**
 * One line per entry, oldest first, each dated - the same rendering
 * `clean-up-a-note.v5.ts`'s own `renderHistory` uses, kept identical rather
 * than shared: the two prompts are versioned independently, and a change to
 * one's rendering must not silently reach the other (architecture, "Prompts
 * are versioned files in the repository, reviewed like code").
 */
function renderHistory(history: readonly DecisionHistoryEntry[]): string {
  const lines = history.map((entry) => {
    const date = entry.decidedAt.slice(0, 10);
    const note = entry.capturedMessage ?? entry.itemTitle;
    const outcome =
      entry.proposedPanelId === null
        ? `filed on ${entry.chosenPanelName} (nothing was proposed)`
        : entry.proposedPanelId === entry.chosenPanelId
          ? `filed on ${entry.chosenPanelName} (accepted the proposal)`
          : `Cockpit proposed ${entry.proposedPanelName}, but it was filed on ${entry.chosenPanelName} instead`;
    return `${date}: "${note}" — ${outcome}`;
  });

  return lines.join('\n');
}
