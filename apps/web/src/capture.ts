import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_WIDE, uuidv7, type ItemType } from '@cockpit/shared';
import { CommandRefused } from './api/client';
import { itemTypesQuery, useCommand, useSendCommand } from './api/queries';
import { typeNamed } from './itemTypes';

/**
 * Capturing a note, making the type first where the name matches none - the
 * one piece of choreography behind every front door in the app.
 *
 * **Here rather than in either surface that runs it**, because there are two:
 * the Inbox's own row (components/CaptureForm.tsx) and the Capture page
 * (pages/CapturePage.tsx). They ask the question differently - one line and a
 * list against a page of chips - and the answer they send has to be the same
 * one, or the two disagree about what naming a type does.
 */

/** What is being captured, once the surface has read it off the screen. */
export interface WhatToCapture {
  /** The note, already trimmed and known not to be empty. */
  message: string;
  /** The type it was given, by name. Empty for none. */
  typeName: string;
  /** The types the account holds, which is what a name is matched against. */
  types: readonly ItemType[];
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
  captured?: (typeId: string | undefined) => void;
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
 * `ask` captures; `busy` is true while either request is out, so a button can
 * say so.
 *
 * **The type is made and then looked up again rather than assumed.** The id
 * generated here is only used if this request is what created the type; where
 * another tab made one of that name first the store keeps its row and ignores
 * this one, so capturing against the id invented here would name something
 * nobody stored and be refused - and the note would be gone. Re-reading the
 * types is what turns that race into two people agreeing on one type.
 */
export function useCapture(): {
  ask: (what: WhatToCapture, answers: CaptureAnswers) => void;
  busy: boolean;
} {
  const command = useCommand();
  const send = useSendCommand();
  const queryClient = useQueryClient();
  /** True while the type is being made, so the button says so like any other. */
  const [makingTheType, setMakingTheType] = useState(false);

  const ask = (what: WhatToCapture, answers: CaptureAnswers) => {
    const capture = (typeId: string | undefined) => {
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
            ...(typeId ? { typeId } : {}),
            // Sent only when it is false, so every front door that captures
            // into a named workspace reads exactly as it did before this
            // landed.
            ...(what.decided ? {} : { workspaceDecided: false }),
          },
        },
        {
          onSuccess: () => answers.captured?.(typeId),
          /**
           * **The note goes back in the box**, which is the other half of
           * emptying it before the answer comes. A workspace deleted in
           * another tab is enough to produce one, and the note used to go with
           * it in silence.
           */
          onError: (error) => answers.refused(wentWrong(error)),
        },
      );
    };

    const wanted = what.typeName.trim();
    const already = wanted ? typeNamed(what.types, wanted) : undefined;
    if (!wanted || already) {
      capture(already?.id);
      return;
    }

    setMakingTheType(true);
    void (async () => {
      try {
        await send({
          name: 'create_item_type',
          payload: {
            commandId: uuidv7(),
            issuedAt: new Date().toISOString(),
            // The account, not the workspace this was captured in: a type
            // belongs to the account, and the live-updates handler reads that
            // to know every workspace's types have changed. Sending the
            // workspace here left every other tab's list stale until an
            // unrelated refetch happened to catch it up.
            workspaceId: ACCOUNT_WIDE,
            typeId: uuidv7(),
            name: wanted,
          },
        });
        // Whichever request made it, this is the one type now going by that name.
        const made = typeNamed(
          (await queryClient.fetchQuery(itemTypesQuery)).itemTypes,
          wanted,
        );
        capture(made?.id);
      } catch (error) {
        // The note stays in the box, so it can be captured again once the type
        // is named something the server will take.
        answers.refused(wentWrong(error));
      } finally {
        setMakingTheType(false);
      }
    })();
  };

  return { ask, busy: command.isPending || makingTheType };
}
