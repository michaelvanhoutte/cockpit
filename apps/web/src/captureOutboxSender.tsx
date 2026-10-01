import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createStore, del, set, values, type UseStore } from 'idb-keyval';
import { uuidv7 } from '@cockpit/shared';
import { sendCommand, uploadAttachment } from './api/client';
import {
  ENTRY_VERSION,
  SEND_TIMEOUT_MS,
  TimedOut,
  capturePayload,
  landedWhole,
  nextWait,
  outcomeOf,
  uploadTimeoutMs,
  readEntry,
  shownTo,
  toSend,
  type OutboxEntry,
  type WaitingFile,
} from './captureOutbox';

/**
 * The capture outbox and the one thing that sends it ("Keep a capture made
 * offline, and send it once a connection gets through", issue 610). Pressing
 * Capture writes here and nothing else; this sends what is waiting, app-wide,
 * one tab at a time and oldest first. The rules it follows are
 * `captureOutbox.ts`'s.
 *
 * **Its own IndexedDB database, never the query cache's**, because the two have
 * opposite owners: the stored copy is wiped whenever the logon page opens
 * (`session/forget.ts`), and a capture survives that - it belongs to whoever
 * made it, and only their own explicit sign-out deletes it (`Layout.tsx`).
 */

/** Where the entries are kept: IndexedDB in the app, anything shaped like it in a test. */
export interface OutboxStore {
  all(): Promise<unknown[]>;
  put(entry: OutboxEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

/**
 * The browser's own. Opened on first use rather than on import, so a browser
 * with no IndexedDB - and a test environment with none - fails on the write,
 * where capture falls back to sending directly, rather than on loading the app.
 */
export function browserOutboxStore(): OutboxStore {
  let store: UseStore | null = null;
  const open = () => (store ??= createStore('cockpit-capture-outbox', 'entries'));
  return {
    all: async () => values(open()),
    put: async (entry) => set(entry.id, entry, open()),
    remove: async (id) => del(id, open()),
  };
}

/**
 * What the outbox sends with: the API client in the app. Each send is handed
 * a signal that aborts it once the outbox has given up on it, so a send
 * abandoned for taking too long is not still running beside its own retry.
 */
export interface Sender {
  capture: (payload: ReturnType<typeof capturePayload>, signal: AbortSignal) => Promise<unknown>;
  upload: (args: Parameters<typeof uploadAttachment>[0] & { signal: AbortSignal }) => Promise<unknown>;
}

export const serverSender: Sender = {
  capture: (payload, signal) => sendCommand('capture_item', payload, signal),
  upload: uploadAttachment,
};

/** Runs a pass with no other tab's pass running at the same time. */
export type Lock = <T>(work: () => Promise<T>) => Promise<T>;

/** One at a time within this tab alone: what a browser without Web Locks gets. */
export function inTabLock(): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(work: () => Promise<T>) => {
    const run = tail.then(work, work);
    tail = run.catch(() => undefined);
    return run;
  };
}

/** Across every tab of this browser, where it offers Web Locks. */
export function browserLock(): Lock {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return inTabLock();
  return <T,>(work: () => Promise<T>) => locks.request('cockpit-capture-outbox', work) as Promise<T>;
}

/** A capture as the form hands it over. */
export interface NewCapture {
  id: string;
  message: string;
  typeId: string;
  workspaceId: string;
  decided: boolean;
  files: { id: string; file: File }[];
}

/**
 * What one tab tells the others: that what is stored changed; that a capture
 * landed whole - which only the tab that sent it would otherwise hear, and
 * which another tab with Capture open needs to show its time; or that a
 * sign-out is discarding everything, so whatever they are sending stops and
 * releases the lock the discard waits for.
 */
export type OutboxNews =
  | { kind: 'changed' }
  | { kind: 'landed'; entry: OutboxEntry }
  | { kind: 'discarding' };

/** A capture reaching the server: its note (`note`), or the whole of it (`whole`). */
export interface Landing {
  kind: 'note' | 'whole';
  entry: OutboxEntry;
}

type PassResult = 'clear' | 'waits';

export class CaptureOutbox {
  private entries: OutboxEntry[] = [];
  private shown: OutboxEntry[] = [];
  private owner: string | null = null;
  private readonly changed = new Set<() => void>();
  private readonly landings = new Set<(landing: Landing) => void>();
  private running: Promise<void> | null = null;
  private again = false;
  private wait: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the last pass waited on a server that answered (429, 5xx and the like) rather than on no answer at all. */
  private waitedOnAnAnswer = false;
  /** Every send in flight, so a confirmed sign-out can stop them. */
  private readonly inFlight = new Set<AbortController>();
  /** Which read of storage is the latest, so one that finishes late is not applied over it. */
  private reads = 0;

