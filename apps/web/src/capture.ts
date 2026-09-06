import { uuidv7 } from '@cockpit/shared';
import { CommandRefused } from './api/client';
import { useCommand } from './api/queries';

/**
 * Capturing a note - the one piece of choreography behind every front door in
 * the app.
 *
 * **Here rather than in either surface that runs it**, because there are two:
 * the Inbox's own row (components/CaptureForm.tsx) and the Capture page
 * (pages/CapturePage.tsx). They ask the question differently - one line and a
 * dropdown against a page of chips - and the answer they send has to be the
 * same one.
 *
 * **It used to make the type first**, where the name typed matched none of the
 * account's, and that was the only way a type came into existence. Types are
 * now made in the window they are managed in ("Make a type where types are
 * managed, not while capturing", issue 203), so capture chooses among the types
 * there are and nothing else: what arrives here is a type's id, and every
 * capture carries one.
 */

/** What is being captured, once the surface has read it off the screen. */
export interface WhatToCapture {
  /** The note, already trimmed and known not to be empty. */
  message: string;
  /**
   * The type it was given, which every capture has: *No type* was an answer
   * until every Item needed one, and both surfaces now fall back to the type
   * used last rather than to none.
   *
   * An id rather than a name, which is what changed when capture stopped making
   * types: a name was an answer that might not name anything yet, and this
   * cannot be. The surface is what checks it against the types it is showing,
   * so one deleted in another tab is replaced here rather than sent as an id
   * the server would refuse - and a surface with no types to show does not
   * capture at all.
   */
  typeId: string;
  /** The workspace it is captured against - where it belongs, or came from. */
  workspaceId: string;
  /**
   * Whether that workspace is where this *belongs* or only where it was
   * captured from ("Capture something before you know which workspace it
   * belongs to", issue 165).
   */
  decided: boolean;
}

/** What the surface is told, as the capture goes. */
export interface CaptureAnswers {
  /**
   * The moment the capture is asked for, which is when the box empties.
   *
   * Called *before* the answer rather than after it: capture must not wait on
   * the network (architecture, "Performance budgets"), so the box is cleared
   * on the way out and put back by `refused` if it has to be.
   */
  asking?: () => void;
  /** It landed, with the type it ended up carrying. */
  captured?: (typeId: string) => void;
  /** It did not, and this is what to say. */
  refused: (why: string) => void;
}

/**
 * How long ago something happened, in the one or two characters a list of what
 * you have just captured has room for: seconds read as *now*, and everything
 * else is the largest whole unit it has passed.
 *
 * Takes the elapsed milliseconds rather than a time and a clock, which is what
 * keeps it a calculation: nothing here reads `Date.now()`.
 */
export function howLongAgo(millis: number): string {
  const seconds = Math.max(0, Math.floor(millis / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const wentWrong = (error: unknown) =>
  error instanceof CommandRefused ? error.message : 'That did not reach the server. Try again.';

/**
 * `ask` captures; `busy` is true while the request is out, so a button can say
 * so.
 */
export function useCapture(): {
  ask: (what: WhatToCapture, answers: CaptureAnswers) => void;
  busy: boolean;
} {
  const command = useCommand();

  const ask = (what: WhatToCapture, answers: CaptureAnswers) => {
    answers.asking?.();
    command.mutate(
      {
        name: 'capture_item',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: what.workspaceId,
          itemId: uuidv7(),
          message: what.message,
          typeId: what.typeId,
          // Sent only when it is false, so every front door that captures
          // into a named workspace reads exactly as it did before this
          // landed.
          ...(what.decided ? {} : { workspaceDecided: false }),
        },
      },
      {
        onSuccess: () => answers.captured?.(what.typeId),
        /**
         * **The note goes back in the box**, which is the other half of
         * emptying it before the answer comes. A workspace deleted in another
         * tab is enough to produce one, and the note used to go with it in
         * silence.
         */
        onError: (error) => answers.refused(wentWrong(error)),
      },
    );
  };

  return { ask, busy: command.isPending };
}
