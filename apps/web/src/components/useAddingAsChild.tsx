import { Suspense, lazy, useState } from 'react';
import { CHILDREN_ADDED_AT_ONCE, itemLabel, uuidv7, workspaceIsDecided, type Item } from '@cockpit/shared';
import { useSendCommand } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { useUndo } from '../undo';

/** Fetched only once *Add as child of…* is asked, as the other windows opened from a row are. */
const AddAsChildOf = lazy(() => import('./AddAsChildOf'));

/**
 * *Add as child of…* from a row's menu or a selection's bar ("Brainstorming: an
 * Item can't hold other Items", issue 1825): asks which Item, puts the chosen
 * ones inside it, and offers Undo, which takes out the ones it put in. One
 * already inside that parent stays, and Undo leaves it there.
 */
export function useAddingAsChild(workspaceId: string, afterAdding?: () => void) {
  const { data } = useSnapshot(workspaceId);
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const [asking, setAsking] = useState<readonly Item[] | null>(null);
  /** The menu button it was asked from, which the focus goes back to. */
  const [askedFrom, setAskedFrom] = useState<HTMLElement | null>(null);

  const add = (chosen: readonly Item[], parent: Item) => {
    const already = new Set((data?.children ?? []).filter((row) => row.parentId === parent.id).map((row) => row.childId));
    const arriving = chosen.filter((item) => !already.has(item.id));
    setAsking(null);
    afterAdding?.();
    if (arriving.length === 0) return;
    const envelope = () => ({ commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId });
    // As many changes as a change takes Items, for a selection bigger than that.
    const batches: Item[][] = [];
    for (let at = 0; at < arriving.length; at += CHILDREN_ADDED_AT_ONCE) {
      batches.push(arriving.slice(at, at + CHILDREN_ADDED_AT_ONCE));
    }
    const answer = Promise.all(
      batches.map((batch) =>
        send({ name: 'add_children', payload: { ...envelope(), parentId: parent.id, childIds: batch.map((item) => item.id) } }),
      ),
    );
    // **No way back once one belonged to no Workspace**: going inside settles it
    // in this one, and taking it out leaves it in this Inbox alone, not in every
    // Workspace's, as a move withholds its Undo for the same reason.
    const decides = arriving.some((item) => !workspaceIsDecided(item));
    offerToUndo({
      what:
        arriving.length === 1
          ? `“${itemLabel(arriving[0]!)}” added to ${itemLabel(parent)}`
          : `${arriving.length} Items added to ${itemLabel(parent)}`,
      unlessRefused: answer,
      ...(decides
        ? {}
        : {
            undo: () =>
              Promise.all(
                arriving.map((item) =>
                  send({ name: 'remove_child', payload: { ...envelope(), parentId: parent.id, childId: item.id } }),
                ),
              ),
          }),
    });
  };

  const dialog = asking && data && (
    <Suspense fallback={null}>
      <AddAsChildOf
        chosen={asking}
        items={data.items}
        children={data.children ?? []}
        onAdd={(parent) => add(asking, parent)}
        onClose={() => setAsking(null)}
        returnFocusTo={askedFrom}
      />
    </Suspense>
  );

  return {
    ask: (chosen: readonly Item[], from: HTMLElement | null = null) => {
      setAskedFrom(from);
      setAsking(chosen);
    },
    dialog,
  };
}
