import type { Item } from '@cockpit/shared';
import { useSendCommand } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { useUndo } from '../undo';
import AddAsChildOf, { addAsChildren } from './AddAsChildOf';
import CombineDialog from './CombineDialog';

/** What a row's menu or a selection's bar asked: Items to put inside one you pick, or Items to combine. */
export type ChildAsk =
  | { chosen: readonly Item[]; from?: HTMLElement | null | undefined }
  | { ids: readonly string[]; from?: HTMLElement | null | undefined };

/**
 * *Add as child of…* ("Brainstorming: an Item can't hold other Items", issue
 * 1825) and *Combine…* (issue 1826), in one chunk fetched when either is first
 * asked: the window, what it sends and the Undo it offers, none of it in the
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
