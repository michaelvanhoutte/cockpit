import { z } from 'zod';
import { claudeDestinationSchema } from './claude-send.js';

/**
 * A run: an Item sent to Cowork or Claude Code ("Send an item to Cowork or
 * Claude Code with its prompt reviewed first", issue 1159), or one an Agent
 * started before Agents were retired ("Retire the agents' dock and routines,
 * keeping what each agent knew", issue 1165), which stays readable and still
 * names its Agent. What the row's chip draws.
 *
 * | Status | Means |
 * |---|---|
 * | `starting` | recorded, and Claude not yet answered |
 * | `working` | Claude accepted, and the session's link is stored |
 * | `link_lost` | Claude accepted, and its link could not be stored |
 * | `unknown` | Claude's answer never arrived, so the session may exist |
 * | `failed` | Claude refused, so there is no session |
 *
 * **A run is open until the Item's Status ends it** (Done, To do or
 * Dismiss; an Undo of Done or Dismiss reopens it), whatever its status -
 * except `failed`, which a new start ends by itself, since nothing is
 * running to be started twice.
 */
export const AGENT_RUN_STATUSES = ['starting', 'working', 'link_lost', 'unknown', 'failed'] as const;
export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentRunSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  agentId: z.string(),
  /** The Agent's name as it is now, or null where it has been deleted since. */
  agentName: z.string().nullable(),
  status: agentRunStatusSchema,
  /** The Claude Code session, where Claude accepted and the link was stored. */
  sessionUrl: z.string().nullable(),
  /** Why Claude refused, in words, where it did. */
  reason: z.string().nullable(),
  startedAt: z.iso.datetime(),
  /**
   * Whether an Agent's session last said it stopped for you rather than that
   * it was working ("See on the item when Claude is waiting on you", issue
   * 572) - what the repository's hooks said while they still reported, and
   * false wherever none did. Defaulted so an answer from before this field
   * reads as working.
   */
  waiting: z.boolean().default(false),
  /**
   * Where an Item was sent to Claude, for a Run made by *Send to Claude…*
   * (issue 1159) rather than by an Agent - which names no Agent (its `agentId` is empty), and whose
   * status is `working` for want of a better one the stored list accepts. Null
   * for an Agent's run; absent in an answer from before this field, which reads the same.
   */
  destination: claudeDestinationSchema.nullable().optional(),
  /** The folder it was sent to open in; null where none was chosen. */
  folder: z.string().nullable().optional(),
  /** Where a sent Run stands - `sent` until Claude reports back; null for an Agent's run. */
  stage: z.string().nullable().optional(),
  /** What the Run made, once Claude reports it. */
  resultUrl: z.string().nullable().optional(),
  /** What Claude said with its last report: the answer, or the question it needs answered (issue 1160). */
  note: z.string().nullable().optional(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

/**
 * Whether an Item's open run stands in the way of sending it to Claude again
 * ("An Item carries at most one open run", issue 571) - every run does but
 * one Claude refused, which started nothing.
 */
export function runBlocksAStart(run: Pick<AgentRun, 'status'> | undefined): boolean {
  return run !== undefined && run.status !== 'failed';
}

/** How long a run may say it is starting before the row stops believing it (see `runChipFor`, apps/web). */
export const STARTING_GIVES_UP_AFTER_MS = 2 * 60 * 1000;
