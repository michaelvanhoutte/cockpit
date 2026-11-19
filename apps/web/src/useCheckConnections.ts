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
  withoutDisconnected,
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
 * it is back or a minute has passed. Pressing again while `checking` sends nothing, until the minute's note says a check is taking long: a press then starts a new run.
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
  /** Whether the live run has said it is taking long, after which a press starts a new one. */
  const slow = useRef(false);
  const setLive = (next: CheckRun | null) => {
    live.current = next;
    setRun(next);
  };

  /** The press is over, however it ended. */
  const clear = useCallback(() => {
    live.current = null;
    slow.current = false;
    setRun(null);
    setChecking(false);
  }, []);

  const end = useCallback(
    (last: CheckRun) => {
      const { text, failed } = endedNote(last);
      clear();
      setNote({ ok: failed.length === 0, text, failed });
    },
    [clear],
  );

  const hear = useCallback(
    (next: CheckRun) => {
      setLive(next);
      if (hasEnded(next)) end(next);
    },
    [end],
  );

  /** Reads the history of each connection of the run still out, once, and counts what ended as ended. */
  const readStillOut = useCallback(
    (current: CheckRun): Promise<unknown> => {
      const since = current.since;
      if (since === null) return Promise.resolve();
      return Promise.all(
        stillOut(current).map((one) =>
          import('./components/ConnectionHistory')
            .then(({ fetchHistory }) => fetchHistory(current.workspaceId, one.sourceAccountId))
            .then((history) => {
              const ended = endedByHistory(history, since);
              const now = live.current;
              if (!ended || now?.id !== current.id) return;
              hear(heard(now, now.workspaceId, one.sourceAccountId, ended));
            })
            .catch(() => undefined),
        ),
      );
    },
    [hear],
  );

  const press = useCallback(() => {
    if (live.current !== null && !slow.current) return;
    try {
      refuseWhileOffline();
    } catch (error) {
      if (!(error instanceof WorkingOffline)) throw error;
      setNote({ ok: false, text: error.message, failed: [] });
      return;
    }
    const first = pressed(workspaceId, checkable);
    slow.current = false;
    setLive(first);
    setChecking(true);
    setNote({ ok: true, text: askedNote(checkable.length), failed: [] });
    // Only the press that is still the live one may act on what comes back: an earlier one's answer or refusal is nobody's.
    checkWorkspaceConnectionsNow(workspaceId).then(
      (answer) => {
        const current = live.current;
        if (current?.id !== first.id) return;
        const next = answered(current, answer, checkable);
        if (next.asked.length === 0) {
          clear();
          setNote({ ok: true, text: 'No connection to check.', failed: [] });
          return;
        }
        hear(next);
      },
      () => {
        if (live.current?.id !== first.id) return;
        clear();
        setNote({ ok: false, text: 'That did not reach the server. Try again.', failed: [] });
      },
    );
  }, [workspaceId, checkable, hear, clear]);

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

  // A connection disconnected while waited on is never announced: the Workspace no longer lists it, so the run stops waiting for it.
  useEffect(() => {
    const current = live.current;
    if (!current || current.since === null) return;
    const next = withoutDisconnected(current, checkable);
    if (next === current) return;
    if (next.asked.length === 0) {
      clear();
      setNote({ ok: true, text: 'No connection to check.', failed: [] });
    } else hear(next);
  }, [checkable, hear, clear]);

  // A minute with one still out: each is read once in case the stream lost its word, and what is still out is said as the Settings card says it, which the end replaces.
  const waiting = run !== null && run.since !== null;
  const runId = run?.id;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      const current = live.current;
      if (!current) return;
      void readStillOut(current).then(() => {
        const now = live.current;
        const note = now?.id === current.id ? slowNote(now) : null;
        if (!note) return;
        slow.current = true;
        setNote({ ...note, failed: [] });
      });
    }, CHECK_TAKES_LONG_MS);
    return () => clearTimeout(timer);
  }, [waiting, runId, readStillOut]);

  // The stream came back while waiting: each connection still out is read once, so a check that ended while it was down is not waited on for ever.
  useEffect(() => {
    const onBack = () => {
      const current = live.current;
      if (current) void readStillOut(current);
    };
    globalThis.addEventListener(RECONNECTED, onBack);
    return () => globalThis.removeEventListener(RECONNECTED, onBack);
  }, [readStillOut]);

  // Another Workspace: a press of the last one is dropped, and its note.
  useEffect(
    () => () => {
      clear();
      setNote(null);
    },
    [workspaceId, clear],
  );

  return { press, checking, note };
}
