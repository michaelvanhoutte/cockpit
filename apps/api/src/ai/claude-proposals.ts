import { claudeProposalsSchema, type ClaudeProposal } from '@cockpit/shared';
import { z } from 'zod';

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
 * action, more than three, or anything that is not this shape discards the whole
 * answer rather than keeping the parts that read.
 */
export function readClaudeProposals(raw: unknown, offeredFolders: readonly string[]): ClaudeProposalsRead {
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
  // (`propose-for-claude.v1`), and empty for none.
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
  return { proposals: proposals.data };
}

/** The folder a number names, counting from 1; the empty string for none, and undefined for a number not offered. */
function folderNumbered(answer: string, offered: readonly string[]): string | undefined {
  const said = answer.trim();
  if (said === '') return '';
  if (!/^[1-9]\d*$/.test(said)) return undefined;
  return offered[Number(said) - 1];
}
