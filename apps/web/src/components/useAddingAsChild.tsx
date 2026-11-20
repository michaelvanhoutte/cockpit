import { Suspense, lazy, useState } from 'react';
import type { Item } from '@cockpit/shared';
import type { PickedIn } from '../nesting';
import type { ChildAsk } from './ChildDialogs';

/** Fetched only once *Add as child of…*, *Combine…* or *Split…* is asked, as the other windows opened from a row are. */
const ChildDialogs = lazy(() => import('./ChildDialogs'));

/**
 * *Add as child of…* from a row's menu or a selection's bar ("Brainstorming: an
 * Item can't hold other Items", issue 1825), and *Combine…* beside it (issue
 * 1826): asks which Item, or how, puts the chosen ones inside it or combines
 * them, and offers Undo (`ChildDialogs`). `afterAdding` ends the selection the
 * Items were picked in.
 */
export function useAddingAsChild(
  workspaceId: string,
  afterAdding?: () => void,
  /** The list the Items are picked in, for what each leaves when put inside a parent (issue 1876). */
  list: Omit<PickedIn, 'selection'> = { panelId: null, heldBy: null, dashboardId: null },
) {
  const [asking, setAsking] = useState<ChildAsk | null>(null);

  const dialog = asking && (
    <Suspense fallback={null}>
      <ChildDialogs
        workspaceId={workspaceId}
        asking={asking}
        onClose={() => setAsking(null)}
        onDone={() => {
          setAsking(null);
          afterAdding?.();
        }}
      />
    </Suspense>
  );

  return {
    /** *Split…* for this Item, from its row's menu or its form. */
    split: (itemId: string, from?: HTMLElement | null, onSplit?: () => void) => setAsking({ splitId: itemId, from, onSplit }),
    /** *Combine…* for these Items, never offered for fewer than two; `selection` for ones picked together. */
    combine: (ids: readonly string[], from?: HTMLElement | null, selection = false) =>
      setAsking({ ids, from, where: { ...list, selection } }),
    /** The menu button it was asked from, which the focus goes back to; `selection` for ones picked together. */
    ask: (chosen: readonly Item[], from?: HTMLElement | null, selection = false) =>
      setAsking({ chosen, from, where: { ...list, selection } }),
    dialog,
  };
}
