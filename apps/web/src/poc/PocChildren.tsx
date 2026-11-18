import { useState } from 'react';
import { itemLabel, itemStatus } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { useOpenItem } from '../itemForm';
import { childrenOf } from './relations';
import { relationsKey, usePoc, type Relations } from './store';
import { StatusMark } from './StatusMark';

/** POC (throwaway): "▸ 3 Items · 2 of 3 done" on the row of an Item with children, unfolding to them. */
export function PocChildren({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const [relations] = usePoc<Relations>(relationsKey(workspaceId), {});
  const { data } = useSnapshot(workspaceId);
  const openItem = useOpenItem();
  const [open, setOpen] = useState(false);
  const ids = childrenOf(relations, itemId);
  if (ids.length === 0 || !data) return null;
  const byId = new Map(data.items.map((item) => [item.id, item]));
  const children = ids.flatMap((id) => byId.get(id) ?? []);
  const done = children.filter((child) => itemStatus(child) === 'done').length;
  return (
    <span className="block">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="text-xs text-accent-deep hover:underline"
        data-poc-children={itemId}
      >
        {open ? '▾' : '▸'} {ids.length} {ids.length === 1 ? 'Item' : 'Items'} · {done} of {ids.length} done
      </button>
      {open && (
        <span className="mt-1 flex flex-col">
          {children.map((child) => (
            <button
              key={child.id}
              type="button"
              onClick={() => openItem(child.id)}
              className="flex items-center gap-2 rounded py-0.5 pl-3 text-left text-[13px] hover:bg-row-hover"
            >
              <StatusMark status={itemStatus(child)} />
              <span className={`truncate ${itemStatus(child) === 'done' ? 'text-ink-faint line-through' : 'text-ink'}`}>{itemLabel(child)}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
