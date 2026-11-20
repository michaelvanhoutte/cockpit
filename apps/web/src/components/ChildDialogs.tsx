import type { Item } from '@cockpit/shared';
import { useSendCommand } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { useUndo } from '../undo';
import AddAsChildOf, { addAsChildren } from './AddAsChildOf';
import { Suspense, lazy } from 'react';
import CombineDialog from './CombineDialog';

/** Its own chunk, fetched only once *Split…* is asked: the window holds drag and drop and the proposal's request. */
const SplitDialog = lazy(() => import('./SplitDialog'));

/** What a row's menu or a selection's bar asked: Items to put inside one you pick, Items to combine, or an Item to split. */
export type ChildAsk =
  | { chosen: readonly Item[]; from?: HTMLElement | null | undefined }
  | { ids: readonly string[]; from?: HTMLElement | null | undefined }
  | { splitId: string; from?: HTMLElement | null | undefined };

/**
 * *Add as child of…* ("Brainstorming: an Item can't hold other Items", issue
 * 1825), *Combine…* (issue 1826) and *Split…* (issue 1828), in one chunk fetched
 * when any is first asked, Split's own window a chunk of its own beyond it: the window, what it sends and the Undo it offers, none of it in the
 * initial bundle. `onDone` is called once the change is on its way, for the
 * selection to end.
 */
export default function ChildDialogs({
  workspaceId,
  asking,
  onClose,
  onDone,
}: {
  workspaceId: string;
  asking: ChildAsk;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data } = useSnapshot(workspaceId);
  const send = useSendCommand();
  const offerToUndo = useUndo();
  if ('splitId' in asking) {
    return (
      <Suspense fallback={null}>
        <SplitDialog workspaceId={workspaceId} itemId={asking.splitId} returnFocusTo={asking.from} onClose={onClose} />
      </Suspense>
    );
  }
  if (!data) return null;
  if ('ids' in asking) {
    return <CombineDialog workspaceId={workspaceId} itemIds={asking.ids} onClose={onClose} onCombined={onDone} returnFocusTo={asking.from} />;
  }
  return (
    <AddAsChildOf
      chosen={asking.chosen}
      items={data.items}
      children={data.children ?? []}
      onAdd={(parent) => {
        onDone();
        addAsChildren({ workspaceId, send, offerToUndo, children: data.children ?? [] }, asking.chosen, parent);
      }}
      onClose={onClose}
      returnFocusTo={asking.from}
    />
  );
}
