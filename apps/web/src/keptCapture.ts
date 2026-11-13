import type { Priority } from '@cockpit/shared';
import type { FiledOn } from './components/FileOnLine';

/**
 * Capture's unsaved draft across the reload an update takes ("Carry Capture's
 * note across the update's reload", issue 1746).
 *
 * **The update asks, Capture answers, and only while mounted.** Capture
 * registers a hand-over (`offerCapture`) and knows nothing of versions; the
 * update code (`updating.ts`) calls `keepCaptureForReload` at the instant it
 * reloads. Nothing is written while typing, so a reload you do yourself, or
 * closing the app, finds nothing.
 *
 * **Kept in this tab's session storage, read once and deleted** by the first
 * Capture of the next load (`takeKeptCapture`). Session storage rather than
 * IndexedDB or local storage, which outlive the app being closed. Files are
 * never kept. The logon page clears it (`session/forget.ts`).
 */

const KEY = 'cockpit.updating.kept-capture';

/** What Capture holds that an update's reload puts back. */
export interface KeptDraft {
  note: string;
  priority: Priority | null;
  due: string | null;
  /** The workspace, or null for *Any workspace*. */
  where: string | null;
  panels: FiledOn[];
  /** The Capture page, or the desk window over a screen. */
  shownAs: 'page' | 'window';
}

/** What a mounted Capture answers with. */
export interface HandOver {
  draft(): KeptDraft;
  /** Whether a file is attached and not yet captured, which is never kept. */
  hasFiles(): boolean;
}

let offered: HandOver | null = null;
const listeners = new Set<() => void>();

/** Capture offers its draft while it is on screen; the returned function withdraws it. */
export function offerCapture(handOver: HandOver): () => void {
  offered = handOver;
  announce();
  return () => {
    if (offered === handOver) offered = null;
    announce();
  };
}

/** Said by Capture when what `hasFiles` answers may have changed. */
export function announce(): void {
  for (const listener of listeners) listener();
}

export function watchCapture(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const captureHoldsFiles = (): boolean => offered?.hasFiles() ?? false;

/** Takes the draft from the Capture on screen, if it has a note, and keeps it for the next load. Never throws. */
export function keepCaptureForReload(memory: Storage | undefined): void {
  try {
    const draft = offered?.draft();
    if (!draft || draft.note.trim() === '') return;
    memory?.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Storage refused: the reload goes ahead and the note is lost, as it was before.
  }
}

/** Throws the kept draft away: an update that did not reload leaves nothing behind. */
export function discardKeptCapture(memory: Storage | undefined): void {
  try {
    memory?.removeItem(KEY);
  } catch {
    // Nothing kept that could be read back either.
  }
}

/** The kept draft without taking it, for the screen that reopens the window. */
export function peekKeptCapture(memory: Storage | undefined): KeptDraft | null {
  try {
    const raw = memory?.getItem(KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Partial<KeptDraft>;
    if (typeof draft.note !== 'string') return null;
    return {
      note: draft.note,
      priority: draft.priority ?? null,
      due: draft.due ?? null,
      where: draft.where ?? null,
      panels: Array.isArray(draft.panels) ? draft.panels : [],
      shownAs: draft.shownAs === 'window' ? 'window' : 'page',
    };
  } catch {
    return null;
  }
}

/** Reads the kept draft and deletes it, so only the first Capture of the load gets it. */
export function takeKeptCapture(memory: Storage | undefined): KeptDraft | null {
  const draft = peekKeptCapture(memory);
  discardKeptCapture(memory);
  return draft;
}
