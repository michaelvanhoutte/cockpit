import { z } from 'zod';
import { claudeFolderSchema } from './claude-send.js';
import { REMEMBERED_SENTENCES_SHOWN } from './remembered-sentence.js';

/**
 * What Cockpit proposes doing with an Item before anybody looks ("Propose what
 * to do with each item before you look", issue 1161): one proposal per action,
 * each a destination with the folder to open in and the prompt to send - or,
 * for an Item that needs no action, a single proposal of nothing saying why.
 * Written onto the Item by the enrichment queue, as its proposed Panel is, and
 * read by the review window, which opens on the first.
 */

/** The most actions one Item is proposed: more is a project, not an Item. */
export const CLAUDE_PROPOSALS_PER_ITEM = 3;

/** The longest proposed prompt; the window's own address limit is far above it. */
export const CLAUDE_PROPOSAL_PROMPT_LIMIT = 8000;

/** The longest label naming one action among several, and the longest reason for proposing nothing. */
export const CLAUDE_PROPOSAL_LABEL_LIMIT = 120;
export const CLAUDE_PROPOSAL_WHY_LIMIT = 300;

/** One action: where it goes, the folder Claude opens in (empty for none), and the prompt. */
export const claudeActionProposalSchema = z.object({
  destination: z.enum(['cowork', 'code']),
  /** A few words naming the action, for choosing among several. */
  label: z.string().trim().min(1).max(CLAUDE_PROPOSAL_LABEL_LIMIT),
  folder: claudeFolderSchema,
  prompt: z.string().trim().min(1).max(CLAUDE_PROPOSAL_PROMPT_LIMIT),
  /**
   * The remembered sentences it was made with ("See and change what Cockpit
   * remembers", issue 1164), named by the window as *Learned from you*. Ids
   * only: the window reads the sentences as they are now, and one since
   * deleted names nothing.
   */
  learnedFrom: z.array(z.uuid()).max(REMEMBERED_SENTENCES_SHOWN).optional(),
});

/** Nothing to do - a quote, a saved idea - and why, in a sentence. */
export const claudeNothingProposalSchema = z.object({
  destination: z.literal('nothing'),
  why: z.string().trim().min(1).max(CLAUDE_PROPOSAL_WHY_LIMIT),
});

export const claudeProposalSchema = z.union([claudeActionProposalSchema, claudeNothingProposalSchema]);
export type ClaudeProposal = z.infer<typeof claudeProposalSchema>;
export type ClaudeActionProposal = z.infer<typeof claudeActionProposalSchema>;

/**
 * An Item's proposals, in the order they are offered: one to three actions, or
 * nothing alone - "nothing" beside an action would contradict it.
 */
export const claudeProposalsSchema = z
  .array(claudeProposalSchema)
  .min(1)
  .max(CLAUDE_PROPOSALS_PER_ITEM)
  .refine((proposals) => proposals.length === 1 || proposals.every((one) => one.destination !== 'nothing'), {
    message: 'nothing to do is proposed alone',
  });

/** Whether a proposal is an action rather than nothing. */
export function isClaudeAction(proposal: ClaudeProposal): proposal is ClaudeActionProposal {
  return proposal.destination !== 'nothing';
}
