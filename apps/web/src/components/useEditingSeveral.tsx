import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { uuidv7, type Item } from '@cockpit/shared';
import { snapshotQuery, useSendCommand } from '../api/queries';
import {
  editSeveral,
  putBack,
  saysWhatWasNotChanged,
  whatWasChanged,
  type BulkField,
  type BulkValue,
  type Sending,
} from '../bulkEdit';
import { dueDateLabel } from '../dueDate';
import { useUndo } from '../undo';
import { EditSeveralMenu } from './EditSeveralMenu';

/**
 * Changing one field of everything a selection holds, and the questions around
 * it ("Change the type, priority, due date or status of every selected item from
 * the selection bar", issue 864): the Edit ▾ menu, the date field Pick a date…
 * opens, and the run itself (`editSeveral`).
 *
 * **A hook, like `useFilingSeveral`**, because the Dashboard's bar and the
 * Inbox's are drawn by different parts and edit with the same code, handed the
 * Items picked. Nothing here ends the selection: it stays held for a second
 * field, and what a change takes out of its lists (Done) leaves it by the
 * pruning every selection already has.
 */
export function useEditingSeveral({
  workspaceId,
  picked,
  filing,
}: {
  workspaceId: string;
  /** The Items picked, in the order the run takes them. */
  picked: readonly Item[];
  /** That a filing is going, which holds back a second kind of work. */
  filing: boolean;
}) {
  const { data } = useQuery(snapshotQuery(workspaceId));
  const send = useSendCommand();
  const offerToUndo = useUndo();

  /** Which Item (counting from one) of how many is being sent, while a run is going. */
  const [saving, setSaving] = useState<{ at: number; of: number } | null>(null);
  /** That a run is going, kept apart from `saving` so a second press in the same tick is refused too. */
  const running = useRef(false);
  /** How many a run could not change and why, if it could not change some. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pickingDate, setPickingDate] = useState(false);
  const [date, setDate] = useState('');

  // A refusal belongs to the selection it was about, as a filing's does.
  useEffect(() => {
    if (picked.length === 0) {
      setRefusal(null);
      setPickingDate(false);
    }
  }, [picked.length]);

  const sending: Sending = {
    send,
    envelope: (itemId) => () => ({
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId,
      itemId,
    }),
  };

  /** Sets a field on everything picked; `name` is what the choice is called, null for the due date cleared. */
  const set = async (field: BulkField, value: BulkValue, name: string | null) => {
    if (running.current || filing || picked.length === 0) return;
    running.current = true;
    setRefusal(null);
    setPickingDate(false);
    try {
      const { changed, refused } = await editSeveral(sending, {
        items: picked,
        field,
        value,
        types: data?.itemTypes ?? [],
        runOf: (itemId) => data?.agentRuns?.find((run) => run.itemId === itemId)?.id,
        onProgress: (at, of) => setSaving({ at, of }),
      });
      setRefusal(saysWhatWasNotChanged(refused));
      if (changed.length === 0) return;
      offerToUndo({
        what: whatWasChanged(field, name, changed),
        undo: () => putBack(sending, field, changed),
      });
    } finally {
      running.current = false;
      setSaving(null);
    }
  };

  const applyDate = () => {
    if (!date) return;
    void set('dueDate', date, dueDateLabel(date) ?? date);
    setDate('');
  };

  return {
    /** Which Item of how many is being sent, or null when no run is going. */
    saving,
    /** How many the last run could not change, and why. */
    refusal,
    /** Edit ▾, to sit among the bar's buttons. */
    menu: (
      <EditSeveralMenu
        picked={picked}
        types={data?.itemTypes ?? []}
        disabled={saving !== null || filing}
        onSet={(field, value, name) => void set(field, value, name)}
        onPickDate={() => setPickingDate(true)}
      />
    ),
    /** The date field Pick a date… opens, for the bar to draw under its buttons. */
    dateField: pickingDate && (
      <div className="flex items-center gap-2 pt-2 text-sm">
        <label className="flex items-center gap-2">
          Due date
          <input
            type="date"
            autoFocus
            value={date}
            onChange={(event) => setDate(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyDate();
            }}
            className="rounded-md border border-shade/10 bg-field px-2 py-1 text-ink outline-none focus:border-accent"
          />
        </label>
        <button
          type="button"
          disabled={!date}
          onClick={applyDate}
          className="rounded-sm border border-accent/40 bg-surface px-2 py-1 hover:border-accent disabled:opacity-50"
        >
          Set
        </button>
        <button
          type="button"
          onClick={() => setPickingDate(false)}
          className="rounded-sm px-2 py-1 text-ink-soft hover:text-ink"
        >
          Cancel
        </button>
      </div>
    ),
  };
}
