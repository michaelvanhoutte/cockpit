import { itemLabel, type AgentRun, type Item } from '@cockpit/shared';
import { whyNot, type Refused, type Sending } from './bulkEdit';

/**
 * Ending a Claude run without finishing its Item ("End a Claude run from its row,
 * and make Needs you say what Claude is asking", issue 1770). The deciding is here,
 * and pure: which entries the row's Claude group holds, which picked rows the
 * selection bar acts on, and what each Undo sends. The sending is handed in.
 */

/** What the Claude group of a row's menu holds, in order, so a decision with cases is proved without a drawn menu. */
export type ClaudeEntry = 'send' | 'session' | 'end';

export function claudeEntriesFor(options: {
  /** *Send to Claude…* is on offer: a desk screen, nothing running on the row. */
  canSend: boolean;
  /** Where the run's session opens, or null where it has no link. */
  sessionHref: string | null;
  /** Whether the Item has an open run. */
  hasRun: boolean;
}): ClaudeEntry[] {
  return [
    ...(options.canSend ? (['send'] as const) : []),
    ...(options.sessionHref ? (['session'] as const) : []),
    ...(options.hasRun ? (['end'] as const) : []),
  ];
}

/** One picked row with the run the bar would end on it. */
export interface Target {
  item: Item;
  run: AgentRun;
}

/** The picked rows that have an open run, in the order picked; the rest are left alone. */
export function targetsOf(items: readonly Item[], runs: readonly AgentRun[]): Target[] {
  return items.flatMap((item) => {
    const run = runs.find((one) => one.itemId === item.id);
    return run ? [{ item, run }] : [];
  });
}

/** What *End Claude run* says on the selection bar: available, or why not. */
export function barEntryFor(targets: readonly Target[]): { available: boolean; why: string | null } {
  return targets.length > 0
    ? { available: true, why: null }
    : { available: false, why: 'None of them has a Claude run' };
}

/** What the offer to undo says happened. */
export function whatWasEnded(targets: readonly Target[]): string {
  const only = targets.length === 1 ? targets[0]!.item : null;
  return `Claude run ended on ${only ? `“${itemLabel(only)}”` : `${targets.length} items`}`;
}

/** The command that ends a run, with the envelope the caller made for its Item. */
export function endCommand(run: AgentRun, envelope: ReturnType<ReturnType<Sending['envelope']>>) {
  return { name: 'end_claude_run' as const, payload: { ...envelope, runId: run.id } };
}

/** The Undo of an end: the same command naming the run, asking for it back. */
export function reopenCommand(run: AgentRun, envelope: ReturnType<ReturnType<Sending['envelope']>>) {
  return { name: 'end_claude_run' as const, payload: { ...envelope, runId: run.id, reopen: true } };
}

/**
 * Ends the run of every target, one command each. **Every command is handed
 * over before any is awaited**, so the tab's queue draws the whole selection at
 * once and sends them one after another; `onStarted` is told when that is done,
 * which is when an Undo can be offered. A refusal is recorded against its Item
 * and the run goes on.
 */
export function endSeveral(
  sending: Sending,
  options: {
    targets: readonly Target[];
    onStarted?: (answer: Promise<{ ended: Target[]; refused: Refused[] }>) => void;
  },
): Promise<{ ended: Target[]; refused: Refused[] }> {
  const sends = options.targets.map((target) => {
    const send = sending.send(endCommand(target.run, sending.envelope(target.item.id)()));
    send.catch(() => {});
    return { target, send };
  });
  const answer = (async () => {
    const ended: Target[] = [];
    const refused: Refused[] = [];
    for (const { target, send } of sends) {
      try {
        await send;
        ended.push(target);
      } catch (error) {
        refused.push({ item: target.item, why: whyNot(error) });
      }
    }
    return { ended, refused };
  })();
  options.onStarted?.(answer);
  return answer;
}

/** Brings back the runs an end took off, one after another, stopping at the first refusal and saying how far it got. */
export async function reopenSeveral(sending: Sending, ended: readonly Target[]): Promise<void> {
  for (const [at, target] of ended.entries()) {
    try {
      await sending.send(reopenCommand(target.run, sending.envelope(target.item.id)()));
    } catch (error) {
      throw new Error(`${at} of ${ended.length} put back, the rest still ended. ${whyNot(error)}`);
    }
  }
}