  constructor(
    private readonly deps: {
      store: OutboxStore;
      sender: Sender;
      lock: Lock;
      /** False only where the browser says it is offline, when no attempt is made. */
      online: () => boolean;
      /** Told whenever this tab changed what is stored or landed a capture, for the other tabs. */
      announce?: (news: OutboxNews) => void;
      timeoutMs?: number;
    },
  ) {}

  /** For `useSyncExternalStore`: the same array until something changes. */
  readonly subscribe = (listener: () => void) => {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  };

  /** The signed-in person's entries, oldest first; none while nobody is signed in. */
  readonly getShown = () => this.shown;

  /** Called with every capture that reaches the server, in this tab. */
  onLanding(listener: (landing: Landing) => void): () => void {
    this.landings.add(listener);
    return () => this.landings.delete(listener);
  }

  /** Who is signed in, which is whose entries are sent and shown; null for nobody. */
  signedInAs(owner: string | null): void {
    if (owner === this.owner) return;
    this.owner = owner;
    this.show();
    if (owner === null) {
      this.clearTimer();
      return;
    }
    void this.refresh().then(() => this.send());
  }

  get signedIn(): string | null {
    return this.owner;
  }

  /** Whether anything of the signed-in person's is still to go. */
  hasWaiting(): boolean {
    return toSend(this.entries, this.owner).length > 0;
  }

  /**
   * Whether another request of the app's getting through should send now:
   * only where something waits for want of any answer. Where the server
   * answered and asked for patience, the backoff decides.
   */
  sendsOnAnotherSuccess(): boolean {
    return this.hasWaiting() && !this.waitedOnAnAnswer;
  }

  /**
   * Re-reads what is stored, which another tab may have changed, and hands
   * back what it read. Only the latest of overlapping reads is shown.
   */
  async refresh(): Promise<OutboxEntry[]> {
    const read = (this.reads += 1);
    let entries: OutboxEntry[];
    try {
      const raw = await this.deps.store.all();
      entries = raw.flatMap((one) => {
        const entry = readEntry(one);
        return entry ? [entry] : [];
      });
    } catch {
      // Storage that cannot be read holds nothing this tab can show or send.
      entries = [];
    }
    if (read === this.reads) {
      this.entries = entries;
      this.show();
    }
    return entries;
  }

  /** What another tab said: re-read, show a capture it landed as landed here too, or stop sending. */
  heard(news: OutboxNews): void {
    if (news.kind === 'landed') this.tell({ kind: 'whole', entry: news.entry });
    else if (news.kind === 'discarding') this.abortInFlight();
    else void this.refresh();
  }

  private abortInFlight(): void {
    for (const sending of this.inFlight) sending.abort();
  }

  /**
   * Keeps a capture. Resolves once it is stored - which is the moment the box
   * may empty - and throws where it could not be, so the form can send it
   * directly instead. Sending starts behind it, never waited for.
   */
  async add(capture: NewCapture): Promise<void> {
    const owner = this.owner;
    if (owner === null) throw new Error('nobody is signed in to keep a capture for');
    const files: WaitingFile[] = await Promise.all(
      capture.files.map(async ({ id, file }) => ({
        id,
        commandId: uuidv7(),
        name: file.name,
        type: file.type,
        bytes: await bytesOf(file),
        landed: false,
        refused: null,
      })),
    );
    const entry: OutboxEntry = {
      v: ENTRY_VERSION,
      id: capture.id,
      owner,
      commandId: uuidv7(),
      capturedAt: new Date().toISOString(),
      workspaceId: capture.workspaceId,
      decided: capture.decided,
      message: capture.message,
      typeId: capture.typeId,
      files,
      landed: false,
      refused: null,
    };
    await this.deps.store.put(entry);
    await this.changedHere();
    void this.send();
  }

  /** Deletes one entry - only ever after **Put back** has returned it to the box. */
  async remove(id: string): Promise<void> {
    await this.deps.store.remove(id);
    await this.changedHere();
  }

