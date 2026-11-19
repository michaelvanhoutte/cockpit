import { lazy, Suspense } from 'react';
import { itemStatus, stillOpen } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { childrenOf } from './relations';
import { hiddenKey, relationsKey, UNFOLDED_KEY, usePoc, type Relations } from './store';

/** The children are drawn as real rows, by the list itself - loaded only once something is unfolded. */
const ItemList = lazy(() => import('../components/ItemList').then((loaded) => ({ default: loaded.ItemList })));

function useUnfolded() {
  return usePoc<string[]>(UNFOLDED_KEY, []);
}

/** POC (throwaway): "▸ 3 Items · 2 of 3 done" on the row of an Item with children. It only folds and unfolds. */
export function PocChildren({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const [relations] = usePoc<Relations>(relationsKey(workspaceId), {});
  const [unfolded, setUnfolded] = useUnfolded();
  const { data } = useSnapshot(workspaceId);
  const ids = childrenOf(relations, itemId);
  if (ids.length === 0 || !data) return null;
  const byId = new Map(data.items.map((item) => [item.id, item]));
  const done = ids.filter((id) => {
    const child = byId.get(id);
    return child && itemStatus(child) === 'done';
  }).length;
  const open = unfolded.includes(itemId);
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <span className="block">
      <button
        type="button"
        aria-expanded={open}
        onPointerDown={stop}
        onMouseDown={stop}
        onPointerUp={stop}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          setUnfolded((was) => (open ? was.filter((id) => id !== itemId) : [...was, itemId]));
        }}
        className="text-xs text-accent-deep hover:underline"
        data-poc-children={itemId}
      >
        {open ? '▾' : '▸'} {ids.length} {ids.length === 1 ? 'Item' : 'Items'} · {done} of {ids.length} done
      </button>
    </span>
  );
}

/** The unfolded children of one row, as full rows of their own, indented under it. */
export function PocChildRows({
  workspaceId,
  parentId,
  panelId,
  openDashboardId,
}: {
  workspaceId: string;
  parentId: string;
  panelId: string | null;
  openDashboardId: string | null;
}) {
  const [relations] = usePoc<Relations>(relationsKey(workspaceId), {});
  const [hidden] = usePoc<string[]>(hiddenKey(workspaceId), []);
  const [unfolded] = useUnfolded();
  const { data } = useSnapshot(workspaceId);
  if (!unfolded.includes(parentId) || !data) return null;
  const byId = new Map(data.items.map((item) => [item.id, item]));
  const children = childrenOf(relations, parentId).flatMap((id) => {
    const child = byId.get(id);
    return child && stillOpen(child) && !hidden.includes(id) ? [child] : [];
  });
  if (children.length === 0) return null;
  return (
    <li className="border-l-2 border-accent/25 pl-5" data-poc-child-rows={parentId}>
      <Suspense fallback={null}>
        <ItemList workspaceId={workspaceId} items={children} openDashboardId={openDashboardId} panelId={panelId} gathered emptyMessage="" />
      </Suspense>
    </li>
  );
}
