import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

/**
 * Putting back what the last change took away ("Undo what just happened",
 * issue 144).
 *
 * **Why it exists.** Dismissing an item is a tombstone, so nothing is
 * destroyed - and nothing in the app could bring it back either, which made an
 * accidental dismissal unrecoverable in practice. Filing has the same problem
 * from the other side: a move sends an item to a dashboard that is not on
 * screen.
 *
 * **The change carries its own inverse.** What is remembered here is a sentence
 * and a function, not an item and a description of what happened to it - so
 * nothing in this file knows what an item, a panel or a status is, and a later
 * gesture (#141, #142) adds itself by remembering its own inverse rather than
 * by teaching this file a new case.
 *
 * **Only the last change**, deliberately. A stack is what a document editor
 * needs; what an accident needs is one step back, offered where you are looking
 * and gone shortly after. A second change replaces what is offered, and an undo
 * cannot itself be undone.
 */

/** How long the bar stays before it goes on its own. */
export const THE_BAR_LASTS_MS = 10_000;

export interface Undoable {
  /** What just happened, in one line: "Reply to Bart moved to Falcon". */
  what: string;
  /** Puts it back. Throwing is how it reports that it could not. */
  undo: () => Promise<unknown>;
}

const Remembering = createContext<((change: Undoable) => void) | null>(null);

/**
 * Offers this change as the one that can be undone, replacing whatever was
 * offered before.
 *
 * Answers with a function that does nothing outside an `UndoWhatJustHappened`,
 * rather than throwing: a list rendered in a test harness or on a screen with
 * no bar should still work, and losing the offer of an undo is a smaller thing
 * than a screen that will not render.
 */
export function useUndo(): (change: Undoable) => void {
  return useContext(Remembering) ?? noteNothing;
}

const noteNothing = () => {};

/**
 * The mounted bar's way of emptying itself, so signing out can reach it.
 *
 * A module-level handle rather than another context, because the caller is
 * `session/forget.ts` - which runs outside React, from the one screen that has
 * none of the app mounted. Null when no bar is mounted, which is most of the
 * time on that screen.
 */
let forgetWhenTheVisitEnds: (() => void) | null = null;

/** Empties the bar, if one is mounted. Called when a visit ends. */
export function forgetWhatJustHappened(): void {
  forgetWhenTheVisitEnds?.();
}

/**
 * The bar, and what it is holding. Wraps the shell, so a change made in the
 * Inbox column and one made on a panel are both offered back in the same place.
 */
export function UndoWhatJustHappened({ children }: { children: React.ReactNode }) {
  const [held, setHeld] = useState<Undoable | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  /**
   * The timer, kept so a second change restarts it rather than inheriting how
   * long the first had left - ten seconds from the change, every change.
   */
  const goesAt = useRef<ReturnType<typeof setTimeout> | null>(null);

  const forgetNow = useCallback(() => {
    goesAt.current = null;
    setHeld(null);
    setFailure(null);
    setUndoing(false);
  }, []);

  const forget = useCallback(() => {
    if (goesAt.current) clearTimeout(goesAt.current);
    forgetNow();
  }, [forgetNow]);

  const remember = useCallback(
    (change: Undoable) => {
      if (goesAt.current) clearTimeout(goesAt.current);
      setHeld(change);
      setFailure(null);
      setUndoing(false);
      goesAt.current = setTimeout(forgetNow, THE_BAR_LASTS_MS);
    },
    [forgetNow],
  );

  /**
   * **Signing out takes the bar with it.** It is mounted above the router, so
   * it outlives the navigation to the logon page - and what it is holding is
   * one of the previous person's item titles, on the screen the next person
   * signs in from. `session/forget.ts` empties the three other places this
   * browser holds anything about them; this is the fourth, and it is reached
   * the same way rather than by moving the bar inside a screen.
   */
  useEffect(() => {
    forgetWhenTheVisitEnds = forget;
    return () => {
      if (forgetWhenTheVisitEnds === forget) forgetWhenTheVisitEnds = null;
      if (goesAt.current) clearTimeout(goesAt.current);
    };
  }, [forget]);

  const putItBack = async () => {
    if (!held || undoing) return;
    // **The clock stops while the undo is in flight.** Without this the bar can
    // reach ten seconds mid-request and unmount, and the failure that arrives a
    // moment later is written to something nothing is drawing - so a slow undo
    // that did not work looks exactly like one that did.
    if (goesAt.current) clearTimeout(goesAt.current);
    goesAt.current = null;
    setUndoing(true);
    setFailure(null);
    try {
      await held.undo();
      forget();
    } catch (error) {
      // Said, and given its own full time to be read. Not retried and not
      // cleared: what the server has is what the item is, and offering the same
      // undo again would be offering to guess a second time.
      setFailure(error instanceof Error ? error.message : 'that could not be put back');
      setUndoing(false);
      goesAt.current = setTimeout(forgetNow, THE_BAR_LASTS_MS);
    }
  };

  return (
    <Remembering.Provider value={remember}>
      {children}
      {held && (
        <div
          // `status` rather than `alert`: it reports something that has already
          // happened and is not an error, so it is announced without
          // interrupting what is being read.
          role="status"
          className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-4"
        >
          <div className="flex max-w-[min(32rem,calc(100vw-2rem))] items-center gap-3 rounded-lg bg-ink px-4 py-2.5 text-sm text-white shadow-lg">
            <span className="min-w-0 flex-1 truncate">{failure ?? held.what}</span>
            <button
              type="button"
              disabled={undoing}
              onClick={() => void putItBack()}
              className="shrink-0 rounded px-2 py-1 font-medium text-accent-soft hover:bg-white/10 disabled:opacity-50"
            >
              Undo
            </button>
          </div>
        </div>
      )}
    </Remembering.Provider>
  );
}
