import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, useState } from 'react';
import { descendantIdsOf, itemLabel, stillOpen, type ChildRow, type Item } from '@cockpit/shared';

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
}: {
  /** The Items going inside, never none. */
  chosen: readonly Item[];
  /** The Workspace's Items, from its snapshot. */
  items: readonly Item[];
  /** Which of them hold which, from the same snapshot. */
  children: readonly ChildRow[];
  onAdd: (parent: Item) => void;
  onClose: () => void;
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
      .filter((item) => !chosenIds.has(item.id) && !below.has(item.id))
      .filter((item) => !words || itemLabel(item).toLowerCase().includes(words))
      .slice(0, LISTED);
  }, [items, chosenIds, below, search]);
  const parent = candidates.find((item) => item.id === parentId) ?? null;
  const title = chosen.length === 1 ? `Add “${itemLabel(chosen[0]!)}” as child of…` : `Add ${chosen.length} Items as children of…`;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-floating flex max-h-[90vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-shade/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="truncate text-base font-semibold">{title}</Dialog.Title>
          <p className="text-sm text-ink-soft">They stay where they are. An Item you pick holds them.</p>
          <div className="flex flex-col gap-1">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find an Item…"
              aria-label="Find the parent Item"
              autoFocus
              className="w-full rounded-md border border-shade/10 bg-field px-3 py-1.5 text-sm outline-none focus:border-accent"
            />
            <ul aria-label="Items to add them to" className="flex max-h-40 flex-col overflow-y-auto rounded-md border border-shade/10 bg-field">
              {candidates.length === 0 && <li className="px-3 py-1.5 text-sm text-ink-faint">No Item matches.</li>}
              {candidates.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-pressed={parentId === item.id}
                    onClick={() => setParentId(item.id)}
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