  /**
   * Deletes every entry of the signed-in person's: the explicit sign-out,
   * confirmed. Under the lock and from a fresh read, so a pass in flight cannot
   * write one back afterwards; what this tab and every other is sending is
   * aborted, so the sign-out does not wait on it.
   */
  async discardAll(): Promise<void> {
    const owner = this.owner;
    this.abortInFlight();
    this.deps.announce?.({ kind: 'discarding' });
    await this.deps.lock(async () => {
      const entries = await this.refresh();
      for (const entry of shownTo(entries, owner)) await this.deps.store.remove(entry.id);
    });
    await this.changedHere();
  }

  /**
   * Sends whatever is waiting. A call while a pass is running asks for one
   * more pass after it rather than a second sender, so what was captured in
   * the meantime is not left for the timer.
   */
  send(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.clearTimer();
    this.running = (async () => {
      let result: PassResult = 'clear';
      try {
        // Once more for what arrived during the pass - unless it could not get
        // through, when another try at once would only fail the same way.
        do {
          this.again = false;
          result = await this.deps.lock(() => this.pass());
        } while (this.again && result !== 'waits');
      } catch {
        result = 'waits';
      } finally {
        this.running = null;
      }
      if (result === 'waits' && this.owner !== null) this.tryAgainLater();
      else {
        this.wait = null;
        this.waitedOnAnAnswer = false;
      }
    })();
    return this.running;
  }

  /** Stops the timer, for a tab that is going away. */
  stop(): void {
    this.clearTimer();
  }

  private async pass(): Promise<PassResult> {
    const owner = this.owner;
    if (owner === null) return 'clear';
    // Read again inside the lock: another tab may have sent some of these.
    const due = toSend(await this.refresh(), owner);
    if (due.length === 0) return 'clear';
    if (!this.deps.online()) {
      this.waitedOnAnAnswer = false;
      return 'waits';
    }
    for (const entry of due) {
      if (this.owner !== owner) return 'clear';
      if ((await this.sendOne(entry)) === 'waits') return 'waits';
    }
    return 'clear';
  }

  private async sendOne(entry: OutboxEntry): Promise<'waits' | 'done'> {
    let current = entry;
    if (!current.landed) {
      try {
        const payload = capturePayload(current);
        await this.timed((signal) => this.deps.sender.capture(payload, signal), this.noteTimeout());
      } catch (error) {
        const outcome = outcomeOf(error);
        if (outcome.waits) {
          this.waitedOnAnAnswer = outcome.answered;
          return 'waits';
        }
        await this.save({ ...current, refused: outcome.reason });
        return 'done';
      }
      current = { ...current, landed: true };
      await this.save(current);
      this.tell({ kind: 'note', entry: current });
    }
    for (const file of current.files) {
      if (file.landed || file.refused !== null) continue;
      let change: Partial<WaitingFile>;
      try {
        const itemId = current.id;
        const workspaceId = current.workspaceId;
        await this.timed(
          (signal) =>
            this.deps.sender.upload({
              itemId,
              workspaceId,
              attachmentId: file.id,
              commandId: file.commandId,
              file: fileOf(file),
              signal,
            }),
          uploadTimeoutMs(file.bytes.byteLength, this.noteTimeout()),
        );
        change = { landed: true };
      } catch (error) {
        const outcome = outcomeOf(error);
        if (outcome.waits) {
          this.waitedOnAnAnswer = outcome.answered;
          return 'waits';
        }
        change = { refused: outcome.reason };
      }
      current = {
        ...current,
        files: current.files.map((one) => (one.id === file.id ? { ...one, ...change } : one)),
      };
      await this.save(current);
    }
    if (landedWhole(current)) {
      // Told before it is forgotten, so a list drawing both never draws it in
      // neither - here, and in any other tab with Capture open.
      this.tell({ kind: 'whole', entry: current });
      this.deps.announce?.({ kind: 'landed', entry: { ...current, files: [] } });
      await this.deps.store.remove(current.id);
      await this.changedHere();
    }
    return 'done';
  }

  private async save(entry: OutboxEntry): Promise<void> {
    await this.deps.store.put(entry);
    await this.changedHere();
  }

  private async changedHere(): Promise<void> {
    await this.refresh();
    this.deps.announce?.({ kind: 'changed' });
  }

  private noteTimeout(): number {
    return this.deps.timeoutMs ?? SEND_TIMEOUT_MS;
  }

