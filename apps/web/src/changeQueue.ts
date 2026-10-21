import type { CommandResult, WorkspaceSnapshot } from '@cockpit/shared';
import type { CommandArgs } from './api/queries';
import { DRAWN_AHEAD, drawnOver } from './drawnAhead';

/**
 * The changes this tab has made, in the order it made them ("Show an Item or
 * filing change the moment you make it", issue 1329).
 *
 * **One at a time.** A change is sent when the one before it has been answered,
 * so two arrive in the order they were made and a filing's whole order cannot
 * be refused for overtaking another. The screen never waits on it: a change is
 * drawn (`drawnAhead.ts`) the moment it joins, and the cost is that a burst of
 * ten takes ten round trips to land.
 *
 * **Memory only.** Nothing here is saved or replayed: an offline write queue is
 * deliberately not built (architecture.md, "The local-first decision,
 * recorded"), so a tab that closes mid-save loses what was not yet sent, and the
 * browser's leave-site prompt guards that while any change is unanswered.
 *
 * **Drawn until a read that started after the answer has landed.** A read begun
 * before the answer may not hold the change, so it must not flip the screen
 * back; one begun after must, so another device's later write wins from then on.
 * Both moments are counted on one clock (`tick`) rather than timed, so which came
 * first is never a question about milliseconds.
 */
export interface ChangeQueue {
  /**
   * Joins the queue, draws at once, and settles with the server's answer or its refusal.
   * `answered` is called the moment the answer is in, before anything watching the queue
   * hears of it: what lets a read owed for the change be registered before the queue is
   * seen to have emptied.
   */
  enqueue(change: CommandArgs, answered?: (result: CommandResult) => void): Promise<CommandResult>;
  /** The copy as the server sent it, with every change not yet covered by a read drawn over it. */
  drawnOver(snapshot: WorkspaceSnapshot): WorkspaceSnapshot;
  /** A read of a Workspace is starting: the mark to hand back when it lands. */
  readStarted(): number;
  /** A read that started at `startedAt` has landed in the held copy. */
  readLanded(workspaceId: string, startedAt: number): void;
  /** Stops drawing the changes the server has answered, without waiting for a read: what signing out does. */
  forgetAnswered(): void;
  /** How many changes are waiting to be sent or out unanswered. */
  unanswered(): number;
  /** Changes whenever what is drawn or what is unanswered does. */
  version(): number;
  subscribe(listener: () => void): () => void;
}

interface Entry {
  change: CommandArgs;
  state: 'waiting' | 'sending' | 'answered';
  /** The tick the answer arrived at, once it has. */
  answeredAt: number;
  answered: ((result: CommandResult) => void) | undefined;
  settle: { resolve: (result: CommandResult) => void; reject: (error: unknown) => void };
}

/** How long a change may be out before the queue gives up on it and goes on to the next. */
export const SEND_TIMEOUT_MS = 15_000;

/** What a change that was given up on says, the same as one the network dropped. */
export const NOT_REACHED = 'That did not reach the server. Try again.';

export function createChangeQueue(options: {
  /**
   * Sends one change; throwing is how it reports a refusal or that it did not
   * reach the server. `signal` aborts the request once the queue gives up on it.
   */
  send: (change: CommandArgs, signal: AbortSignal) => Promise<CommandResult>;
  /** Armed while any change is unanswered. Absent where there is no window. */
  leaveGuard?: { arm: () => void; disarm: () => void };
  /**
   * How long one change may wait for its answer. **Without it a request that
   * hangs holds every change behind it**, where before the queue it held only
   * its own control; a change given up on goes back like one that did not reach
   * the server.
   */
  sendTimeoutMs?: number;
}): ChangeQueue {
  const { send, leaveGuard, sendTimeoutMs = SEND_TIMEOUT_MS } = options;
  const entries: Entry[] = [];
  const listeners = new Set<() => void>();
  let tick = 0;
  let version = 0;
  let running = false;
  let armed = false;

  const unanswered = () => entries.filter((entry) => entry.state !== 'answered').length;

  const changed = () => {
    version += 1;
    const waiting = unanswered() > 0;
    if (waiting !== armed) {
      armed = waiting;
      if (waiting) leaveGuard?.arm();
      else leaveGuard?.disarm();
    }
    listeners.forEach((listener) => listener());
  };

  const drop = (entry: Entry) => {
    const at = entries.indexOf(entry);
    if (at !== -1) entries.splice(at, 1);
  };

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (let next = entries.find((e) => e.state === 'waiting'); next; next = entries.find((e) => e.state === 'waiting')) {
        next.state = 'sending';
        const sending = new AbortController();
        let giveUp: ReturnType<typeof setTimeout> | undefined;
        try {
          const sent = send(next.change, sending.signal);
          // A request given up on may still fail later; nobody is waiting on it then.
          sent.catch(() => {});
          const gaveUp = new Promise<never>((_, reject) => {
            giveUp = setTimeout(() => {
              sending.abort();
              reject(new Error(NOT_REACHED));
            }, sendTimeoutMs);
          });
          const result = await Promise.race([sent, gaveUp]);
          if (DRAWN_AHEAD.has(next.change.name)) {
            next.state = 'answered';
            next.answeredAt = ++tick;
          } else {
            drop(next);
          }
          next.answered?.(result);
          changed();
          next.settle.resolve(result);
        } catch (error) {
          // Refused, or never reached the server: the screen goes back to what the server holds.
          drop(next);
          changed();
          next.settle.reject(error);
        } finally {
          clearTimeout(giveUp);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(change, answered) {
      return new Promise<CommandResult>((resolve, reject) => {
        entries.push({ change, state: 'waiting', answeredAt: 0, answered, settle: { resolve, reject } });
        changed();
        void pump();
      });
    },
    drawnOver(snapshot) {
      return drawnOver(
        snapshot,
        entries.map((entry) => entry.change),
      );
    },
    readStarted: () => ++tick,
    readLanded(workspaceId, startedAt) {
      const covered = entries.filter(
        (entry) =>
          entry.state === 'answered' && entry.change.payload.workspaceId === workspaceId && entry.answeredAt < startedAt,
      );
      if (covered.length === 0) return;
      covered.forEach(drop);
      changed();
    },
    forgetAnswered() {
      const answered = entries.filter((entry) => entry.state === 'answered');
      if (answered.length === 0) return;
      answered.forEach(drop);
      changed();
    },
    unanswered,
    version: () => version,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
