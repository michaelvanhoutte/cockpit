import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { createStore, del, get, set, values, type UseStore } from 'idb-keyval';
import { browserLock, type Lock } from './captureOutboxSender';

/**
 * The recordings Write could not transcribe, kept on this device until their
 * words are in the note ("Keep a recording Write could not transcribe, with
 * Retry", issue 1044, under issue 1037).
 *
 * **The capture outbox's ownership rules, in a database of its own**
 * (`captureOutboxSender.tsx`): a recording belongs to the User who recorded it,
 * is offered only while they are signed in, survives the logon page's wipe of
 * the stored copy, and is deleted only once its words are in the note or at
 * their confirmed Sign out (`Layout.tsx`). Apart from the outbox because a
 * recording is not a capture: nothing of it is ever sent as one.
 */

/** One recording waiting for its words. Its sound is kept as bytes, as the outbox keeps a file's. */
export interface KeptRecording {
  /** What this build can read. One with any other is left alone, never deleted. */
  v: typeof RECORDING_VERSION;
  id: string;
  /** Whoever recorded it: offered only while they are signed in. */
  owner: string;
  /** When it was stopped. */
  recordedAt: string;
  /** How long it is, in whole seconds. */
  seconds: number;
  /** The recorder's own format, sent with it, such as `audio/webm;codecs=opus`. */
  type: string;
  bytes: ArrayBuffer;
}

export const RECORDING_VERSION = 1;

/** The recording, if this build can read it, or null for one it must leave alone. */
export function readRecording(raw: unknown): KeptRecording | null {
  if (!raw || typeof raw !== 'object') return null;
  const one = raw as Partial<KeptRecording>;
  if (one.v !== RECORDING_VERSION) return null;
  if (typeof one.id !== 'string' || typeof one.owner !== 'string' || typeof one.recordedAt !== 'string') return null;
  // Asked of the shape, not by `instanceof`: what IndexedDB hands back can be another realm's ArrayBuffer.
  if (typeof one.bytes !== 'object' || one.bytes === null || typeof one.bytes.byteLength !== 'number') return null;
  return one as KeptRecording;
}

/** Whose recordings are offered: only the person signed in, oldest first, and nobody's while nobody is. */
export function offeredTo(recordings: readonly KeptRecording[], owner: string | null): KeptRecording[] {
  if (owner === null) return [];
  return recordings
    .filter((one) => one.owner === owner)
    .sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : a.id < b.id ? -1 : 1));
}

/** The kept recording as the blob it was recorded as, to send again. */
export function soundOf(recording: KeptRecording): Blob {
  return new Blob([recording.bytes], { type: recording.type });
}

/** Where recordings are kept: IndexedDB in the app, anything shaped like it in a test. */
export interface RecordingStore {
  all(): Promise<unknown[]>;
  has(id: string): Promise<boolean>;
  put(recording: KeptRecording): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The browser's own, opened on first use so a browser with no IndexedDB fails on the write rather than on load. */
export function browserRecordingStore(): RecordingStore {
  let store: UseStore | null = null;
  const open = () => (store ??= createStore('cockpit-kept-recordings', 'recordings'));
  return {
    all: async () => values(open()),
    has: async (id) => (await get(id, open())) !== undefined,
    put: async (recording) => set(recording.id, recording, open()),
    remove: async (id) => del(id, open()),
  };
}

/** What happened to a recording's words once they came back. */
export type Landing = 'landed' | 'gone' | 'not taken';

export class KeptRecordings {
  private recordings: KeptRecording[] = [];
  private shown: KeptRecording[] = [];
  private owner: string | null = null;
  private readonly changed = new Set<() => void>();
  /** Which read of storage is the latest, so one that finishes late is not applied over it. */
  private reads = 0;

  constructor(
    private readonly deps: {
      store: RecordingStore;
      /** Across every tab, so a recording's words land in one note only. */
      lock: Lock;
      /** Told whenever this tab changed what is stored, for the other tabs. */
      announce?: () => void;
    },
  ) {}

  /** For `useSyncExternalStore`: the same array until something changes. */
  readonly subscribe = (listener: () => void) => {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  };

  /** The signed-in person's recordings, oldest first; none while nobody is signed in. */
  readonly getShown = () => this.shown;

  /** Who is signed in, which is whose recordings are offered; null for nobody. */
  signedInAs(owner: string | null): void {
    if (owner === this.owner) return;
    this.owner = owner;
    this.show();
    if (owner !== null) void this.refresh();
  }

