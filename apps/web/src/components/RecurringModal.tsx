import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  RECURRING_REFUSALS,
  dayOf,
  firstNextOn,
  ruleLabel,
  uuidv7,
  type RecurringItem,
  type WorkspaceSnapshot,
} from '@cockpit/shared';
import { useChangeRecurringItem, useRecurringItems } from '../api/recurringItems';
import { whyNotDone } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { weekdayDayLabel } from '../dateFormat';
import { deviceTimeZone } from '../deviceTimeZone';
import { useIsOffline } from '../offline';
import { RecurringFormBody, placeOf, type Refused } from './RecurringForm';

/**
 * The recurring items of a Workspace in one modal over whatever is on screen,
 * with no address of its own ("Make, change and delete recurring items from the
 * Recurring items modal", issue 1449). It shows the list, or - swapped in the
 * same window, never a second one - one recurring item's form with ← Recurring
 * items to go back. Close, Escape or the scrim closes the modal and drops what
 * was not saved.
 *
 * **A save shows at once**: the form goes back to the list with the row already in
 * it, and the server is still to answer. Refused, the form comes back with what was
 * typed and the reason beside the field - unless the person has moved on, when the
 * list says it. Deleting is the same, and the question goes with it.
 *
 * **It needs a connection to open**: the list is a read of its own, made each time
 * the modal opens (`useRecurringItems`), and offline there is nothing to read.
 */

/** The day a row shows its *Next on* by, with the year only where it is not this one. */
const nextOnLabel = (day: string): string =>
  weekdayDayLabel(day) + (day.slice(0, 4) === String(new Date().getFullYear()) ? '' : ` ${day.slice(0, 4)}`);

/** Where a recurring item files its copies, in the words the page says it. */
const filesOn = (snapshot: WorkspaceSnapshot, item: RecurringItem): string => {
  const places = item.panelIds.flatMap((id) => placeOf(snapshot, id) ?? []);
  return places.length > 0 ? places.join(', ') : 'Inbox';
};

/** The field a refusal is said beside. */
const refusedWith = (failure: unknown): Refused => {
  const text = whyNotDone(failure);
  if (text === RECURRING_REFUSALS.nextOnPassed) return { field: 'nextOn', text };
  if (text === RECURRING_REFUSALS.panelGone) return { field: 'panels', text };
  return { field: 'other', text };
};

type View = { kind: 'list' } | { kind: 'form'; isNew: boolean; item: RecurringItem; refusal: Refused | null };

const aNewOne = (workspaceId: string): RecurringItem => ({
  id: uuidv7(),
  workspaceId,
  title: '',
  description: '',
  priority: null,
  panelIds: [],
  frequency: 'weekly',
  nextOn: firstNextOn(dayOf(new Date()), 'weekly'),
  dueAfterDays: null,
});

