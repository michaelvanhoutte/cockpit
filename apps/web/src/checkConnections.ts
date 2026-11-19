import type { ConnectionHistory, WorkspaceCheckedNow } from '@cockpit/shared';
import { api, refusal } from './api/client';
import type { HistoryAnnounced } from './checkEnds';
import { CHECK_TAKES_LONG_MS, checkWaitingNote, type CheckAsked } from './connectionHistory';

/**
 * What the Inbox's ↻ waits on ("Inbox: mail you just labelled waits for the five-minute check, or a Check now per connection in Settings: add a ↻ to the Inbox heading that checks them all now", issue 1835), pure so the heading draws exactly what a test reads. Drawn from the ↻'s own chunk (`components/CheckConnections.tsx`), so it stays out of the first bundle.
 */

/** One pulled connection of the Workspace, as its read lists it. */
export interface Checkable {
  sourceAccountId: string;
  name: string;
}

/** What one connection's announcement of a check's end says, with the line's time. */
export interface Ended {
  failed: boolean;
  broughtIn: number;
  closed: number;
  at: string;
}

/**
 * A press, from the click until the last connection it asked for has ended.
 * `since` is the server's time at the press, known once it answers; until then
 * announcements are held, since a quick check can end before the answer lands.
 */
export interface CheckRun {
  /** Which press this is, so an answer or a refusal of an earlier one cannot end a later. */
  id: number;
  workspaceId: string;
  /** The connections asked for: the Workspace's checkable ones until the server answers, then the ones it checked. */
  asked: Checkable[];
  since: string | null;
  /** Every announcement heard for the Workspace since the press, in the order heard. */
  heard: { sourceAccountId: string; ended: Ended }[];
}

let presses = 0;

/** A press: asked of the connections the Workspace's read lists. */
export function pressed(workspaceId: string, checkable: readonly Checkable[]): CheckRun {
  return { id: ++presses, workspaceId, asked: [...checkable], since: null, heard: [] };
}

/** The server answered: it checked these, and the press was at `at`. */
export function answered(run: CheckRun, answer: WorkspaceCheckedNow, checkable: readonly Checkable[]): CheckRun {
  const names = new Map(checkable.map((one) => [one.sourceAccountId, one.name]));
  return {
    ...run,
    since: answer.at,
    asked: answer.connections.map((one) => ({ sourceAccountId: one.sourceAccountId, name: names.get(one.sourceAccountId) ?? 'A connection' })),
  };
}

/** What an announcement says of a connection's check, or null where it says nothing a press can use - one from an older Worker, which carries no time. */
export function endedBy(event: HistoryAnnounced): Ended | null {
  if (event.at === undefined || event.outcome === undefined) return null;
  return { failed: event.outcome === 'failed', broughtIn: event.broughtIn ?? 0, closed: event.closed ?? 0, at: event.at };
}

/** An announcement heard: kept where it is of this Workspace and one the press asked for (or may yet ask for). */
export function heard(run: CheckRun, workspaceId: string, sourceAccountId: string, ended: Ended): CheckRun {
  if (workspaceId !== run.workspaceId) return run;
  return { ...run, heard: [...run.heard, { sourceAccountId, ended }] };
}

/** How a connection's own history says it ended since a time, for a connection whose announcement was missed: the first line at or after it, which is the check the press waits on. */
export function endedByHistory(history: ConnectionHistory, since: string): Ended | null {
  const first = history.lines.findLast((line) => line.lastAt >= since);
  if (!first) return null;
  return { failed: first.outcome === 'failed', broughtIn: first.did.broughtIn.count, closed: first.did.closed.count, at: first.lastAt };
}

/** What each connection asked for has ended with, once the server's time is known: the first announcement at or after it. */
export function endings(run: CheckRun): Map<string, Ended> {
  const done = new Map<string, Ended>();
  if (run.since === null) return done;
  const asked = new Set(run.asked.map((one) => one.sourceAccountId));
  for (const { sourceAccountId, ended } of run.heard) {
    // The first word of a connection's end stands: a read of its history after a reconnect and the announcement of the same line are one end.
    if (!asked.has(sourceAccountId) || ended.at < run.since || done.has(sourceAccountId)) continue;
    done.set(sourceAccountId, ended);
  }
  return done;
}

/** The connections asked for that have not ended. */
export function stillOut(run: CheckRun): Checkable[] {
  const done = endings(run);
  return run.asked.filter((one) => !done.has(one.sourceAccountId));
}

/** Whether every connection asked for has ended: false before the server has answered. */
export function hasEnded(run: CheckRun): boolean {
  return run.since !== null && stillOut(run).length === 0;
}

const connections = (count: number) => `${count} ${count === 1 ? 'connection' : 'connections'}`;

/** The note at the press, before the server answers. */
export function askedNote(count: number): string {
  return `Checking ${connections(count)} now.`;
}

/** What the note says once every connection has ended, and which of them failed. */
export function endedNote(run: CheckRun): { text: string; failed: Checkable[] } {
  const done = endings(run);
  const broughtIn = [...done.values()].reduce((sum, one) => sum + one.broughtIn, 0);
  const closed = [...done.values()].reduce((sum, one) => sum + one.closed, 0);
  const found = [broughtIn > 0 ? `${broughtIn} new` : null, closed > 0 ? `${closed} closed` : null].filter(Boolean).join(', ');
  return {
    text: `Checked ${connections(run.asked.length)} · ${found || 'nothing new'}`,
    failed: run.asked.filter((one) => done.get(one.sourceAccountId)?.failed),
  };
}

/** The note a minute into a wait: the Settings card's own, naming the first connection still out. */
export function slowNote(run: CheckRun): { ok: boolean; text: string } | null {
  const [first] = stillOut(run);
  if (!first || run.since === null) return null;
  const asked: CheckAsked = { sourceAccountId: first.sourceAccountId, name: first.name, since: run.since, status: 'queued' };
  return checkWaitingNote(asked, CHECK_TAKES_LONG_MS);
}

/**
 * The Workspace's pulled connections checked at once, from the Inbox's heading.
 * Its own function rather than a command - it changes no Item or setting, only
 * when the next checks run.
 */
export async function checkWorkspaceConnectionsNow(workspaceId: string): Promise<WorkspaceCheckedNow> {
  const res = await api.v1.workspaces[':workspaceId'].connections['check-now'].$post({ param: { workspaceId } });
  if (!res.ok) throw refusal('checking the connections', res.status);
  // Read as the server sends it, which the type says: parsing it here would put its schema in the Inbox's chunk.
  return (await res.json()) as WorkspaceCheckedNow;
}

/** The run without the connections the Workspace no longer lists, which are never announced again. */
export function withoutDisconnected(run: CheckRun, checkable: readonly Checkable[]): CheckRun {
  const listed = new Set(checkable.map((one) => one.sourceAccountId));
  const asked = run.asked.filter((one) => listed.has(one.sourceAccountId));
  return asked.length === run.asked.length ? run : { ...run, asked };
}