  /** Re-reads what is stored, which another tab may have changed. Only the latest of overlapping reads is shown. */
  async refresh(): Promise<KeptRecording[]> {
    const read = (this.reads += 1);
    let recordings: KeptRecording[];
    try {
      recordings = (await this.deps.store.all()).flatMap((raw) => {
        const one = readRecording(raw);
        return one ? [one] : [];
      });
    } catch {
      // Storage that cannot be read holds nothing this tab can offer.
      recordings = [];
    }
    if (read === this.reads) {
      this.recordings = recordings;
      this.show();
    }
    return recordings;
  }

  /**
   * Keeps a recording, before anything is sent, under the id given. Throws
   * where it cannot be kept - nobody signed in, storage refused - so the
   * recording is sent as it is, and lost if that fails, as before it could be kept.
   */
  async keep(recording: Blob, seconds: number, id: string): Promise<void> {
    const owner = this.owner;
    if (owner === null) throw new Error('nobody is signed in to keep a recording for');
    const kept: KeptRecording = {
      v: RECORDING_VERSION,
      id,
      owner,
      recordedAt: new Date().toISOString(),
      seconds,
      type: recording.type,
      bytes: await bytesOf(recording),
    };
    await this.deps.store.put(kept);
    await this.changedHere();
  }

  /**
   * Puts a recording's words in the note and only then deletes it, under the
   * lock every tab takes: where another tab has already put them in its own,
   * the recording is gone and nothing is added a second time. `putIn` answers
   * whether the words went in; where they did not - the form closed meanwhile -
   * the recording stays, to be retried.
   */
  async land(id: string, putIn: () => boolean): Promise<Landing> {
    const landing = await this.deps.lock(async (): Promise<Landing> => {
      if (!(await this.deps.store.has(id))) return 'gone';
      if (!putIn()) return 'not taken';
      await this.deps.store.remove(id);
      return 'landed';
    });
    await this.changedHere();
    return landing;
  }

  /** Deletes every recording of the signed-in person's: the explicit sign-out, confirmed. */
  async discardAll(): Promise<void> {
    const owner = this.owner;
    await this.deps.lock(async () => {
      for (const one of offeredTo(await this.refresh(), owner)) await this.deps.store.remove(one.id);
    });
    await this.changedHere();
  }

  /** Another tab changed what is stored. */
  heard(): void {
    void this.refresh();
  }

  private async changedHere(): Promise<void> {
    await this.refresh();
    this.deps.announce?.();
  }

  private show(): void {
    this.shown = offeredTo(this.recordings, this.owner);
    for (const listener of this.changed) listener();
  }
}

/** A recording's bytes, through whichever reading this browser offers. */
function bytesOf(recording: Blob): Promise<ArrayBuffer> {
  return typeof recording.arrayBuffer === 'function' ? recording.arrayBuffer() : new Response(recording).arrayBuffer();
}

/** The app's one keeper, made on first use, telling the other tabs through a broadcast channel. */
let appWide: KeptRecordings | null = null;

function theAppWideKeeper(): KeptRecordings {
  if (appWide) return appWide;
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('cockpit-kept-recordings');
  const kept = new KeptRecordings({
    store: browserRecordingStore(),
    lock: browserLock('cockpit-kept-recordings'),
    announce: () => channel?.postMessage('changed'),
  });
  channel?.addEventListener('message', () => kept.heard());
  appWide = kept;
  return kept;
}

const KeptRecordingsContext = createContext<KeptRecordings | null>(null);

/** Supplies a different keeper to everything under it: a test's own. */
export const KeptRecordingsProvider = KeptRecordingsContext.Provider;

export function useKeptRecordings(): KeptRecordings {
  return useContext(KeptRecordingsContext) ?? theAppWideKeeper();
}

/** The signed-in person's recordings waiting for their words, oldest first. */
export function useWaitingRecordings(): KeptRecording[] {
  const kept = useKeptRecordings();
  return useSyncExternalStore(kept.subscribe, kept.getShown, kept.getShown);
}

/** Offers the recordings of whoever is signed in, for as long as the shell is mounted. */
export function useKeepingRecordings(owner: string | null): void {
  const kept = useKeptRecordings();
  useEffect(() => {
    kept.signedInAs(owner);
    return () => kept.signedInAs(null);
  }, [kept, owner]);
}
