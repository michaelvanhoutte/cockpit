import { z } from 'zod';
import { ASK_CLAUDE_COLOR, ASK_CLAUDE_ID, ASK_CLAUDE_NAME, type Agent, type DockTile } from './agent.js';

/**
 * A run: one Agent started on one Item through its Workspace's Claude Code
 * connection ("Drop an agent on an item to start a Claude Code session on
 * it", issue 571). What the row's chip draws and what its menu ends.
 *
 * | Status | Means |
 * |---|---|
 * | `starting` | recorded, and Claude not yet answered |
 * | `working` | Claude accepted, and the session's link is stored |
 * | `link_lost` | Claude accepted, and its link could not be stored |
 * | `unknown` | Claude's answer never arrived, so the session may exist |
 * | `failed` | Claude refused, so there is no session |
 *
 * **A run is open until somebody says the agent finished**, whatever its
 * status - except `failed`, which a new start ends by itself, since nothing
 * is running to be started twice.
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
   * Whether the session last said it stopped for you rather than that it was
   * working ("See on the item when Claude is waiting on you", issue 572) -
   * told by the hooks in the Workspace's repository, and false wherever none
   * has said anything. Defaulted so an answer from before this field reads as
   * working.
   */
  waiting: z.boolean().default(false),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

/**
 * Whether a hook naming these sessions is about the run whose session this
 * link opens (issue 572). A routine's session is `…/session_01…`, and a hook
 * may name it with or without that `session_` - so both sides are compared
 * without it. Never true for a run with no link, which no hook can name.
 */
export function hookNamesSession(sessionUrl: string | null, sessionIds: readonly string[]): boolean {
  if (!sessionUrl) return false;
  let last: string;
  try {
    last = decodeURIComponent(new URL(sessionUrl).pathname.split('/').filter(Boolean).at(-1) ?? '');
  } catch {
    return false;
  }
  const bare = (id: string) => id.trim().replace(/^session_/, '');
  const session = bare(last);
  return session !== '' && sessionIds.some((id) => bare(id) === session);
}

/** How many of these runs are waiting on you - the dock's total, and a tile's where handed one Agent's runs (issue 572). */
export function waitingOnYou(runs: readonly Pick<AgentRun, 'waiting'>[]): number {
  return runs.filter((run) => run.waiting).length;
}

/**
 * Whether an Item's open run stands in the way of starting another one on it
 * ("An Item carries at most one open run", issue 571) - every run does but
 * one Claude refused, which started nothing.
 */
export function runBlocksAStart(run: Pick<AgentRun, 'status'> | undefined): boolean {
  return run !== undefined && run.status !== 'failed';
}

/**
 * The message Ask Claude sends: the question asked, then the Item it is
 * about. Ask Claude has no row of its own to hold a template in (see
 * `ASK_CLAUDE_ID`), so its message is fixed here.
 */
export const ASK_CLAUDE_MESSAGE = '{prompt}\n\nAbout: {title}\n\n{description}\n\n{link}';

/**
 * What starting an Agent needs to know about it, for a made Agent and for Ask
 * Claude alike - the one built in always asks what to ask, and never marks the
 * Item In progress, since asking about something is not starting on it.
 */
export type StartableAgent = Pick<Agent, 'id' | 'name' | 'color' | 'message' | 'asksForPrompt' | 'startsInProgress'>;

export const ASK_CLAUDE_AGENT: StartableAgent = {
  id: ASK_CLAUDE_ID,
  name: ASK_CLAUDE_NAME,
  color: ASK_CLAUDE_COLOR,
  message: ASK_CLAUDE_MESSAGE,
  asksForPrompt: true,
  startsInProgress: false,
};

/**
 * The Agents a Dashboard offers to start, in the dock's order - the tiles it
 * draws, with Ask Claude standing in as the Agent it behaves as. The one
 * answer the row's menu, the drop and the server's own refusal all read, so
 * the three cannot come to disagree about what is offered where.
 */
export function startableAgents(tiles: readonly DockTile[]): StartableAgent[] {
  return tiles.map((tile) => (tile.kind === 'ask-claude' ? ASK_CLAUDE_AGENT : tile.agent));
}

/** How long a question typed into the prompt box may be - well inside the 65,536 characters Claude takes. */
export const agentPromptSchema = z.string().trim().max(4000);

/**
 * What the browser posts to start an Agent on an Item. Never a command: the
 * start calls Claude, which a command replayed on a queue would do again
 * ("Runs twice", issue 571), so the route records the run itself and calls
 * Claude once.
 *
 * `commandId` is what makes the same start sent twice one run and one call to
 * Claude; `dashboardId` is the Dashboard it was started from, which decides
 * whether the Agent is offered there at all.
 */
export const startAgentSchema = z.object({
  commandId: z.uuid(),
  issuedAt: z.iso.datetime(),
  runId: z.uuid(),
  agentId: z.string().min(1).max(200),
  dashboardId: z.string().min(1).max(200),
  prompt: agentPromptSchema.optional(),
});
export type StartAgent = z.infer<typeof startAgentSchema>;

/** What a start answers: how the run stands once Claude has answered, or that this start was already made. */
export const startAgentOutcomeSchema = z.discriminatedUnion('alreadyStarted', [
  z.object({ alreadyStarted: z.literal(false), status: agentRunStatusSchema }),
  /** This exact start had already been made, and Claude was not called again. */
  z.object({ alreadyStarted: z.literal(true) }),
]);
export type StartAgentOutcome = z.infer<typeof startAgentOutcomeSchema>;

/** How long a run may say it is starting before the row stops believing it (see `runChipFor`, apps/web). */
export const STARTING_GIVES_UP_AFTER_MS = 2 * 60 * 1000;
