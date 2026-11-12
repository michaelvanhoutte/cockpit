import { useSyncExternalStore } from 'react';

/**
 * The question *Email…* and *Reply…* ask before a draft is made where Claude can
 * write it: "Anything Claude should say? (optional)" ("Mail follow-up: Reply… in
 * Gmail makes an empty draft: have Claude write it from the Item, your points and
 * the conversation", issue 1730). One question at a time, held here so the click
 * (`emailFromItem`) can wait on the answer and the box (`DraftAsk`) can draw it.
 *
 * **The tab is opened by the press that answers**, inside that press, while it
 * still allows a new tab: a pop-up blocker would refuse one opened after the
 * request. Cancelled, nothing is opened and nothing is asked of the server.
 */

/** What the box was answered with: Claude is to write the draft from these points, or the person writes it. */
export type DraftAnswer = { mode: 'claude'; points: string } | { mode: 'self' };
export type DraftChoice = DraftAnswer & { tab: Window | null };

/** The question being asked, and how it is answered; `null` when none is. */
export interface Asking {
  /** Which question this is, so a box drawn twice in a row starts empty both times. */
  id: number;
  /** The Item it is for, as the row or the form calls it. */
  label: string;
  answer: (choice: DraftChoice | null) => void;
}

let asking: Asking | null = null;
let asked = 0;
const listeners = new Set<() => void>();

function changed(next: Asking | null): void {
  asking = next;
  for (const listen of listeners) listen();
}

/** Asks the question; answers the choice, or `null` where it was cancelled. Asking again cancels the one before. */
export function askForPoints(label: string): Promise<DraftChoice | null> {
  asking?.answer(null);
  return new Promise((resolve) => {
    asked += 1;
    const question: Asking = {
      id: asked,
      label,
      answer: (choice) => {
        if (asking === question) changed(null);
        resolve(choice);
      },
    };
    changed(question);
  });
}

/** The question being asked now, for the box to draw. */
export function useDraftQuestion(): Asking | null {
  return useSyncExternalStore(
    (listen) => {
      listeners.add(listen);
      return () => listeners.delete(listen);
    },
    () => asking,
  );
}

/** Cancels the question being asked, if one is: as Cancel does. */
export function cancelDraftQuestion(): void {
  asking?.answer(null);
}
