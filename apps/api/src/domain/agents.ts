import { agentsShownOnDashboard, runBlocksAStart } from '@cockpit/shared';
import type { Agent, AgentRun, CreateAgentCommand, Item } from '@cockpit/shared';
import { couldStillBeActedOn } from './duplicates.js';
import { foldName } from './names.js';

/**
 * Making and finding an Agent ("Keep your agents in a dock, and choose which
 * each dashboard shows", issue 570). Pure, like every other handler
 * here: whether the name is taken is decided from the Agents handed in.
 */

/** The one of `taken` already going by this name, or undefined - folded like every other name in the app. */
export function agentNamed(taken: readonly Agent[], name: string): Agent | undefined {
  const wanted = foldName(name);
  return taken.find((agent) => foldName(agent.name) === wanted);
}

/**
 * A new Agent, after every Agent there has ever been - the same "highest
 * position, not how many are live" reasoning every ordered list here uses,
 * so a new tile joins the end of the dock rather than the front.
 */
export function agentFromCommand(
  cmd: CreateAgentCommand,
  tenantId: string,
  lastPosition: number | null,
): Agent {
  return {
    id: cmd.agentId,
    tenantId,
    name: cmd.name,
    color: cmd.color,
    engine: cmd.engine,
    message: cmd.message,
    asksForPrompt: cmd.asksForPrompt,
    startsInProgress: cmd.startsInProgress,
    position: lastPosition === null ? 0 : lastPosition + 1,
    createdAt: cmd.issuedAt,
  };
}

/**
 * Everything the store loads to decide a start: the Item, whether it is filed
 * on a dashboard, that dashboard and the agents it offers, whether the
 * Workspace holds a Claude Code connection, and the Item's open run if any.
 */
export interface AgentStartFacts {
  item: Pick<Item, 'completedAt' | 'deletedAt'>;
  dashboardId: string;
  dashboardExists: boolean;
  hasClaudeCodeConnection: boolean;
  itemIsFiled: boolean;
  agentId: string;
  agents: readonly Agent[];
  hiddenAgentIds: readonly string[];
  openRun: Pick<AgentRun, 'status'> | undefined;
}

/** Why an agent may not start, for the caller to say in the words its layer has for it. */
export type AgentStartRefusal =
  | { refusal: 'item-not-to-be-done' }
  | { refusal: 'dashboard-not-found'; id: string }
  | { refusal: 'no-claude-code-connection' }
  | { refusal: 'item-in-inbox' }
  | { refusal: 'agent-not-on-dashboard' }
  | { refusal: 'claude-already-on-item' };

/**
 * An accepted start. A run Claude refused may still be open; the start that
 * replaces it ends it, which is a write the store makes from the run it loaded.
 */
export interface AgentStartDecided {
  refusal: null;
}

/**
 * Whether an agent may begin on an Item ("Drop an agent on an item to start a
 * Claude Code session on it", issue 571). Checked in the order a person would
 * meet them, which is the order the messages have always come in.
 */
export function decideAgentStart(facts: AgentStartFacts): AgentStartRefusal | AgentStartDecided {
  if (!couldStillBeActedOn(facts.item) || facts.item.completedAt !== null) {
    return { refusal: 'item-not-to-be-done' };
  }
  if (!facts.dashboardExists) return { refusal: 'dashboard-not-found', id: facts.dashboardId };
  if (!facts.hasClaudeCodeConnection) return { refusal: 'no-claude-code-connection' };
  if (!facts.itemIsFiled) return { refusal: 'item-in-inbox' };
  const offered = agentsShownOnDashboard({ agents: facts.agents, hiddenAgentIds: facts.hiddenAgentIds });
  if (!offered.some((agent) => agent.id === facts.agentId)) return { refusal: 'agent-not-on-dashboard' };
  if (runBlocksAStart(facts.openRun)) return { refusal: 'claude-already-on-item' };
  return { refusal: null };
}
