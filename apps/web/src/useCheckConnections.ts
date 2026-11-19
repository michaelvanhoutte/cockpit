import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkingOffline, refuseWhileOffline } from './offline';
import { RECONNECTED } from './updating';
import { hearCheckEnds } from './checkEnds';
import { CHECK_TAKES_LONG_MS } from './connectionHistory';
import {
  answered,
  askedNote,
  checkWorkspaceConnectionsNow,
  endedBy,
  endedByHistory,
  endedNote,
  hasEnded,
  heard,
  pressed,
  slowNote,
  stillOut,
  type Checkable,
  type CheckRun,
} from './checkConnections';

/** What the note under the Inbox's heading says, and the connections it names as failed. */
export interface CheckNote {
  ok: boolean;
  text: string;
  failed: Checkable[];
}

/**
 * The Inbox's ↻ ("Inbox: mail you just labelled waits for the five-minute check, or a Check now per connection in Settings: add a ↻ to the Inbox heading that checks them all now", issue 1835): `press` asks the server to check every pulled
 * connection of the Workspace and `checking` is true until each has said its
 * check ended, by the stream's announcement of its history line - or, where the
 * stream dropped while waiting, by one read of that connection's history when
 * it is back. Pressing again while `checking` sends nothing.
 *
 * **A press belongs to the Workspace it was made in**: opening another drops
 * it, and its note with it.
 */
export function useCheckConnections(workspaceId: string, checkable: readonly Checkable[]) {
  const [run, setRun] = useState<CheckRun | null>(null);
  const [note, setNote] = useState<CheckNote | null>(null);
  /** Whether a press is under way: from the click until the last connection has ended or the server was not reached. */
  const [checking, setChecking] = useState(false);
  const live = useRef<CheckRun | null>(null);
  const setLive = (next: CheckRun | null) => {
    live.current = next;
    setRun(next);
  };

  const end = useCallback((last: CheckRun) => {
    const { text, failed } = endedNote(last);
    live.current = null;
    setRun(null);
    setChecking(false);
    setNote({ ok: failed.length === 0, text, failed });
  }, []);

  const hear = useCallback(
    (next: CheckRun) => {
      setLive(next);
      if (hasEnded(next)) end(next);
    },
    [end],
  );

  const press = useCallback(() => {
    if (live.current !== null) return;
    try {
      refuseWhileOffline();
    } catch (error) {
      if (!(error instanceof WorkingOffline)) throw error;
      setNote({ ok: false, text: error.message, failed: [] });
      return;
    }
    const first = pressed(workspaceId, checkable);
    setLive(first);
    setChecking(true);
    setNote({ ok: true, text: askedNote(checkable.length), failed: [] });
    checkWorkspaceConnectionsNow(workspaceId).then(
      (answer) => {
        const current = live.current;
        // Dropped meanwhile - another Workspace was opened - and the answer is nobody's.
        if (current === null || current.workspaceId !== first.workspaceId) return;
        const next = answered(current, answer, checkable);
        if (next.asked.length === 0) {
          live.current = null;
          setRun(null);
          setChecking(false);
          setNote({ ok: true, text: 'No connection to check.', failed: [] });
          return;
        }
        hear(next);
      },
      () => {
        if (live.current === null) return;
        live.current = null;
        setRun(null);
        setChecking(false);
        setNote({ ok: false, text: 'That did not reach the server. Try again.', failed: [] });
      },
    );
  }, [workspaceId, checkable, hear]);

  // The stream's word that a check ended: kept, and the press ended where it was the last.
  useEffect(
    () =>
      hearCheckEnds((event) => {
        const current = live.current;
        const ended = endedBy(event);
        if (!current || !ended) return;
        const next = heard(current, event.workspaceId, event.sourceAccountId, ended);
        if (next !== current) hear(next);
      }),
    [hear],
  );

  // A minute with one still out: the Settings card's own note, which the end replaces.
  const waiting = run !== null && run.since !== null;
  const since = run?.since;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      const current = live.current;
      const slow = current ? slowNote(current) : null;
      if (slow) setNote({ ...slow, failed: [] });
    }, CHECK_TAKES_LONG_MS);
    return () => clearTimeout(timer);
  }, [waiting, since]);

  // The stream came back while waiting: each connection still out is read once, so a check that ended while it was down is not waited on for ever.
  useEffect(() => {
    const onBack = () => {
      const current = live.current;
      if (!current || current.since === null) return;
      const since = current.since;
      for (const one of stillOut(current)) {
        void import('./components/ConnectionHistory')
          .then(({ fetchHistory }) => fetchHistory(current.workspaceId, one.sourceAccountId))
          .then((history) => {
            const ended = endedByHistory(history, since);
            const now = live.current;
            if (!ended || !now || now.since !== since) return;
            hear(heard(now, now.workspaceId, one.sourceAccountId, ended));
          })
          .catch(() => undefined);
      }
    };
    globalThis.addEventListener(RECONNECTED, onBack);
    return () => globalThis.removeEventListener(RECONNECTED, onBack);
  }, [hear]);

  // Another Workspace: a press of the last one is dropped, and its note.
  useEffect(
    () => () => {
      live.current = null;
      setRun(null);
      setChecking(false);
      setNote(null);
    },
    [workspaceId],
  );

  return { press, checking, note };
}
