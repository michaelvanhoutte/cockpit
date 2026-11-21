import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, useState } from 'react';
import {
  descendantIdsOf,
  itemLabel,
  stillOpen,
  uuidv7,
  workspaceIsDecided,
  type ChildRow,
  type Item,
  type WorkspaceSnapshot,
} from '@cockpit/shared';
import type { CommandArgs } from '../api/queries';
import { fetchedChunk } from '../filing';
import { leavesOfAPick, planPuttingInside, wasBeforeLeaving, type PickedIn } from '../nesting';
import type { Undoable } from '../undo';
import { unfoldAll, unfoldedNow } from '../unfoldedParents';
// What these send is drawn ahead by it (`ChildrenDrawn`, drawnAhead.ts).
import '../childrenDrawnAhead';

/** The most Items the picker lists at once; typing narrows it. */
const LISTED = 8;

/**
 * *Add as child of…* ("Brainstorming: an Item can't hold other Items", issue
 * 1825): which Item the chosen ones go inside, picked from the Workspace's
 * open Items by name. The POC's *Combine under an existing parent* picker, as
 * a step of its own: an Item already holding one of them, however deep, is not
 * offered, since an Item never sits inside itself.
 */
export default function AddAsChildOf({
  chosen,
  items,
  children,
  onAdd,
  onClose,
  returnFocusTo,
}: {
  /** Where the focus goes back to once it closes: the row's menu button, when it was opened from one. */
  returnFocusTo?: HTMLElement | null | undefined;
  /** The Items going inside, never none. */
  chosen: readonly Item[];
  /** The Workspace's Items, from its snapshot. */
  items: readonly Item[];
  /** Which of them hold which, from the same snapshot. */
  children: readonly ChildRow[];
  onAdd: (parent: Item) => void;
  onClose: () => void;
}) {
  const [picked, setParent] = useState<Item | null>(null);
  // Only while it is still open in the Workspace: one dismissed or finished meanwhile is no longer picked.
  const parent = picked && items.some((item) => item.id === picked.id && stillOpen(item)) ? picked : null;
  const title = chosen.length === 1 ? `Add “${itemLabel(chosen[0]!)}” as child of…` : `Add ${chosen.length} Items as children of…`;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed left-1/2 top-1/2 z-floating flex max-h-[90vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-shade/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="truncate text-base font-semibold">{title}</Dialog.Title>
          <p className="text-sm text-ink-soft">They move out of where they are. An Item you pick holds them.</p>
          <ParentPicker chosen={chosen} items={items} children={children} onPick={setParent} autoFocus />
          <div className="flex justify-end gap-2">
            <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              onClick={() => parent && onAdd(parent)}
              disabled={parent === null}
              className="milled shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The existing-parent picker, which *Add as child of…* and *Combine under an
 * existing parent* (issue 1826) share: a search box over the Workspace's open
 * Items, and the one picked, reported through `onPick`.
 */
export function ParentPicker({
  chosen,
  items,
  children,
  onPick,
  autoFocus = false,
}: {
  chosen: readonly Item[];
  items: readonly Item[];
  children: readonly ChildRow[];
  onPick: (parent: Item | null) => void;
  autoFocus?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const chosenIds = useMemo(() => new Set(chosen.map((item) => item.id)), [chosen]);
  /** Every Item below one of the chosen ones: putting one of them inside it would be a loop. */
  const below = useMemo(() => {
    const found = new Set<string>();
    for (const item of chosen) for (const id of descendantIdsOf(children, item.id)) found.add(id);
    return found;
  }, [chosen, children]);
  const candidates = useMemo(() => {
    const words = search.trim().toLowerCase();
    return items
      .filter(stillOpen)
      // One waiting in every Inbox belongs to no Workspace yet, so it can hold nothing here.
      .filter(workspaceIsDecided)
      .filter((item) => !chosenIds.has(item.id) && !below.has(item.id))
      .filter((item) => !words || itemLabel(item).toLowerCase().includes(words))
      .slice(0, LISTED);
  }, [items, chosenIds, below, search]);

  return (
    <div className="flex flex-col gap-1">
      <input
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          // What was picked may no longer be listed, so nothing stays picked unseen.
          setParentId(null);
          onPick(null);
        }}
        placeholder="Find an Item…"
        aria-label="Find the parent Item"
        autoFocus={autoFocus}
        className="w-full rounded-md border border-shade/10 bg-field px-3 py-1.5 text-sm outline-none focus:border-accent"
      />
      <ul aria-label="Items to add them to" className="flex max-h-40 flex-col overflow-y-auto rounded-md border border-shade/10 bg-field">
        {candidates.length === 0 && <li className="px-3 py-1.5 text-sm text-ink-faint">No Item matches.</li>}
        {candidates.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={parentId === item.id}
              onClick={() => {
                setParentId(item.id);
                onPick(item);
              }}
              className={`w-full truncate px-3 py-1.5 text-left text-sm hover:bg-accent-tint ${
                parentId === item.id ? 'bg-accent-tint font-medium text-accent-deep' : 'text-ink'
              }`}
            >
              {itemLabel(item)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Puts the chosen Items inside the parent picked, **moving them** ("Panels: Items put inside a parent stay where
 * they were", issue 1876): the change a drop onto a row sends, with the leaves worked out here from where they were
 * picked, and its Undo, which files them back where they were. One already inside that parent with nothing to leave
 * stays, and Undo leaves it there. Here rather than in `useAddingAsChild`, so none of it is in the initial bundle.
 */
export function addAsChildren(
  d: {
    workspaceId: string;
    send: (change: CommandArgs) => Promise<unknown>;
    latest: (workspaceId: string) => Promise<WorkspaceSnapshot>;
    offerToUndo: (change: Undoable) => void;
    data: Pick<WorkspaceSnapshot, 'children' | 'filings' | 'panels'>;
    where: PickedIn;
  },
  chosen: readonly Item[],
  parent: Item,
): void {
  const rows = d.data.children ?? [];
  const carried = chosen.map((item) => item.id);
  const leaves = leavesOfAPick({ carried, target: parent.id, rows, filings: d.data.filings, panels: d.data.panels, where: d.where, unfolded: unfoldedNow() });
  const batches = planPuttingInside({ carried, target: parent.id, rows, leaves });
  if (batches.length === 0) return;
  const arriving = chosen.filter((item) => batches.some((batch) => batch.childIds.includes(item.id)));
  const sent = batches.map((batch) =>
    d.send({
      name: 'put_inside',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId: d.workspaceId,
        parentId: parent.id,
        childIds: batch.childIds,
        order: batch.order,
        leaves: batch.leaves,
      },
    }),
  );
  const answer = Promise.all(sent);
  unfoldAll([parent.id]);
  // **No way back once one belonged to no Workspace**: going inside settles it
  // in this one, and taking it out leaves it in this Inbox alone, not in every
  // Workspace's, as a move withholds its Undo for the same reason.
  const decides = arriving.some((item) => !workspaceIsDecided(item));
  if (!decides) void import('../puttingBack').catch(() => {});
  const was = batches.map((batch) =>
    wasBeforeLeaving({ target: parent.id, arrived: batch.arrived, leaves: batch.leaves, rows, filings: d.data.filings }),
  );
  d.offerToUndo({
    what:
      arriving.length === 1
        ? `“${itemLabel(arriving[0]!)}” added to ${itemLabel(parent)}`
        : `${arriving.length} Items added to ${itemLabel(parent)}`,
    unlessRefused: answer,
    ...(decides
      ? {}
      : {
          undo: async () => {
            const { putBackFromARowDrop } = await fetchedChunk(() => import('../puttingBack'));
            for (const one of was) await putBackFromARowDrop({ workspaceId: d.workspaceId, send: d.send, latest: d.latest }, one);
          },
        }),
  });
}