  /** Runs one send, aborting it and giving up once it has taken `ms`. */
  private timed<T>(send: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
    const sending = new AbortController();
    this.inFlight.add(sending);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new TimedOut());
        sending.abort();
      }, ms);
    });
    return Promise.race([send(sending.signal), late]).finally(() => {
      clearTimeout(timer);
      this.inFlight.delete(sending);
    });
  }

  private tryAgainLater(): void {
    this.clearTimer();
    this.wait = nextWait(this.wait);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.send();
    }, this.wait);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private show(): void {
    this.shown = shownTo(this.entries, this.owner);
    for (const listener of this.changed) listener();
  }

  private tell(landing: Landing): void {
    for (const listener of this.landings) listener(landing);
  }
}

/** A file's bytes, through whichever reading this browser offers. */
function bytesOf(file: File): Promise<ArrayBuffer> {
  return typeof file.arrayBuffer === 'function' ? file.arrayBuffer() : new Response(file).arrayBuffer();
}

/** A waiting file as a `File` again, for the upload and for **Put back**. */
export function fileOf(file: WaitingFile): File {
  return new File([file.bytes], file.name, { type: file.type });
}

/**
 * The app's one outbox, made on first use. Other tabs are told through a
 * broadcast channel when this one changes what is stored, so their *Just
 * captured* and count follow without waiting to be looked at again.
 */
let appWide: CaptureOutbox | null = null;

function theAppWideOutbox(): CaptureOutbox {
  if (appWide) return appWide;
  const channel =
    typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('cockpit-capture-outbox');
  const outbox = new CaptureOutbox({
    store: browserOutboxStore(),
    sender: serverSender,
    lock: browserLock(),
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    announce: (news) => channel?.postMessage(news),
  });
  channel?.addEventListener('message', (event: MessageEvent<OutboxNews>) => outbox.heard(event.data));
  appWide = outbox;
  return outbox;
}

const OutboxContext = createContext<CaptureOutbox | null>(null);

/** Supplies a different outbox to everything under it: a test's own. */
export const OutboxProvider = OutboxContext.Provider;

export function useOutbox(): CaptureOutbox {
  return useContext(OutboxContext) ?? theAppWideOutbox();
}

/** The signed-in person's captures still in the outbox, oldest first. */
export function useWaitingCaptures(): OutboxEntry[] {
  const outbox = useOutbox();
  return useSyncExternalStore(outbox.subscribe, outbox.getShown, outbox.getShown);
}

/**
 * Sends the outbox for as long as the shell is mounted, which is for as long
 * as somebody is signed in: on opening, on reconnecting, on the tab coming
 * back into view, after any other request of the app's succeeds, and on the
 * backoff timer between. A new capture starts a send itself (`add`).
 */
export function useSendingCaptures(owner: string | null): void {
  const outbox = useOutbox();
  const queryClient = useQueryClient();

  useEffect(() => {
    outbox.signedInAs(owner);
    return () => outbox.signedInAs(null);
  }, [outbox, owner]);

  useEffect(() => {
    const kick = () => void outbox.send();
    const backInView = () => {
      if (document.visibilityState === 'visible') kick();
    };
    // Something of the app's own got through, so the connection is back
    // whatever the browser said - the lie-fi case. Not after the server
    // itself answered and asked for patience, which the backoff waits out. A
    // capture's own landing re-reads the snapshot and arrives here too, which
    // is harmless: nothing is then waiting.
    const succeeded = (event: { type: string; action?: { type: string; manual?: boolean } }) => {
      if (event.type !== 'updated' || event.action?.type !== 'success' || event.action.manual) return;
      if (outbox.sendsOnAnotherSuccess()) kick();
    };
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', backInView);
    const fromQueries = queryClient.getQueryCache().subscribe(succeeded);
    const fromChanges = queryClient.getMutationCache().subscribe(succeeded);
    // What a landed capture changes, as `afterChanging` re-reads it for one
    // sent online (api/queries.ts): every workspace for one left undecided.
    const landed = outbox.onLanding(({ entry }) => {
      void queryClient.invalidateQueries({
        queryKey: entry.decided ? ['snapshot', entry.workspaceId] : ['snapshot'],
      });
    });
    return () => {
      window.removeEventListener('online', kick);
      document.removeEventListener('visibilitychange', backInView);
      fromQueries();
      fromChanges();
      landed();
      outbox.stop();
    };
  }, [outbox, queryClient]);
}
