import { useSyncExternalStore } from 'react';
import { uuidv7, type CommandPayload } from '@cockpit/shared';
import type { ItemOnWhiteboards } from '@cockpit/shared/board';

/**
 * "Take it off there too?" ("Brainstorming: give every Dashboard a whiteboard
 * of its own", issue 1829): **an Item in the Inbox is never on a whiteboard**,
 * so a change that would send an Item with cards there is refused by the server
 * naming them, and asks before it is sent again taking the cards off as well
 * (`sendChange`, `api/queries.ts`). Held here, outside React, so the one
 * question is open whichever screen made the change; the dialog itself is a
 * chunk of its own (`components/TakeOffQuestion.tsx`).
 *
 * **One question for a run of changes.** A selection sends one change per Item,
 * each refused on its own, so a refusal arriving while the question is open
 * joins it, and one arriving for a change made in the same run as the one the
 * person has already answered takes that answer.
 */
export interface WhiteboardQuestion {
  items: readonly ItemOnWhiteboards[];
}

interface Open extends WhiteboardQuestion {
  /** The earliest change waiting on the question, on `madeAt`'s clock. */
  from: number;
  answers: ((takeOff: boolean) => void)[];
}

let open: Open | null = null;
/** The last question answered: the changes made from its first up to the answer take its answer. */
let answered: { from: number; upTo: number; takeOff: boolean } | null = null;
let clock = 0;
const listeners = new Set<() => void>();
const tell = () => listeners.forEach((listener) => listener());

/** A change that may be asked about is being made: its place on the question's clock. */
export function changeMade(): number {
  clock += 1;
  return clock;
}

/**
 * Asks whether to take these Items off their whiteboards too, answering true
 * for *Take off both* and false for *Cancel*. `madeAt` is when the change that
 * was refused was made (`changeMade`).
 */
export function takeThemOff(items: readonly ItemOnWhiteboards[], madeAt: number): Promise<boolean> {
  if (!open && answered && madeAt >= answered.from && madeAt <= answered.upTo) return Promise.resolve(answered.takeOff);
  return new Promise((resolve) => {
    if (open) {
      const known = new Set(open.items.map((item) => item.itemId));
      open = { ...open, from: Math.min(open.from, madeAt), items: [...open.items, ...items.filter((item) => !known.has(item.itemId))], answers: [...open.answers, resolve] };
    } else {
      open = { items, from: madeAt, answers: [resolve] };
    }
    tell();
  });
}

/** The person's answer, for every change waiting on the question. */
export function answerTheQuestion(takeOff: boolean): void {
  const was = open;
  if (!was) return;
  open = null;
  answered = { from: was.from, upTo: clock, takeOff };
  tell();
  for (const answer of was.answers) answer(takeOff);
}

/** The question open now, if any. */
export function useWhiteboardQuestion(): WhiteboardQuestion | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
    () => open,
  );
}

/**
 * *Cancel* was pressed: the change was not made, and there is nothing to say
 * about it (`refusalFrom` reads it as nothing, as it does `PanelNotMade`).
 */
export class KeptOnTheWhiteboard extends Error {
  constructor() {
    super('Kept on the whiteboard.');
    this.name = 'KeptOnTheWhiteboard';
  }
}

/** The cards a change took off with it, where it was sent again with *Take off both*; of each, for a list of answers. */
export function cardsTakenOffBy(answer: unknown): string[] {
  if (Array.isArray(answer)) return answer.flatMap(cardsTakenOffBy);
  return answer && typeof answer === 'object' && 'cardsTakenOff' in answer && Array.isArray(answer.cardsTakenOff)
    ? (answer.cardsTakenOff as string[])
    : [];
}

/**
 * The Undo of a change that may have taken cards off with it: its own inverse,
 * then those cards put back where they were, behind it in the queue.
 */
export function putCardsBackAfter(
  send: (args: { name: 'put_cards_back'; payload: CommandPayload<'put_cards_back'> }) => Promise<unknown>,
  workspaceId: string,
  answers: readonly Promise<unknown>[],
  inverse: () => Promise<unknown>,
): () => Promise<unknown> {
  return async () => {
    // The inverse at once, as it always went; the cards behind it once the change has said which it took.
    const undone = inverse();
    const taken = (await Promise.allSettled(answers)).flatMap((one) => (one.status === 'fulfilled' ? cardsTakenOffBy(one.value) : []));
    if (taken.length === 0) return undone;
    const back = [];
    for (let at = 0; at < taken.length; at += 100) {
      back.push(
        send({
          name: 'put_cards_back',
          payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId, cardIds: taken.slice(at, at + 100) },
        }),
      );
    }
    return Promise.all([undone, ...back]);
  };
}

/** For tests: forgets any question and answer. */
export function forgetTheQuestion(): void {
  open = null;
  answered = null;
  tell();
}
