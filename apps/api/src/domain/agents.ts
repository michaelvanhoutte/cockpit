import type { Agent, CreateAgentCommand } from '@cockpit/shared';
import { foldName } from './names.js';

/**
 * Making and finding an Agent ("Keep your agents in a dock, and choose which
 * each dashboard shows", issue 570). Pure, like `item-types.ts` beside this:
 * whether the name is taken is decided from the Agents handed in.
 */

/** The one of `taken` already going by this name, or undefined - folded exactly as an Item Type's is. */
export function agentNamed(taken: readonly Agent[], name: string): Agent | undefined {
  const wanted = foldName(name);
  return taken.find((agent) => foldName(agent.name) === wanted);
}

/**
 * A new Agent, after every Agent there has ever been - the same "highest
 * position, not how many are live" reasoning `itemTypeFromCommand` carries,
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
