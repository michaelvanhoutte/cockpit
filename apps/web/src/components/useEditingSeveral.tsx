import { useEffect, useRef, useState } from 'react';
import { uuidv7, type Item } from '@cockpit/shared';
import { useSendCommand } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import {
  dismissSeveral,
  editSeveral,
  putBack,
  saysWhatWasNot,
  undismissSeveral,
  whatWasChanged,
  whatWasDismissed,
  type BulkField,
  type BulkValue,
  type Refused,
  type Sending,
} from '../bulkEdit';
import { barEntryFor, endSeveral, reopenSeveral, targetsOf, whatWasEnded } from '../claudeRunEnd';
import { dueDateLabel } from '../dueDate';
import { dropFromSelection, inShownOrder, keepWhileUnanswered, stopKeeping, useSelection } from '../selection';
import { useUndo } from '../undo';
import { DeleteQuestion } from './DeleteQuestion';
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
  scope,
  onAddAsChildOf,
}: {
  /** *Add as child of…* on Edit ▾ (issue 1825), where the bar offers it. */
  onAddAsChildOf?: (() => void) | undefined;
  workspaceId: string;
  /** Where the selection is held, which a dismissal takes the Items it applied out of. */
  scope: string;
  /** The Items picked, in the order the run takes them. */
  picked: readonly Item[];
  /** That a filing is going, which holds back a second kind of work. */
  filing: boolean;
}) {
  const { data } = useSnapshot(workspaceId);
  const send = useSendCommand();
  const offerToUndo = useUndo();

  /** Which Item (counting from one) of how many is being sent, while a run is going. */
  const [saving, setSaving] = useState<{ at: number; of: number; doing?: string } | null>(null);
  /** The question *Dismiss N items?*, and the button it was asked from, which gets the focus back. */
  const [asking, setAsking] = useState(false);
  const askedFrom = useRef<HTMLElement | null>(null);
  /** That a run is going, kept apart from `saving` so a second press in the same tick is refused too. */
  const running = useRef(false);
  /** What a run could not change and why, with the Items it is about. */
  const [saidOf, setSaidOf] = useState<{ text: string; ids: ReadonlySet<string> } | null>(null);
  const [pickingDate, setPickingDate] = useState(false);
  const [date, setDate] = useState('');

  /** Said only while an Item it is about is picked: a selection begun without them has nothing to say it to. */
  const refusal = saidOf && picked.some((item) => saidOf.ids.has(item.id)) ? saidOf.text : null;
  const refuse = (about: readonly Refused[], text: string | null) =>
    setSaidOf(text ? { text, ids: new Set(about.map(({ item }) => item.id)) } : null);

  /** Whether the selection holds nothing at all, which is the end of what a refusal was said about. */
  const selectionEmpty = useSelection(scope).picked.size === 0;
  useEffect(() => {
    if (selectionEmpty) setSaidOf(null);
  }, [selectionEmpty]);

  useEffect(() => {
    if (picked.length === 0) {
      setPickingDate(false);
      setAsking(false);
    } else if (saidOf && !refusal) setSaidOf(null);
  }, [picked.length, saidOf, refusal]);

  /** The open agent run of an Item, which Done and Dismiss end. */
  const runOf = (itemId: string) => data?.agentRuns?.find((run) => run.itemId === itemId)?.id;

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
    setSaidOf(null);
    setPickingDate(false);
    try {
      const run = editSeveral(sending, {
        items: inShownOrder(scope, picked),
        field,
        value,
        runOf,
        onProgress: (at, of) => setSaving({ at, of }),
        // Offered at the click, before any answer: the Undo waits for the run to
        // finish and then puts back exactly the Items that changed.
        onStarted: (changing, answer) => {
          if (changing.length === 0) return;
          offerToUndo({
            what: whatWasChanged(field, name, changing),
            // Taken back if every Item was refused: there is nothing to put back.
            unlessRefused: answer.then(({ changed }) => {
              if (changed.length === 0) throw new Error('every Item was refused');
            }),
            undo: async () => putBack(sending, field, (await answer).changed),
          });
        },
      });
      const { refused } = await run;
      refuse(refused, saysWhatWasNot('changed', refused));
    } finally {
      running.current = false;
      setSaving(null);
    }
  };

  /** *End Claude run*: every picked row with an open run, and the rest left alone (issue 1770). */
  const targets = targetsOf(picked, data?.agentRuns ?? []);
  const endRuns = async () => {
    if (running.current || filing || targets.length === 0) return;
    running.current = true;
    setSaidOf(null);
    setPickingDate(false);
    try {
      const run = endSeveral(sending, {
        targets,
        onStarted: (answer) =>
          offerToUndo({
            what: whatWasEnded(targets),
            unlessRefused: answer.then(({ ended }) => {
              if (ended.length === 0) throw new Error('every run was refused');
            }),
            undo: async () => reopenSeveral(sending, (await answer).ended),
          }),
      });
      const { refused } = await run;
      refuse(refused, saysWhatWasNot('changed', refused));
    } finally {
      running.current = false;
    }
  };

  /** *Dismiss*, pressed on the bar: asks first, and sends nothing until the question is answered. */
  const askToDismiss = (from: HTMLElement) => {
    if (running.current || filing || picked.length === 0) return;
    askedFrom.current = from;
    setPickingDate(false);
    setAsking(true);
  };

  /**
   * Dismisses everything picked, as one row's Dismiss does each, after the
   * question was answered with Dismiss ("Selection: picked Items can be moved and
   * edited but not dismissed - add Dismiss to the selection bar, asking first",
   * issue 1819).
   *
   * **An Item is kept in the selection until its dismissal is answered**, though
   * it is drawn gone the moment it is handed over, so one the server refuses is
   * still picked when it is drawn back; one it applied is taken out.
   */
  const dismiss = async () => {
    setAsking(false);
    if (running.current || filing || picked.length === 0) return;
    running.current = true;
    setSaidOf(null);
    const items = inShownOrder(scope, picked);
    const ids = items.map((item) => item.id);
    keepWhileUnanswered(ids);
    try {
      const run = dismissSeveral(sending, {
        items,
        runOf,
        onProgress: (at, of) => setSaving({ at, of, doing: 'Dismissing' }),
        onStarted: (dismissing, answer) =>
          offerToUndo({
            what: whatWasDismissed(dismissing),
            unlessRefused: answer.then(({ changed }) => {
              if (changed.length === 0) throw new Error('every Item was refused');
            }),
            // Corrected to what was dismissed once the answers are in.
            saidAfter: answer.then(({ changed }) =>
              changed.length === dismissing.length ? undefined : { what: whatWasDismissed(changed) },
            ),
            undo: async () => undismissSeveral(sending, (await answer).changed),
          }),
      });
      const { changed, refused: notDismissed } = await run;
      dropFromSelection(scope, changed.map(({ item }) => item.id));
      refuse(notDismissed, saysWhatWasNot('dismissed', notDismissed));
    } finally {
      stopKeeping(ids);
      running.current = false;
      setSaving(null);
    }
  };

  /** How many are picked, as the question words it. */
  const howMany = `${picked.length} ${picked.length === 1 ? 'item' : 'items'}`;

  const applyDate = () => {
    if (!date || running.current || filing) return;
    void set('dueDate', date, dueDateLabel(date) ?? date);
    setDate('');
  };

  return {
    /** Which Item of how many is being sent, or null when no run is going. */
    saving,
    /** How many the last run could not change, and why. */
    refusal,
    /** Opens the question *Dismiss N items?*, from the button pressed. */
    askToDismiss,
    /** The question itself, drawn over the page. */
    dismissQuestion: (
      <DeleteQuestion
        open={asking && picked.length > 0}
        question={`Dismiss ${howMany}?`}
        confirmLabel={`Dismiss ${howMany}`}
        confirmText="Dismiss"
        returnFocusTo={askedFrom.current}
        // The bar's Dismiss is unavailable for the run and the bar leaves with the selection, so the list it was for takes the focus.
        focusInstead={() => document.querySelector<HTMLElement>(`[data-selection-home="${scope}"]`)}
        onCancel={() => setAsking(false)}
        onConfirm={() => void dismiss()}
      />
    ),
    /** Edit ▾, to sit among the bar's buttons. */
    menu: (
      <EditSeveralMenu
        picked={picked}
        disabled={saving !== null || filing}
        onSet={(field, value, name) => void set(field, value, name)}
        onPickDate={() => setPickingDate(true)}
        endRuns={barEntryFor(targets)}
        onEndRuns={() => void endRuns()}
        onAddAsChildOf={onAddAsChildOf}
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
