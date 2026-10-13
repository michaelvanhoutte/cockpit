import type { CommandPayload, Priority } from '@cockpit/shared';
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
 * A note spoken in the Car view, kept in place of its text until it can be
 * transcribed ("Capture in the Car view without a connection, from the
 * recording", issue 1045). Its sound is bytes, as a file's is.
 */
export interface WaitingRecording {
  /** The recorder's own format, sent with it, such as `audio/webm;codecs=opus`. */
  type: string;
  bytes: ArrayBuffer;
  /** How long it is, in whole seconds. */
  seconds: number;
  /** Its words are in the entry's message; it is not sent to be transcribed again. */
  transcribed: boolean;
}

/**
 * One capture, from the moment Capture is pressed until it has landed whole.
 *
 * **There is no "sending" state**, deliberately: a tab that dies mid-send must
 * leave the entry waiting rather than stranded, and a resend carries the same
 * item, command and attachment ids, which the server applies once.
 *
 * **A spoken one carries its recording** and an empty message until the
 * recording is transcribed; the words then go in the message and the capture
 * is sent as any other. The recording goes with the entry, once it has landed
 * whole or is put back, never before.
 */
export interface OutboxEntry {
  /**
   * What this build can read: `ENTRY_VERSION` for a typed note, which every
   * build since the outbox began sends unchanged, and `RECORDED_ENTRY_VERSION`
   * for a spoken one, which an older build leaves alone rather than sending
   * its empty message. An entry with any other is left alone, never deleted.
   */
  v: typeof ENTRY_VERSION | typeof RECORDED_ENTRY_VERSION;
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
  /** What the Capture form's strip chose ("Set a priority and a due date while capturing", issue 611); absent on an entry written without one, which is every entry from before it. */
  priority?: Priority;
  dueDate?: string;
  /** The device's time zone when Capture was pressed ("Read a due date you say when you capture, on your own calendar", issue 1077); absent on an entry kept before it, which is sent without one. */
  timeZone?: string;
  files: WaitingFile[];
  /** What a spoken note is transcribed from; absent on a typed one. */
  recording?: WaitingRecording;
  /** The note is on the server, though a file may still be to go. */
  landed: boolean;
  /** Why the server refused the note, where it did. Nothing of it is sent again. */
  refused: string | null;
}

export const ENTRY_VERSION = 1;
export const RECORDED_ENTRY_VERSION = 2;

/** The entry, if this build can read it, or null for one it must leave alone. */
export function readEntry(raw: unknown): OutboxEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<OutboxEntry>;
  if (entry.v !== ENTRY_VERSION && entry.v !== RECORDED_ENTRY_VERSION) return null;
  if (typeof entry.id !== 'string' || typeof entry.owner !== 'string') return null;
  if (typeof entry.capturedAt !== 'string' || !Array.isArray(entry.files)) return null;
  if (entry.v === RECORDED_ENTRY_VERSION && !readRecording(entry.recording)) return null;
  return entry as OutboxEntry;
}

function readRecording(raw: unknown): WaitingRecording | null {
  if (!raw || typeof raw !== 'object') return null;
  const one = raw as Partial<WaitingRecording>;
  if (typeof one.type !== 'string' || typeof one.transcribed !== 'boolean') return null;
  // Asked of the shape, not by `instanceof`: what IndexedDB hands back can be another realm's ArrayBuffer.
  if (typeof one.bytes !== 'object' || one.bytes === null || typeof one.bytes.byteLength !== 'number') return null;
  return one as WaitingRecording;
}

/** Whether an entry is a spoken note still waiting to be transcribed. */
export function needsWords(entry: OutboxEntry): boolean {
  return entry.recording !== undefined && !entry.recording.transcribed;
}

/** Why a spoken note that turned out to hold nothing is not sent. */
export const NOTHING_HEARD = 'Nothing was heard in the recording.';

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
 * file still to go, and one that landed whole but was never forgotten (a tab
 * frozen between the two), which the sender only has to clear. A refused note
 * sends nothing more; a refused file leaves the rest of its entry to go on.
 */
export function toSend(entries: readonly OutboxEntry[], owner: string | null): OutboxEntry[] {
  return shownTo(entries, owner).filter(
    (entry) => entry.refused === null && (!entry.landed || entry.files.some(stillToGo) || landedWhole(entry)),
  );
}

/** What a row of Just captured says about an entry still in the outbox. */
export type EntryState = { waiting: true } | { waiting: false; notSent: string };

export function stateOf(entry: OutboxEntry): EntryState {
  if (entry.refused !== null) return { waiting: false, notSent: entry.refused };
  if (!entry.landed || entry.files.some(stillToGo) || landedWhole(entry)) return { waiting: true };
  const refusals = entry.files.flatMap((file) => (file.refused === null ? [] : [file.refused]));
  return { waiting: false, notSent: refusals.join(' ') };
}

/** Whether an entry is finished with: the note and every file landed. */
export function landedWhole(entry: OutboxEntry): boolean {
  return entry.landed && entry.files.every((file) => file.landed);
}

/**
 * What putting a refused entry back returns: the note too only where it never
 * landed. A spoken note refused before its words came back has no note to
 * return, only its recording, which goes to Write's kept recordings to retry
 * rather than with the entry - unless it held nothing.
 */
export function whatGoesBack(entry: OutboxEntry): {
  message: string | null;
  files: WaitingFile[];
  recording: WaitingRecording | null;
} {
  if (entry.recording && !entry.recording.transcribed) {
    return { message: null, files: entry.files, recording: entry.refused === NOTHING_HEARD ? null : entry.recording };
  }
  if (!entry.landed) return { message: entry.message, files: entry.files, recording: null };
  return { message: null, files: entry.files.filter((file) => file.refused !== null), recording: null };
}

/** A note's send that took longer than this is abandoned, aborted, and tried again later. */
export const SEND_TIMEOUT_MS = 15_000;

/**
 * How long a file's upload is given before it is abandoned: the note's 15s,
 * and a second more for every 100KB. A file of up to 25MB on a phone's
 * connection can take minutes and still be getting through, and an upload
 * abandoned for being slow rather than stuck would only start again from the
 * beginning.
 */
export function uploadTimeoutMs(bytes: number, base: number = SEND_TIMEOUT_MS): number {
  return base + Math.ceil(bytes / (100 * 1024)) * 1_000;
}

/**
 * How long a recording's transcription is given: the upload's time for its
 * size, on four times the note's base, since Whisper has the whole recording
 * to listen to before it answers.
 */
export function transcribeTimeoutMs(bytes: number, base: number = SEND_TIMEOUT_MS): number {
  return uploadTimeoutMs(bytes, base * 4);
}

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
 * timeout - keeps it waiting too.
 *
 * `answered` says which kind of waiting it is. With no answer at all, any
 * other request of the app's getting through is the news that the connection
 * is back; where the server answered and asked for patience, it is not, and
 * only the backoff decides when to ask again.
 */
export function outcomeOf(
  error: unknown,
): { waits: true; answered: boolean } | { waits: false; reason: string } {
  if (!(error instanceof CommandRefused)) return { waits: true, answered: false };
  if (error.status >= 500 || ABOUT_THE_MOMENT.has(error.status)) return { waits: true, answered: true };
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
    ...(entry.priority ? { priority: entry.priority } : {}),
    ...(entry.dueDate ? { dueDate: entry.dueDate } : {}),
    // Kept from when Capture was pressed, not read now (issue 1077).
    ...(entry.timeZone ? { timeZone: entry.timeZone } : {}),
  };
}
