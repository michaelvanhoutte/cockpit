import { REMEMBERED_ACTION_LIMIT, REMEMBERED_SENTENCE_LIMIT } from '@cockpit/shared';
import { z } from 'zod';
import { LINK_OR_COMMAND, folded, pointsSomewhere } from '../domain/pointing.js';

/**
 * Reading what the model offered to remember from an edit ("Remember an edit as
 * a sentence you confirm", issue 1163). Pure and apart from the call, as
 * `claude-proposals.ts` is: every way an answer can be unusable ends in no offer
 * and the send kept as it was.
 */

/** The offer as the window shows it, before the server adds where the Item came from. */
export interface ReadOffer {
  sentence: string;
  action: string;
  workspaceId: string | null;
  workspaceName: string | null;
}

/** An offer, or why there is none - which is the usual answer, not a fault. */
export type SentenceOfferRead = { offer: ReadOffer } | { none: string };

const answerShape = z.object({ sentence: z.string(), action: z.string(), workspace: z.string() });

/**
 * Reads an answer into an offer, or says why there is none.
 *
 * **Validated and discarded, never repaired.** Shown only if it fits: a
 * sentence and the kind of action it is for, both non-empty and not longer than
 * the store keeps; a sentence that is one line; a Workspace that is one of the
 * account's, where one is named. **A sentence pointing anywhere is no offer**:
 * an address, a link, a phone number or a command to run is what a stranger's
 * mail would plant in an edit, and a sentence is shown to every later proposal.
 */
export function readSentenceOffer(raw: unknown, workspaces: readonly { id: string; name: string }[]): SentenceOfferRead {
  if (typeof raw !== 'string') return { none: 'the answer carried no text' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { none: 'the answer was not JSON' };
  }
  const answer = answerShape.safeParse(parsed);
  if (!answer.success) return { none: 'the answer was not a sentence, an action and a workspace' };

  // One line, however the model broke it.
  const sentence = answer.data.sentence.replace(/\s+/g, ' ').trim();
  const action = answer.data.action.replace(/\s+/g, ' ').trim();
  if (sentence === '') return { none: 'nothing worth remembering' };
  if (action === '') return { none: 'the sentence names no kind of action' };
  if (sentence.length > REMEMBERED_SENTENCE_LIMIT) return { none: 'the sentence is too long' };
  if (action.length > REMEMBERED_ACTION_LIMIT) return { none: 'the kind of action is named at length' };
  if (pointsSomewhere(sentence) || pointsSomewhere(action) || LINK_OR_COMMAND.test(folded(sentence))) {
    return { none: 'the sentence named an address, a link, a phone number or a command' };
  }

  const named = answer.data.workspace.trim();
  if (named === '') return { offer: { sentence, action, workspaceId: null, workspaceName: null } };
  const workspace = workspaces.find((one) => one.name.trim().toLowerCase() === named.toLowerCase());
  if (!workspace) return { none: 'the sentence named a workspace this account does not have' };
  return { offer: { sentence, action, workspaceId: workspace.id, workspaceName: workspace.name } };
}
