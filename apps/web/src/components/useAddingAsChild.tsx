import { Suspense, lazy, useState } from 'react';
import { itemLabel, uuidv7, type Item } from '@cockpit/shared';
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

  const add = (chosen: readonly Item[], parent: Item) => {
    const already = new Set((data?.children ?? []).filter((row) => row.parentId === parent.id).map((row) => row.childId));
    const arriving = chosen.filter((item) => !already.has(item.id));
    setAsking(null);
    afterAdding?.();
    if (arriving.length === 0) return;
    const envelope = () => ({ commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId });
    const answer = send({
      name: 'add_children',
      payload: { ...envelope(), parentId: parent.id, childIds: arriving.map((item) => item.id) },
    });
    offerToUndo({
      what:
        arriving.length === 1
          ? `“${itemLabel(arriving[0]!)}” added to ${itemLabel(parent)}`
          : `${arriving.length} Items added to ${itemLabel(parent)}`,
      unlessRefused: answer,
      undo: () =>
        Promise.all(
          arriving.map((item) =>
            send({ name: 'remove_child', payload: { ...envelope(), parentId: parent.id, childId: item.id } }),
          ),
        ),
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
      />
    </Suspense>
  );

  return { ask: (chosen: readonly Item[]) => setAsking(chosen), dialog };
}
