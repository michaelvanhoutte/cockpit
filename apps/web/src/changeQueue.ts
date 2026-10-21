import type { CommandPayload, CommandResult, WorkspaceList, WorkspaceSnapshot } from '@cockpit/shared';
import type { CommandArgs } from './api/queries';
import { DRAWN_AHEAD, WORKSPACE_LIST_CHANGES, drawnOver, listDrawnOver, type Drawn, type Requested } from './drawnAhead';

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
 * **A filing onto a Panel made here goes behind the Panel, and is refused in turn
 * if the Panel is** ("Show a Panel made from Move to or File on, with the Item on
 * it, the moment you make it", issue 1364): the screen goes back at once, with
 * the Panel's refusal the only one said (`PanelNotMade`).
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
 * first is never a question about milliseconds. The one exception is a read that
 * began earlier but whose `upTo` is at or after the stamp the answer gave: it
 * holds the change, so the change stops being drawn when it lands.
 *
 * **A Workspace change is drawn over the list of Workspaces, and read for
 * there**: an add, a rename, a colour, a delete or an order stops being drawn
 * when a read of the list that began after its answer lands, and no Workspace's
 * own read ends it. A Workspace added here has nothing on the server to read
 * until its add is answered (`adding`), and what is built on it waits behind it
 * (`afterAdding`).
 *
 * **A window draws a list of its own by giving its changes a scope** ("Show a
 * connection change the moment you make it", issue 1369): the queue keeps such a
 * change drawn once answered, and only a read landing for that scope ends it. What
 * the change draws, and which read it is, stay in the window's own chunk. **A change
 * that is not a command** (the admin's user changes, disconnecting a connected app;
 * "Show a connected app or user change the moment you make it", issue 1371) joins
 * the same way with the `request` that sends it, in place of `send`.
 *
 * **A capture is drawn from the outbox, which sends it** ("Show a capture in the
 * Inbox the moment you make it", issue 1353): it joins ahead of the changes
 * made to its row, so they have a row to land on, is never sent from here, and
 * once it has landed is drawn like an answered change - until a read of its
 * Workspace that began after the landing has landed.
 *
 * **An upload is held beside the queue, never in it** ("Keep an attachment's chip
 * drawn from the moment you choose the file, and remove one at once", issue 1367):
 * a large file's bytes may be minutes in flight, and nothing else waits for them.
 * The form draws *Attaching…* itself while the upload is out, and hands the queue
 * the file once the server has answered; from then it is drawn like an answered
 * change. Removing one is an ordinary change.
 */
export interface ChangeQueue {
  /**
   * Joins the queue, draws at once, and settles with the server's answer or its refusal.
   * `answered` is called the moment the answer is in, before anything watching the queue
   * hears of it: what lets a read owed for the change be registered before the queue is
   * seen to have emptied.
   */
  enqueue(
    change: CommandArgs | Requested,
    answered?: (result: CommandResult) => void,
    scope?: string,
    request?: (signal: AbortSignal) => Promise<CommandResult>,
  ): Promise<CommandResult>;
  /** The copy as the server sent it, with every change not yet covered by a read drawn over it. */
  drawnOver(snapshot: WorkspaceSnapshot): WorkspaceSnapshot;
  /**
   * A list as the server sent it, with the changes not yet covered by a read of
   * it drawn over it by `over`: the list of Workspaces by default ("Show a
   * Workspace rename, colour, delete or reorder the moment you make it", issue
   * 1365), or a list a window draws for itself.
   */
  drawnList(list: WorkspaceList): WorkspaceList;
  drawnList<L>(list: L, over: (list: L, changes: readonly Drawn[]) => L): L;
  /** Whether a delete of this Workspace has been made and its list not yet read: the Workspace is not there to read. */
  deleting(workspaceId: string): boolean;
  /**
   * Whether the add of this Workspace is made and not yet answered ("Open a new
   * Workspace the moment you add it", issue 1366): there is nothing on the
   * server to read, and a read would find nothing.
   */
  adding(workspaceId: string): boolean;
  /** That add itself, while `adding` says so: what the Workspace is drawn from until the server has it. */
  beingAdded(workspaceId: string): CommandArgs | undefined;
  /** Settles once any add of this Workspace has been answered or refused: what a change that cannot be drawn waits behind. */
  afterAdding(workspaceId: string): Promise<void>;
  /** A read of a Workspace, or of the list of them, is starting: the mark to hand back when it lands. */
  readStarted(): number;
  /**
   * A read that started at `startedAt` has landed in the held copy: of the
   * Workspace `scope` names, of the list of Workspaces for `null`, or of the
   * list a window gave its changes the scope of (`enqueue`). Each
   * covers its own changes only, so a Workspace's read landing never ends a
   * rename the list has not yet been read for. `upTo` is the newest change that
   * read holds (`workspaceSnapshotSchema`): one begun before an answer still
   * holds the change when its stamp is no later, so the change stops being drawn
   * then too, instead of waiting for a read that need not be made.
   */
  readLanded(scope: string | null, startedAt: number, upTo?: string): void;
  /**
   * The captures the outbox holds and the Inbox is to draw, oldest first: any
   * new one is drawn, and any not yet landed that is no longer here (refused,
   * put back, taken back) is not. One that has landed stays drawn.
   */
  captures(shown: readonly CaptureCommand[]): void;
  /**
   * A capture has landed, with the `at` its answer gave if it did: from now it
   * is covered by a read like an answered change. Whether this is news - false
   * for one already landed and not yet read for, so a landing is read for once,
   * and for one this tab never drew.
   */
  landed(capture: CaptureCommand, at?: string): boolean;
  /** A file has been uploaded, with the `at` the server's answer gave if it did: drawn as its chip, like an answered change. */
  attached(upload: CommandPayload<'add_attachment'>, at?: string): void;
  /** Stops drawing the changes the server has answered, without waiting for a read: what signing out does. */
  forgetAnswered(): void;
  /** How many changes are waiting to be sent or out unanswered. */
  unanswered(): number;
  /** Changes whenever what is drawn or what is unanswered does. */
  version(): number;
  subscribe(listener: () => void): () => void;
}

interface Entry {
  change: Drawn;
  /**
   * What a read must be of to cover this change, when a window drew it for
   * itself ("Show a connection change the moment you make it", issue 1369):
   * such a change is kept drawn once answered whatever it is, and only a read of
   * that scope ends it. Absent, the change is a Workspace's or the list of them.
   */
  scope?: string | undefined;
  /** How a change that is not a command is sent, in place of `send`. */
  request?: ((signal: AbortSignal) => Promise<CommandResult>) | undefined;
  state: 'waiting' | 'sending' | 'answered';
  /** The tick the answer arrived at, once it has. */
  answeredAt: number;
  /** When the server stored it, as its answer said, if it did (`commandResultSchema`'s `at`). */
  stamp: string | undefined;
  answered?: ((result: CommandResult) => void) | undefined;
  /** Absent on a capture, which the outbox sends. */
  settle?: { resolve: (result: CommandResult) => void; reject: (error: unknown) => void } | undefined;
}

type CaptureCommand = CommandPayload<'capture_item'>;

/** What `answeredAt` says of a capture that has not landed: no read can have begun after it. */
const NOT_LANDED = Infinity;

const capturedId = (entry: Entry) => (entry.change.name === 'capture_item' ? entry.change.payload.itemId : undefined);

/** How long a change may be out before the queue gives up on it and goes on to the next. */
export const SEND_TIMEOUT_MS = 15_000;

/** What a change that was given up on says, the same as one the network dropped. */
export const NOT_REACHED = 'That did not reach the server. Try again.';

/**
 * What a filing built on a Panel that was refused is sent back with ("Show a Panel
 * made from Move to or File on, with the Item on it, the moment you make it", issue
 * 1364). **It says the reason the Panel gave, and callers that report a refusal say
 * nothing for it** (`refusalFrom`), because whoever made the Panel has said so once.
 */
export class PanelNotMade extends Error {}

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

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const beingAdded = (workspaceId: string) =>
    entries.find(
      (entry) =>
        entry.state !== 'answered' &&
        entry.change.name === 'create_workspace' &&
        entry.change.payload.workspaceId === workspaceId,
    )?.change as CommandArgs | undefined;
  const adding = (workspaceId: string) => beingAdded(workspaceId) !== undefined;

  /** Settles once `done` holds, checked now and after every change to the queue. */
  const until = (done: () => boolean) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (!done()) return;
        stop();
        resolve();
      };
      const stop = subscribe(check);
      check();
    });

  /** Whether a captured note the queue draws has yet to reach the server: there is no Item there to change. */
  const notLanded = (itemId: unknown) => entries.some((entry) => entry.answeredAt === NOT_LANDED && capturedId(entry) === itemId);

  const drop = (entry: Entry) => {
    const at = entries.indexOf(entry);
    if (at !== -1) entries.splice(at, 1);
  };

  function drawnList(list: WorkspaceList): WorkspaceList;
  function drawnList<L>(list: L, over: (list: L, changes: readonly Drawn[]) => L): L;
  function drawnList(list: unknown, over: (list: unknown, changes: readonly Drawn[]) => unknown = listDrawnOver as never) {
    return over(
      list,
      entries.map((entry) => entry.change),
    );
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      for (let next = entries.find((e) => e.state === 'waiting'); next; next = entries.find((e) => e.state === 'waiting')) {
        next.state = 'sending';
        // A change to a note still on its way waits for it to land, or to be refused and go.
        const { itemId } = next.change.payload as { itemId?: unknown };
        await until(() => !notLanded(itemId));
        const sending = new AbortController();
        let giveUp: ReturnType<typeof setTimeout> | undefined;
        try {
          const sent = next.request ? next.request(sending.signal) : send(next.change as CommandArgs, sending.signal);
          // A request given up on may still fail later; nobody is waiting on it then.
          sent.catch(() => {});
          const gaveUp = new Promise<never>((_, reject) => {
            giveUp = setTimeout(() => {
              sending.abort();
              reject(new Error(NOT_REACHED));
            }, sendTimeoutMs);
          });
          const result = await Promise.race([sent, gaveUp]);
          if (next.scope || DRAWN_AHEAD.has(next.change.name)) {
            next.state = 'answered';
            next.answeredAt = ++tick;
            next.stamp = result.at;
          } else {
            drop(next);
          }
          next.answered?.(result);
          changed();
          next.settle?.resolve(result);
        } catch (error) {
          // Refused, or never reached the server: the screen goes back to what the server holds.
          drop(next);
          // A filing onto a Panel that was not made is refused with it, not sent to be refused again.
          if (next.change.name === 'add_panel') {
            const { panelId } = next.change.payload;
            const filings = entries.filter((e) => {
              const named = e.change.payload as { itemId?: unknown; panelId?: unknown };
              return e.state === 'waiting' && named.itemId !== undefined && named.panelId === panelId;
            });
            for (const filing of filings) {
              drop(filing);
              filing.settle?.reject(new PanelNotMade(error instanceof Error ? error.message : NOT_REACHED));
            }
          }
          changed();
          next.settle?.reject(error);
        } finally {
          clearTimeout(giveUp);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue(change, answered, scope, request) {
      return new Promise<CommandResult>((resolve, reject) => {
        entries.push({ change, scope, request, state: 'waiting', answeredAt: 0, stamp: undefined, answered, settle: { resolve, reject } });
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
    drawnList,
    deleting: (workspaceId) =>
      entries.some((entry) => entry.change.name === 'delete_workspace' && entry.change.payload.workspaceId === workspaceId),
    adding,
    beingAdded,
    afterAdding: (workspaceId) => until(() => !adding(workspaceId)),
    readStarted: () => ++tick,
    readLanded(scope, startedAt, upTo) {
      const covered = entries.filter(
        (entry) =>
          entry.state === 'answered' &&
          (entry.scope ?? (WORKSPACE_LIST_CHANGES.has(entry.change.name) ? null : (entry.change.payload as { workspaceId: string }).workspaceId)) === scope &&
          (entry.answeredAt < startedAt || (entry.stamp !== undefined && upTo !== undefined && upTo >= entry.stamp)),
      );
      if (covered.length === 0) return;
      covered.forEach(drop);
      changed();
    },
    captures(shown) {
      entries.filter((entry) => entry.answeredAt === NOT_LANDED).forEach(drop);
      // Behind the captures already drawn and ahead of every other change.
      entries.splice(
        entries.filter((entry) => capturedId(entry) !== undefined).length,
        0,
        ...shown.map((payload): Entry => ({ change: { name: 'capture_item', payload }, state: 'answered', answeredAt: NOT_LANDED, stamp: undefined })),
      );
      changed();
    },
    landed(capture, at) {
      const drawn = entries.find((entry) => capturedId(entry) === capture.itemId);
      if (drawn?.answeredAt !== NOT_LANDED) return false;
      Object.assign(drawn, { answeredAt: ++tick, stamp: at });
      changed();
      return true;
    },
    attached(payload, at) {
      entries.push({ change: { name: 'add_attachment', payload }, state: 'answered', answeredAt: ++tick, stamp: at });
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
    subscribe,
  };
}
