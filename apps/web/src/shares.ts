import { useEffect, useRef, useState } from 'react';
import { createStore, type UseStore } from 'idb-keyval';
import { SHARE_HOLDING_DATABASE, SHARE_HOLDING_STORE } from '@cockpit/shared';

/**
 * What the share sheet handed to the installed app and the service worker is
 * holding until Capture asks for it ("Share photos, files and links into
 * Cockpit from Android's share sheet", issue 789; the worker side is
 * public/share-target-sw.js, which writes it).
 *
 * **A holding area apart from the capture outbox.** A share is not a capture
 * until Capture is pressed, so it has no owner and no ids yet: the Capture page
 * claims everything held while somebody is signed in, and signing out empties
 * it, as it does the outbox (`pages/Layout.tsx`).
 */

/** The files are kept as bytes, as the outbox keeps its own. */
interface HeldFile {
  name: string;
  type: string;
  size?: number;
  /** Null for a file the Attachment rules refuse, which is kept by name, type and size only. */
  bytes: ArrayBuffer | null;
}

export interface HeldShare {
  id: string;
  receivedAt: string;
  title: string;
  text: string;
  url: string;
  files: HeldFile[];
}

/** Where shares wait: IndexedDB in the app, anything shaped like it in a test. */
export interface HoldingArea {
  /** Everything held, removed in the same step it is read: two pages cannot both claim a share. */
  takeAll(): Promise<unknown[]>;
  empty(): Promise<void>;
}

export const HOLDING_DATABASE = SHARE_HOLDING_DATABASE;
export const HOLDING_STORE = SHARE_HOLDING_STORE;

/** The browser's own, opened on first use so a browser with no IndexedDB fails on the read. */
export function browserHoldingArea(): HoldingArea {
  let store: UseStore | null = null;
  const open = () => (store ??= createStore(HOLDING_DATABASE, HOLDING_STORE));
  return {
    // Both settle on the transaction, not on the request: a clear that aborted
    // must not hand over shares that are still held.
    takeAll: async () =>
      open()('readwrite', (held) => {
        const all = held.getAll();
        held.clear();
        return settled(held.transaction, () => all.result as unknown[]);
      }),
    empty: async () =>
      open()('readwrite', (held) => {
        held.clear();
        return settled(held.transaction, () => undefined);
      }),
  };
}

function settled<T>(transaction: IDBTransaction, answer: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    transaction.oncomplete = () => resolve(answer());
    transaction.onabort = () => reject(transaction.error ?? new Error('The holding area was not emptied.'));
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Whatever Capture is to put on the note: the words, and the files to queue as chips. */
export interface Arrived {
  message: string;
  files: File[];
}

const isHeldShare = (value: unknown): value is HeldShare => {
  if (typeof value !== 'object' || value === null) return false;
  const share = value as Record<string, unknown>;
  return (
    typeof share.receivedAt === 'string' &&
    typeof share.title === 'string' &&
    typeof share.text === 'string' &&
    typeof share.url === 'string' &&
    Array.isArray(share.files)
  );
};

/**
 * One share's words, title then text then link, each once: a link shared from
 * a browser usually repeats itself in the text.
 */
function wordsOf(share: HeldShare): string {
  const parts: string[] = [];
  if (share.title) parts.push(share.title);
  if (share.text && share.text !== share.title) parts.push(share.text);
  // Only the link repeats itself, and only as a word of its own: a longer link
  // that merely begins with it is another link.
  const repeated = (url: string) => parts.some((kept) => kept === url || kept.split(/\s+/).includes(url));
  if (share.url && !repeated(share.url)) parts.push(share.url);
  return parts.join('\n');
}

/**
 * Several shares made before a claim land together, oldest first, on one note.
 * Null where nothing usable is held.
 */
export function whatArrived(held: readonly unknown[]): Arrived | null {
  const shares = held
    .filter(isHeldShare)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const message = shares.map(wordsOf).filter(Boolean).join('\n\n');
  const files = shares.flatMap((share) =>
    share.files.map((file) => {
      if (file.bytes) return new File([file.bytes], file.name, { type: file.type });
      // Kept without its bytes, to be refused by the same check a drop gets.
      const refused = new File([], file.name, { type: file.type });
      Object.defineProperty(refused, 'size', { value: file.size ?? 0 });
      return refused;
    }),
  );
  return message || files.length > 0 ? { message, files } : null;
}

/**
 * Claims what is held, once, where the page is signed in and shows the form.
 * Where storage cannot be read there is nothing to claim.
 *
 * **`taken` clears it once the note has it.** The page outlives the form - it
 * stays mounted across Write | Car - so a claim left here would be put on the
 * note again each time the form is drawn.
 */
export function useArrived(
  claiming: boolean,
  area: () => HoldingArea = browserHoldingArea,
): { arrived: Arrived | null; taken: () => void } {
  const [arrived, setArrived] = useState<Arrived | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!claiming || started.current) return;
    started.current = true;
    // Never cancelled: the claim has emptied the area, so dropping its answer would lose the share.
    Promise.resolve()
      .then(() => area().takeAll())
      .then((held) => setArrived(whatArrived(held)))
      .catch(() => {});
  }, [claiming, area]);
  return { arrived, taken: () => setArrived(null) };
}

/** Signing out: nothing shared stays for whoever signs in next. */
export async function emptyHoldingArea(area: HoldingArea = browserHoldingArea()): Promise<void> {
  try {
    await area.empty();
  } catch {
    // Storage that cannot be written to holds nothing this could remove.
  }
}