export default function RecurringModal({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const snapshot = useSnapshot(workspaceId).data;
  const list = useRecurringItems(workspaceId);
  const change = useChangeRecurringItem();
  const offline = useIsOffline();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [notice, setNotice] = useState<string | null>(null);
  // What is on screen *now*, for a refusal that comes back after the person moved on.
  const viewNow = useRef(view);
  viewNow.current = view;
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const rows = [...(list.data?.recurringItems ?? [])].sort((a, b) => a.nextOn.localeCompare(b.nextOn) || a.title.localeCompare(b.title));
  const toList = () => setView({ kind: 'list' });

  /** Saves at the click: the form closes and the list has the row at once. Refused, the form comes back with the reason. */
  const save = (item: RecurringItem, isNew: boolean) => {
    setNotice(null);
    setView({ kind: 'list' });
    const { frequency, nextOn, dueAfterDays } = item;
    change({
      name: isNew ? 'create_recurring_item' : 'write_recurring_item',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        seriesId: item.id,
        title: item.title,
        description: item.description,
        priority: item.priority,
        panelIds: item.panelIds,
        repeat: { frequency, nextOn, dueAfterDays, timeZone: deviceTimeZone() ?? 'UTC' },
      },
    }).catch((failure: unknown) => {
      if (!open.current) return;
      // Moved on to another form meanwhile: not pulled back into this one.
      if (viewNow.current.kind !== 'list') return setNotice(`“${item.title}” was not saved. ${whyNotDone(failure)}`);
      setView({ kind: 'form', isNew, item, refusal: refusedWith(failure) });
    });
  };

  /** Stops it at the click: back to the list with the row gone. Refused, the list says why. */
  const remove = (item: RecurringItem) => {
    setNotice(null);
    setView({ kind: 'list' });
    change({
      name: 'delete_recurring_item',
      payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId, seriesId: item.id },
    }).catch((failure: unknown) => {
      if (open.current) setNotice(`“${item.title}” was not deleted. ${whyNotDone(failure)}`);
    });
  };

  const ready = snapshot !== undefined && list.data !== undefined;

  return (
    <Dialog.Root open onOpenChange={(stillOpen) => !stillOpen && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          aria-describedby={undefined}
          data-recurring-modal
          className="fixed z-floating left-1/2 top-[max(1rem,6vh)] flex max-h-[min(46rem,calc(100dvh-2rem))] w-[min(46rem,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-shade/10 bg-surface p-5 shadow-lg max-sm:left-0 max-sm:top-0 max-sm:h-full max-sm:max-h-none max-sm:w-full max-sm:translate-x-0 max-sm:rounded-none max-sm:border-0 max-sm:pt-[max(1.25rem,env(safe-area-inset-top))]"
        >
          {!ready ? (
            <>
              <Dialog.Title className="text-lg font-semibold text-ink">Recurring items</Dialog.Title>
              {offline || list.fetchStatus === 'paused' ? (
                <p className="mt-3 text-sm text-ink-soft">Recurring items needs a connection. Go online to see and change them.</p>
              ) : list.isError ? (
                <p role="alert" className="mt-3 text-sm text-over-ink">
                  Recurring items could not be read.{' '}
                  <button type="button" onClick={() => void list.refetch()} className="underline">
                    Try again
                  </button>
                </p>
              ) : (
                <p className="mt-3 text-ink-faint">Loading…</p>
              )}
              <div className="flex shrink-0 justify-end pt-4">
                <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
                  Close
                </Dialog.Close>
              </div>
            </>
          ) : view.kind === 'form' ? (
            // Keyed so each recurring item (or a new one) starts its boxes afresh.
            <RecurringFormBody
              key={view.item.id}
              workspaceId={workspaceId}
              snapshot={snapshot}
              item={view.item}
              isNew={view.isNew}
              refusal={view.refusal}
              onBack={toList}
              onSave={(item) => save(item, view.isNew)}
              onDelete={remove}
            />
          ) : (
            <>
              <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
                <Dialog.Title className="text-lg font-semibold text-ink">
                  Recurring items <span className="text-sm font-normal text-ink-faint">{rows.length}</span>
                </Dialog.Title>
                <button
                  type="button"
                  onClick={() => setView({ kind: 'form', isNew: true, item: aNewOne(workspaceId), refusal: null })}
                  className="milled shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
                >
                  + New recurring item
                </button>
              </div>

              {notice && (
                <p role="alert" className="mb-2 shrink-0 text-sm text-over-ink">
                  {notice}
                </p>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto">
                {rows.length === 0 ? (
                  <p className="py-4 text-sm text-ink-faint">
                    Nothing recurs yet. A recurring item comes back on its day as a fresh copy: a weekly review, a monthly
                    invoice run, a quarterly VAT check. Press + New recurring item to make one.
                  </p>
                ) : (
                  <>
                    {/* A phone has no room for four columns: each recurring item is a card instead. */}
                    <ul className="flex flex-col sm:hidden">
                      {rows.map((one) => (
                        <li key={one.id} className="border-b border-shade/5 py-2 last:border-b-0">
                          <button
                            type="button"
                            onClick={() => setView({ kind: 'form', isNew: false, item: one, refusal: null })}
                            className="block w-full text-left"
                          >
                            <span className="block text-sm font-medium text-ink">{one.title}</span>
                            <span className="block text-xs text-ink-soft">
                              {ruleLabel(one)} · next {nextOnLabel(one.nextOn)}
                            </span>
                            <span className="block text-xs text-ink-faint">Files on {filesOn(snapshot, one)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="overflow-x-auto max-sm:hidden">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-shade/10 text-xs uppercase tracking-wide text-ink-faint">
                            {['Title', 'Repeats', 'Next on', 'Files on'].map((label) => (
                              <th key={label} scope="col" className="px-2 py-1.5 font-semibold">
                                {label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((one) => (
                            <tr
                              key={one.id}
                              data-master-id={one.id}
                              onClick={() => setView({ kind: 'form', isNew: false, item: one, refusal: null })}
                              className="cursor-pointer border-b border-shade/5 align-top last:border-b-0 hover:bg-accent-tint"
                            >
                              <td className="max-w-[14rem] px-2 py-1.5">
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setView({ kind: 'form', isNew: false, item: one, refusal: null });
                                  }}
                                  className="max-w-full truncate text-left focus-visible:outline-2 focus-visible:outline-accent"
                                >
                                  {one.title}
                                </button>
                              </td>
                              <td className="max-w-[12rem] px-2 py-1.5">{ruleLabel(one)}</td>
                              <td className="whitespace-nowrap px-2 py-1.5">{nextOnLabel(one.nextOn)}</td>
                              <td className="max-w-[13rem] px-2 py-1.5">{filesOn(snapshot, one)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>

              <div className="flex shrink-0 justify-end pt-4">
                <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
                  Close
                </Dialog.Close>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
