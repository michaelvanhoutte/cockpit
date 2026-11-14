import type { AgentRun } from '@cockpit/shared';

/**
 * The runs this tab ended with *End Claude run* (issue 1770), kept by run id so its
 * Undo can draw the run back at once, after the end's read has landed and the held
 * copy no longer holds it. Local to the tab and never sent. Bounded: the oldest go
 * first.
 */
const KEPT = 50;
const ended = new Map<string, AgentRun>();

export function rememberEnded(run: AgentRun): void {
  ended.delete(run.id);
  ended.set(run.id, run);
  while (ended.size > KEPT) ended.delete(ended.keys().next().value as string);
}

export function endedRun(runId: string): AgentRun | undefined {
  return ended.get(runId);
}

/** For tests: forgets every run. */
export function forgetEndedRuns(): void {
  ended.clear();
}
