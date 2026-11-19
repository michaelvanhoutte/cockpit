import { useMemo } from 'react';
import { childrenOf, itemLabel, uuidv7, type Item } from '@cockpit/shared';
import { useSendCommand } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { useUndo } from '../undo';
import { useUnfolded } from '../unfoldedParents';
import { ItemList } from './ItemList';

/**
 * A parent's children as full rows of their own, indented under its row
 * while it is unfolded ("Brainstorming: an Item can't hold other Items", issue
 * 1825): the POC's child rows, each with its status, menu and drag. Only the
 * open ones the Workspace's read holds; the parent's row counts the rest.
 */
export default function HeldRows({
  workspaceId,
  parent,
  panelId,
  openDashboardId,
  hidden,
}: {
  workspaceId: string;
  parent: Item;
  panelId: string | null;
  openDashboardId: string | null;
  /** That the list it is under is off screen, a collapsed Panel's, so these rows are too. */
  hidden: boolean;
}) {
  const { unfolded } = useUnfolded(parent.id);
  const { data } = useSnapshot(workspaceId);
  const held = useMemo(
    () => childrenOf(data?.children ?? [], data?.items ?? [], parent.id),
    [data?.children, data?.items, parent.id],
  );
  const send = useSendCommand();
  const offerToUndo = useUndo();
  /** Takes a child out of this parent, and this one alone, with Undo putting it back in. */
  const takeOut = (item: Item) => {
    const envelope = () => ({ commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId });
    const answer = send({ name: 'remove_child', payload: { ...envelope(), parentId: parent.id, childId: item.id } });
    offerToUndo({
      what: `“${itemLabel(item)}” taken out of ${itemLabel(parent)}`,
      unlessRefused: answer,
      undo: () => send({ name: 'add_children', payload: { ...envelope(), parentId: parent.id, childIds: [item.id] } }),
    });
  };
  if (!unfolded || held.length === 0) return null;
  return (
    // The whole width in columns, under the parent's line, rather than a cell of its own.
    <li className="col-span-full border-l-2 border-accent/25 pl-5" data-child-rows={parent.id}>
      <ItemList
        workspaceId={workspaceId}
        items={held}
        openDashboardId={openDashboardId}
        panelId={panelId}
        gathered
        heldBy={parent}
        onTakeOut={takeOut}
        hidden={hidden}
        emptyMessage=""
      />
    </li>
  );
}
