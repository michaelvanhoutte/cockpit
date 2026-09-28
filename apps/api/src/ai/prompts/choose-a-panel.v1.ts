import type { DecisionHistoryEntry } from '../../domain/decision-history.js';
import { renderHistory, renderRecentlyCaptured } from './clean-up-a-note.v8.js';

/**
 * The one Item a panel is being chosen for: what was captured, and the two
 * texts it carries now - proposed or, where somebody edited them, theirs.
 */
export interface ItemToPlace {
  capturedMessage: string;
  title: string;
  description: string | null;
}

/**
 * What Cockpit asks Claude when all it wants back is where an Item belongs -
 * the settled-filing refresh of the rest of an Inbox ("Re-propose the rest of
 * the inbox the moment you file one", issue 300). Version 1.
 *
 * **Its own prompt rather than `clean-up-a-note` with the texts thrown
 * away**, which is what the refresh used to ask: it paid for a title, a
 * message and readings on every Item, on the model chosen for writing them,
 * to keep one field ("Use a cheaper model for panel-only re-proposal", issue
 * 583). Picking one of a short list or none is a narrower task than writing
 * a title, so this carries the routing half of `clean-up-a-note.v8` - the
 * panels, the decision history and what else was captured lately, in the
 * same words - and none of its writing guidance.
 *
 * Moment 2 (`cleanUpACapturedNote`) still routes through `clean-up-a-note`,
 * because it is writing the texts on the same call anyway.
 */
export function buildChooseAPanel(
  item: ItemToPlace,
  panels: readonly { id: string; name: string }[],
  history: readonly DecisionHistoryEntry[],
  recentlyCaptured: readonly string[],
): {
  version: 'v1';
  model: string;
  effort: null;
  system: string;
  message: string;
  schema: Record<string, unknown>;
} {
  const panelList =
    panels.length > 0
      ? panels.map((panel) => `- ${panel.id}: ${panel.name}`).join('\n')
      : '(this account has no panels yet)';

  return {
    version: 'v1',

    /**
     * Haiku 4.5, at $1/$5 per million tokens against Opus 5's $5/$25: the
     * cheapest model that holds the routing properties
     * `clean-up-a-note.v8`'s contract cases hold Opus 5 to
     * (`tests/contract/choose-a-panel.v1.test.ts`). Sonnet 5 held them too,
     * and was not needed.
     *
     * **No `effort`**, which this model refuses, and no thinking, which it
     * does not do by default - a larger model here is a change to both, not
     * only to this string.
     */
    model: 'claude-haiku-4-5',
    effort: null,

    system: `You are part of Cockpit, one person's inbox for their own work.

An item is waiting in their inbox. You decide whether it clearly belongs on one of the panels this account has already set up - buckets it files its own notes into, each named for what belongs there - and nothing else: you do not rewrite the item.

Where it clearly belongs on one of them, name its id and say in a few words why, about the item and the panel rather than about yourself - "a compliance question, about the validation protocol" rather than "I chose this because it mentions compliance". Most items belong on none of them: a panel is not owed an item merely for being the closest match, and naming the wrong one costs more than naming none. Only name one where you are confident a person filing their own notes would put it there themselves. Where none fits, answer with the empty id and the empty reason.

The item arrives as the note that was captured, followed by the title and description it carries now. Read them as one piece of work; the title and description may have been corrected by the person themselves.

Panels:
${panelList}

You are also given this account's own decision history: its most recent settled filings, oldest first, with what was proposed and what they actually chose. It is the only place learning happens here - there is no separate training step. Recent entries say what is live right now; older ones still say how this person files in general, and both matter, but where they disagree favor the recent one - a project can go quiet for a while and an older habit can still hold. Where an entry shows one panel was proposed and they filed it on another, that correction outweighs an entry where they simply accepted what was proposed - it names a wrong answer as well as a right one, so read it as the stronger signal.

${renderHistory(history)}

You are also given what else has been captured in this workspace recently and not yet filed - separate from the history above, because none of it has been decided yet. It is still evidence: what somebody is writing notes about right now, before any of it has a destination. Weigh it alongside the history, never above it - an actual past decision is a stronger signal than a guess at a pattern in still-unfiled notes.

${renderRecentlyCaptured(recentlyCaptured)}`,

    message: `Captured note: ${item.capturedMessage}\nTitle: ${item.title}\nDescription: ${item.description ?? '(none)'}`,

    schema: {
      type: 'object',
      properties: {
        panelId: {
          type: 'string',
          enum: [...panels.map((panel) => panel.id), ''],
          description:
            'The id of the one panel this item clearly belongs on, copied exactly from the list - or the empty string where none of them does, the common case and a real answer.',
        },
        reason: {
          type: 'string',
          description:
            'A few words saying why, about the item and the panel rather than about yourself. Empty exactly when panelId is empty.',
        },
      },
      required: ['panelId', 'reason'],
      additionalProperties: false,
    },
  };
}
