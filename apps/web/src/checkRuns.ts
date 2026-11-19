import { useSyncExternalStore } from 'react';
import { NOT_REACHED, SEND_TIMEOUT_MS } from './changeQueue';
import { WorkingOffline, refuseWhileOffline } from './offline';
import { RECONNECTED } from './updating';
import { hearCheckEnds } from './checkEnds';
import { CHECK_TAKES_LONG_MS } from './connectionHistory';
import {
  answered,
  askedNote,
  checkWorkspaceConnectionsNow,
  endedBy,
  endedByHistory,
  endedNote,
  hasEnded,
  heard,
  pressed,
  slowNote,
  stillOut,
  withoutDisconnected,
  type Checkable,
  type CheckRun,
} from './checkConnections';

/**
 * The Inbox's ↻ presses, one per Workspace, held here and not in the heading
 * ("Inbox: mail you just labelled waits for the five-minute check, or a Check now per connection in Settings: add a ↻ to the Inbox heading that checks them all now", issue 1835): leaving the Inbox screen on a phone, or collapsing the column at a desk, unmounts the heading, and a press still waiting must be there when it is drawn again. Module-level as `checkEnds.ts` is, which is also what lets the stream's announcements reach it.
 */

/** What the note under the Inbox's heading says. `working` notes stay while the ↻ spins; the others go after `NOTE_STAYS_MS`, unless they name a failed connection. */
export interface CheckNote {
  ok: boolean;
  text: string;
  failed: Checkable[];
  working: boolean;
}

/** One Workspace's press: its run, what it says, and whether the ↻ spins. */
export interface CheckState {
  run: CheckRun | null;
  note: CheckNote | null;
  checking: boolean;
  /** Whether the run has said it is taking long, after which a press starts a new one. */
  slow: boolean;
}

/** How long a note that says how it ended stays up. */
export const NOTE_STAYS_MS = 8_000;

const IDLE: CheckState = { run: null, note: null, checking: false, slow: false };
let states = new Map<string, CheckState>();
const listeners = new Set<() => void>();
const timers = new Map<string, { slow?: ReturnType<typeof setTimeout>; note?: ReturnType<typeof setTimeout> }>();

const stateOf = (workspaceId: string): CheckState => states.get(workspaceId) ?? IDLE;

function set(workspaceId: string, next: Partial<CheckState>): CheckState {
  const merged = { ...stateOf(workspaceId), ...next };
  states.set(workspaceId, merged);
  listeners.forEach((listener) => listener());
  return merged;
}

const timersOf = (workspaceId: string) => {
  let held = timers.get(workspaceId);
  if (!held) timers.set(workspaceId, (held = {}));
  return held;
};

function stopTimers(workspaceId: string, which: 'slow' | 'note' | 'both' = 'both'): void {
  const held = timersOf(workspaceId);
  if (which !== 'note') clearTimeout(held.slow);
  if (which !== 'slow') clearTimeout(held.note);
}

/** A note, with the timer that takes it down where it only says how a press ended. */
function say(workspaceId: string, text: string, over: Partial<CheckNote> = {}): void {
  const note: CheckNote = { ok: true, text, failed: [], working: false, ...over };
  stopTimers(workspaceId, 'note');
  const shown = set(workspaceId, { note }).note;
  if (note.working || note.failed.length > 0) return;
  timersOf(workspaceId).note = setTimeout(() => {
    if (stateOf(workspaceId).note === shown) set(workspaceId, { note: null });
  }, NOTE_STAYS_MS);
}

/** The press is over, however it ended. */
function finish(workspaceId: string): void {
  stopTimers(workspaceId, 'slow');
  set(workspaceId, { run: null, checking: false, slow: false });
}

function end(workspaceId: string, last: CheckRun): void {
  const { text, failed } = endedNote(last);
  finish(workspaceId);
  say(workspaceId, text, { ok: failed.length === 0, failed });
}

function hear(workspaceId: string, next: CheckRun): void {
  set(workspaceId, { run: next });
  if (hasEnded(next)) end(workspaceId, next);
}

