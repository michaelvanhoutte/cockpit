import { useSyncExternalStore } from 'react';

/**
 * Which Agent a dock tile drag is carrying, while one is in the air ("Drop an
 * agent on an item to start a Claude Code session on it", issue 571).
 *
 * **Recorded here rather than read off the drag**, for the reason
 * `itemInTheAir.ts` gives: a browser hands a drag's data over only on the
 * drop, and every row has to know *before* it - to outline itself as one
 * that will take this Agent, and to say yes to a `dragover` at all.
 *
 * **Subscribable**, unlike `itemInTheAir`, because the outline is drawn: every
 * row that would take the Agent is outlined the moment it is lifted, not only
 * the row under the pointer.
 */

/** The type an Agent is carried under - its own, so no list mistakes it for an Item. */
export const AGENT_BEING_DRAGGED = 'application/x-cockpit-agent';

let inTheAir: string | null = null;
const listeners = new Set<() => void>();

function tell(): void {
  for (const listener of listeners) listener();
}

export function liftAgent(agentId: string): void {
  inTheAir = agentId;
  tell();
}

export function landAgent(): void {
  if (inTheAir === null) return;
  inTheAir = null;
  tell();
}

export function agentInTheAir(): string | null {
  return inTheAir;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The Agent in the air, redrawn as it is lifted and landed. */
export function useAgentInTheAir(): string | null {
  return useSyncExternalStore(subscribe, agentInTheAir, agentInTheAir);
}
