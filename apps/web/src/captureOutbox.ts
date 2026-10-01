import type { CommandPayload } from '@cockpit/shared';
import { CommandRefused } from './api/client';

/**
 * The capture outbox's rules, as calculations ("Keep a capture made offline,
 * and send it once a connection gets through", issue 610; architecture,
 * "Capture: the one exception to 'no offline queue'"). Nothing here reads
 * storage, the network or the clock: what decides which capture goes next,
 * what an answer means and how long to wait is all here, and the sender
 * (`captureOutboxSender.tsx`) only carries it out.
 */

/**
 * One file captured with a note, kept as its bytes rather than as the `File`
 * itself: an `ArrayBuffer` is what every browser's IndexedDB stores without
 * argument, where a `Blob` has not always been.
 */
export interface WaitingFile {
  /** The attachment id it uploads under, every time it is sent. */
  id: string;
  /** The command id it uploads with, every time it is sent. */
  commandId: string;
  name: string;
  type: string;
  bytes: ArrayBuffer;
  /** Attached to the Item already. */
  landed: boolean;
  /** Why the server refused it, where it did. */
  refused: string | null;
}

/**
 * One capture, from the moment Capture is pressed until it has landed whole.
 *
 * **There is no "sending" state**, deliberately: a tab that dies mid-send must
 * leave the entry waiting rather than stranded, and a resend carries the same
 * item, command and attachment ids, which the server applies once.
 */
export interface OutboxEntry {
  /** What this build can read. An entry with any other is left alone, never deleted. */
  v: typeof ENTRY_VERSION;
  /** The Item's id, which is also the entry's. */
  id: string;
  /** Whoever captured it: it is sent and shown only while they are signed in. */
  owner: string;
  commandId: string;
  /** When Capture was pressed, which is also when the Item says it was made. */
  capturedAt: string;
  /** The workspace it is captured against - where it belongs, or came from. */
  workspaceId: string;
  /** Whether that workspace is where it belongs, or only where it came from. */
  decided: boolean;
  message: string;
  typeId: string;
  files: WaitingFile[];
  /** The note is on the server, though a file may still be to go. */
  landed: boolean;
  /** Why the server refused the note, where it did. Nothing of it is sent again. */
  refused: string | null;
}

export const ENTRY_VERSION = 1;

/** The entry, if this build can read it, or null for one it must leave alone. */
export function readEntry(raw: unknown): OutboxEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<OutboxEntry>;
  if (entry.v !== ENTRY_VERSION) return null;
  if (typeof entry.id !== 'string' || typeof entry.owner !== 'string') return null;
  if (typeof entry.capturedAt !== 'string' || !Array.isArray(entry.files)) return null;
  return entry as OutboxEntry;
}

/** Oldest first, which is the order they were captured in and the order they are sent in. */
const byCaptureTime = (a: OutboxEntry, b: OutboxEntry) =>
  a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : a.id < b.id ? -1 : 1;

/** Whose entries are on show: only the person signed in, and nobody while nobody is. */
export function shownTo(entries: readonly OutboxEntry[], owner: string | null): OutboxEntry[] {
  if (owner === null) return [];
  return entries.filter((entry) => entry.owner === owner).sort(byCaptureTime);
}

const stillToGo = (file: WaitingFile) => !file.landed && file.refused === null;

/**
 * What is sent next, oldest first: this person's entries with a note or a
 * file still to go. A refused note sends nothing more; a refused file leaves
 * the rest of its entry to go on.
 */
export function toSend(entries: readonly OutboxEntry[], owner: string | null): OutboxEntry[] {
  return shownTo(entries, owner).filter(
    (entry) => entry.refused === null && (!entry.landed || entry.files.some(stillToGo)),
  );
}

/** What a row of Just captured says about an entry still in the outbox. */
export type EntryState = { waiting: true } | { waiting: false; notSent: string };

export function stateOf(entry: OutboxEntry): EntryState {
  if (entry.refused !== null) return { waiting: false, notSent: entry.refused };
  if (!entry.landed || entry.files.some(stillToGo)) return { waiting: true };
  const refusals = entry.files.flatMap((file) => (file.refused === null ? [] : [file.refused]));
  return { waiting: false, notSent: refusals.join(' ') };
}

/** Whether an entry is finished with: the note and every file landed. */
export function landedWhole(entry: OutboxEntry): boolean {
  return entry.landed && entry.files.every((file) => file.landed);
}

/** What putting a refused entry back returns to the box: the note too only where it never landed. */
export function whatGoesBack(entry: OutboxEntry): { message: string | null; files: WaitingFile[] } {
  if (!entry.landed) return { message: entry.message, files: entry.files };
  return { message: null, files: entry.files.filter((file) => file.refused !== null) };
}

/** A send that took longer than this is abandoned and tried again later. */
export const SEND_TIMEOUT_MS = 15_000;

/** The first wait after a pass that could not get through, doubling to `LONGEST_WAIT_MS`. */
export const FIRST_WAIT_MS = 30_000;
export const LONGEST_WAIT_MS = 60_000;

/** How long to wait before trying again, given the wait before it (null for none yet). */
export function nextWait(previous: number | null): number {
  return previous === null ? FIRST_WAIT_MS : Math.min(previous * 2, LONGEST_WAIT_MS);
}

/** A send abandoned for taking longer than `SEND_TIMEOUT_MS`. */
export class TimedOut extends Error {
  constructor() {
    super('timed out');
    this.name = 'TimedOut';
  }
}

/**
 * The statuses that are about the moment rather than the capture: the server
 * failing, a sign-in that has run out, a request that took too long, too many
 * at once. Each keeps the capture waiting.
 */
const ABOUT_THE_MOMENT = new Set([401, 408, 429]);

/**
 * What a failed send means: keep waiting, or the server refused this capture
 * and says why. Anything that is not the server answering - no connection, a
 * timeout - keeps it waiting.
 */
export function outcomeOf(error: unknown): { waits: true } | { waits: false; reason: string } {
  if (!(error instanceof CommandRefused)) return { waits: true };
  if (error.status >= 500 || ABOUT_THE_MOMENT.has(error.status)) return { waits: true };
  return { waits: false, reason: error.message };
}

/** The capture itself, as sent - the same every time, which is what makes a resend harmless. */
export function capturePayload(entry: OutboxEntry): CommandPayload<'capture_item'> {
  return {
    commandId: entry.commandId,
    issuedAt: entry.capturedAt,
    workspaceId: entry.workspaceId,
    itemId: entry.id,
    message: entry.message,
    typeId: entry.typeId,
    // Sent only when false, as an online capture always has (`capture.ts`).
    ...(entry.decided ? {} : { workspaceDecided: false }),
  };
}