/** Settles with what `work` settles with, or rejects once `ms` has passed: a request or read that never answers is not waited on for ever. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(NOT_REACHED)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Reads the history of each connection of a run still out, once, and counts what ended as ended. */
function readStillOut(workspaceId: string, current: CheckRun): Promise<unknown> {
  const since = current.since;
  if (since === null) return Promise.resolve();
  return Promise.all(
    stillOut(current).map((one) =>
      within(
        import('./components/ConnectionHistory').then(({ fetchHistory }) => fetchHistory(current.workspaceId, one.sourceAccountId)),
        SEND_TIMEOUT_MS,
      )
        .then((history) => {
          const ended = endedByHistory(history, since);
          const now = stateOf(workspaceId).run;
          if (!ended || now?.id !== current.id) return;
          hear(workspaceId, heard(now, now.workspaceId, one.sourceAccountId, ended));
        })
        .catch(() => undefined),
    ),
  );
}

let listening = false;

/** Hears the stream's announcements and its coming back, for every press from now on. */
function listen(): void {
  if (listening) return;
  listening = true;
  hearCheckEnds((event) => {
    const ended = endedBy(event);
    const current = stateOf(event.workspaceId).run;
    if (!current || !ended) return;
    const next = heard(current, event.workspaceId, event.sourceAccountId, ended);
    if (next !== current) hear(event.workspaceId, next);
  });
  // The stream came back: each connection still out is read once, so a check that ended while it was down is not waited on for ever.
  globalThis.addEventListener(RECONNECTED, () => {
    for (const [workspaceId, state] of states) if (state.run) void readStillOut(workspaceId, state.run);
  });
}

/** Presses the ↻ of a Workspace: nothing while a press waits, unless it has said it is taking long. */
export function pressCheck(workspaceId: string, checkable: readonly Checkable[]): void {
  const held = stateOf(workspaceId);
  if (held.run !== null && !held.slow) return;
  try {
    refuseWhileOffline();
  } catch (error) {
    if (!(error instanceof WorkingOffline)) throw error;
    say(workspaceId, error.message, { ok: false });
    return;
  }
  listen();
  stopTimers(workspaceId);
  const first = pressed(workspaceId, checkable);
  set(workspaceId, { run: first, checking: true, slow: false });
  say(workspaceId, askedNote(checkable.length), { working: true });
  // Only the press that is still the live one may act on what comes back: an earlier one's answer or refusal is nobody's.
  const mine = () => stateOf(workspaceId).run?.id === first.id;
  within(checkWorkspaceConnectionsNow(workspaceId), SEND_TIMEOUT_MS).then(
    (answer) => {
      const current = stateOf(workspaceId).run;
      if (!current || !mine()) return;
      const next = answered(current, answer, checkable);
      if (next.asked.length === 0) {
        finish(workspaceId);
        say(workspaceId, 'No connection to check.');
        return;
      }
      hear(workspaceId, next);
    },
    () => {
      if (!mine()) return;
      finish(workspaceId);
      say(workspaceId, NOT_REACHED, { ok: false });
    },
  );
  // A minute from the press with one still out: each is read once in case the stream lost its word, and what is still out is said as the Settings card says it.
  timersOf(workspaceId).slow = setTimeout(() => {
    const current = stateOf(workspaceId).run;
    if (!current || current.id !== first.id) return;
    void readStillOut(workspaceId, current).then(() => {
      const now = stateOf(workspaceId).run;
      const note = now?.id === first.id ? slowNote(now) : null;
      if (!note) return;
      set(workspaceId, { slow: true });
      say(workspaceId, note.text, { ok: note.ok, working: true });
    });
  }, CHECK_TAKES_LONG_MS);
}

/** A connection disconnected while waited on is never announced: the Workspace no longer lists it, so the run stops waiting for it. */
export function listedNow(workspaceId: string, checkable: readonly Checkable[]): void {
  const current = stateOf(workspaceId).run;
  if (!current || current.since === null) return;
  const next = withoutDisconnected(current, checkable);
  if (next === current) return;
  if (next.asked.length === 0) {
    finish(workspaceId);
    say(workspaceId, 'No connection to check.');
  } else hear(workspaceId, next);
}

/** Takes the note down, as a click on it does. A note that says a check is under way stays. */
export function dismissCheckNote(workspaceId: string): void {
  if (stateOf(workspaceId).note?.working) return;
  stopTimers(workspaceId, 'note');
  set(workspaceId, { note: null });
}

/** Forgets every press and its timers, for a test. */
export function forgetCheckRuns(): void {
  for (const workspaceId of timers.keys()) stopTimers(workspaceId);
  timers.clear();
  states = new Map();
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** One Workspace's press, as the Inbox's heading draws it. */
export function useCheckState(workspaceId: string): CheckState {
  return useSyncExternalStore(subscribe, () => stateOf(workspaceId), () => IDLE);
}
