import { useState } from 'react';
import { itemLabel, itemStatus, type Item } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { useOpenItem } from '../itemForm';
import { groupsKey, usePoc, type Group } from './store';

/** POC (throwaway): a status mark the way a row's reads - a ring, a half, a tick. */
export function StatusMark({ status }: { status: 'to_do' | 'in_progress' | 'waiting' | 'done' }) {
  if (status === 'done')
    return (
      <span aria-label="Done" className="flex size-4 shrink-0 items-center justify-center rounded-full bg-cat-green text-[10px] text-white">
        ✓
      </span>
    );
  if (status === 'in_progress' || status === 'waiting')
    return (
      <span
        aria-label={status === 'waiting' ? 'Waiting' : 'In progress'}
        className="size-4 shrink-0 rounded-full border-2 border-accent"
        style={{ background: 'linear-gradient(90deg, var(--color-accent) 50%, transparent 50%)' }}
      />
    );
  return <span aria-label="To do" className="size-4 shrink-0 rounded-full border-2 border-shade/30" />;
}

interface Child {
  key: string;
  title: string;
  done: boolean;
  status: 'to_do' | 'in_progress' | 'waiting' | 'done';
  open?: () => void;
}

function GroupRow({
  title,
  children,
  note,
  onOpen,
}: {
  title: string;
  children: Child[];
  note?: string;
  onOpen?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(true);
  const done = children.filter((child) => child.done).length;
  return (
    <li className="border-b border-shade/10" data-poc-group={title}>
      <div className="flex items-center gap-2 px-3 py-2 hover:bg-row-hover">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? `Fold ${title}` : `Unfold ${title}`}
          onClick={() => setOpen(!open)}
          className="w-4 shrink-0 text-xs text-ink-faint"
        >
          {open ? '▾' : '▸'}
        </button>
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-sm font-medium text-ink-strong">
          {title}
        </button>
        <span className="shrink-0 text-xs text-ink-faint">
          {children.length > 0 ? `${done} of ${children.length} done` : note}
        </span>
      </div>
      {open && children.length > 0 && (
        <ul className="pb-1">
          {children.map((child) => (
            <li key={child.key}>
              <button
                type="button"
                onClick={child.open}
                className="flex w-full items-center gap-2 py-1.5 pr-3 pl-10 text-left text-sm hover:bg-row-hover"
              >
                <StatusMark status={child.status} />
                <span className={`truncate ${child.done ? 'text-ink-faint line-through' : 'text-ink'}`}>{child.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && children.length > 0 && <p className="px-10 pb-2 text-xs text-ink-faint">{note}</p>}
    </li>
  );
}

/** The local results of Combine and Split, at the top of the Panel they belong to. */
export function PocGroups({ workspaceId, panelId }: { workspaceId: string; panelId: string }) {
  const { data } = useSnapshot(workspaceId);
  const [groups] = usePoc<Group[]>(groupsKey(workspaceId), []);
  const openItem = useOpenItem();
  if (!data) return null;
  const byId = new Map(data.items.map((item) => [item.id, item]));
  const asChild = (item: Item): Child => ({
    key: item.id,
    title: itemLabel(item),
    done: itemStatus(item) === 'done',
    status: itemStatus(item),
    open: () => openItem(item.id),
  });
  const filedHere = (itemId: string) => data.filings.some((filing) => filing.itemId === itemId && filing.panelId === panelId);

  const shown = groups.filter((group) =>
    group.kind === 'split' ? filedHere(group.parentItemId) : group.panelId === panelId,
  );
  if (shown.length === 0) return null;
  return (
    <ul className="border-b border-accent/20 bg-accent-tint/30" aria-label="Combined and split (POC)">
      {shown.map((group) => {
        if (group.kind === 'parent') {
          const parent = group.parentItemId ? byId.get(group.parentItemId) : undefined;
          return (
            <GroupRow
              key={group.id}
              title={group.title}
              onOpen={parent ? () => openItem(parent.id) : undefined}
              children={group.childIds.flatMap((id) => {
                const item = byId.get(id);
                return item ? [asChild(item)] : [];
              })}
            />
          );
        }
        if (group.kind === 'merged') {
          return <GroupRow key={group.id} title={group.title} note={`New · merged from ${group.mergedIds.length}`} children={[]} />;
        }
        const parent = byId.get(group.parentItemId);
        if (!parent) return null;
        return (
          <GroupRow
            key={group.id}
            title={itemLabel(parent)}
            onOpen={() => openItem(parent.id)}
            children={group.children.map((child) => ({
              key: child.id,
              title: child.title,
              done: child.done,
              status: child.done ? 'done' : 'to_do',
            }))}
          />
        );
      })}
    </ul>
  );
}
