import { claudeProposalsSchema, isClaudeAction, type ClaudeProposal } from '@cockpit/shared';
import { z } from 'zod';
import { LINK_OR_COMMAND, folded, pointsSomewhere } from '../domain/pointing.js';

/**
 * Reading what the model proposed doing with an Item ("Propose what to do with
 * each item before you look", issue 1161). Pure and apart from the call, as
 * `note-texts.ts` is: every way an answer can be unusable ends in the Item
 * keeping no proposal, and the window opening on the plain prompt.
 */

export type ClaudeProposalsRead = { proposals: ClaudeProposal[] } | { discarded: string };

/** The answer's own flat shape: every field present, empty where it does not apply. */
const answerShape = z.object({
  proposals: z.array(
    z.object({
      destination: z.string(),
      label: z.string(),
      folder: z.string(),
      prompt: z.string(),
      why: z.string(),
    }),
  ),
});

/**
 * Reads an answer into proposals, or says why none is kept.
 *
 * **Validated and discarded, never repaired**, as the clean-up's answers are
 * (architecture, "AI layer"): a destination other than Cowork, Code or nothing,
 * an action with no prompt, a folder it was not offered, nothing beside an
 * action, more than three, a label or reason pointing anywhere, a link or a
 * command in the prompt of an Item someone else sent, or one shaped by past
 * sends, which came from such Items (`fromSomeoneElse`), or
 * anything that is not this shape discards the whole
 * answer rather than keeping the parts that read.
 */
export function readClaudeProposals(
  raw: unknown,
  offeredFolders: readonly string[],
  fromSomeoneElse: boolean,
): ClaudeProposalsRead {
  if (typeof raw !== 'string') return { discarded: 'the answer carried no text' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { discarded: 'the answer was not JSON' };
  }

  const answer = answerShape.safeParse(parsed);
  if (!answer.success) return { discarded: 'the answer was not a list of proposals' };

  // A folder is named by its number in the list offered, never by its path
  // (`propose-for-claude.v4`), and empty for none.
  const folders = answer.data.proposals.map((one) => folderNumbered(one.folder, offeredFolders));
  if (folders.includes(undefined)) return { discarded: 'the answer named a folder it was not offered' };

  const proposals = claudeProposalsSchema.safeParse(
    answer.data.proposals.map((one, at) =>
      one.destination === 'nothing'
        ? { destination: one.destination, why: one.why }
        : { destination: one.destination, label: one.label, folder: folders[at], prompt: one.prompt },
    ),
  );
  if (!proposals.success) return { discarded: 'the answer did not hold to what a proposal is' };
  // A reason and a label are shown in the window beside Cockpit's own words, so
  // neither may carry an address, a link or a number an item could plant there.
  if (proposals.data.some((one) => pointsSomewhere(one.destination === 'nothing' ? one.why : one.label))) {
    return { discarded: 'a reason or a label named an address, a link or a phone number' };
  }
  // The prompt of an Item someone else sent was read out of their words, so it
  // may name whom to reply to but never a link to open or a command to run.
  if (fromSomeoneElse && proposals.data.some((one) => isClaudeAction(one) && LINK_OR_COMMAND.test(folded(one.prompt)))) {
    return { discarded: "a prompt from someone else's item carried a link or a command to run" };
  }
  return { proposals: proposals.data };
}

/** The folder a number names, counting from 1; the empty string for none, and undefined for a number not offered. */
function folderNumbered(answer: string, offered: readonly string[]): string | undefined {
  const said = answer.trim();
  if (said === '') return '';
  if (!/^[1-9]\d*$/.test(said)) return undefined;
  return offered[Number(said) - 1];
}
