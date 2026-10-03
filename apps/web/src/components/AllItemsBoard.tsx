import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { UNTITLED, itemStatus, type Item, type ItemStatus } from '@cockpit/shared';
import { snapshotQuery } from '../api/queries';
import {
  isFiltering,
  itemIdsWithAttachments,
  itemIdsWithRun,
  matchesDashboardFilter,
  useDashboardFilter,
} from '../dashboardFilter';
import { doneFilterId } from '../doneTab';
import { dayOf } from '../filters';
import { useOpenItem } from '../itemForm';
import { browserStore } from '../lastVisited';
import { placesFiledOn } from '../markedDone';
import { PRIORITY_LABELS } from '../priority';
import { DashboardFilterBar } from './DashboardFilterBar';

/** POC: every item of the workspace in one table, finished ones included. */
const STATUS_LABELS: Record<ItemStatus, string> = {
  to_do: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

type Key = 'title' | 'type' | 'status' | 'priority' | 'due' | 'where' | 'changed';
const COLUMNS: { key: Key; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'due', label: 'Due' },
  { key: 'where', label: 'Where it is' },
  { key: 'changed', label: 'Last changed' },
];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;

/** When a row last changed: the finish for a done item, otherwise its last edit. */
const changedAt = (item: Item) => item.completedAt ?? item.updatedAt;

export function AllItemsBoard({ workspaceId }: { workspaceId: string }) {
  const { data } = useQuery(snapshotQuery(workspaceId));
  const openItem = useOpenItem();
  const [filter] = useDashboardFilter(browserStore(), doneFilterId(workspaceId));
  const [sort, setSort] = useState<{ key: Key; down: boolean }>({ key: 'changed', down: true });
  if (!data) return <p className="text-ink-faint">Loading…</p>;

  const now = new Date();
  const withAttachments = itemIdsWithAttachments(data.attachments ?? []);
  const withRun = itemIdsWithRun(data.agentRuns ?? []);
  const typeName = (item: Item) => (data.itemTypes ?? []).find((t) => t.id === item.typeId)?.name ?? '';
  const where = (item: Item) => {
    const places = placesFiledOn(item, data.filings ?? [], data.panels ?? [], data.dashboards ?? []);
    return places.length > 0 ? places.join(', ') : 'Inbox';
  };
  const value = (item: Item, key: Key): string | number => {
    switch (key) {
      case 'title': return item.title.trim().toLowerCase();
      case 'type': return typeName(item).toLowerCase();
      case 'status': return ['to_do', 'in_progress', 'done'].indexOf(itemStatus(item));
      case 'priority': return item.priority ? PRIORITY_RANK[item.priority] : 3;
      case 'due': return item.dueDate ?? '9999';
      case 'where': return where(item).toLowerCase();
      case 'changed': return Date.parse(changedAt(item));
    }
  };

  const filtered = isFiltering(filter)
    ? data.items.filter((item) => matchesDashboardFilter(filter, item, withAttachments, dayOf(now), withRun))
    : data.items;
  const rows = [...filtered].sort((a, b) => {
    const [x, y] = [value(a, sort.key), value(b, sort.key)];
    const order = x < y ? -1 : x > y ? 1 : 0;
    return sort.down ? -order : order;
  });

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div>
        <DashboardFilterBar dashboardId={doneFilterId(workspaceId)} withDone />
        <section className="rounded-md border border-black/10 bg-surface p-3" aria-label="All items">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent-deep">
            All items <span className="text-ink-faint">{rows.length}</span>
          </h2>
          {data.items.length === 0 ? (
            <p className="text-sm text-ink-faint">There are no items yet.</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-ink-faint">No item matches the filter.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-black/10 text-xs uppercase tracking-wide text-ink-faint">
                    {COLUMNS.map(({ key, label }) => (
                      <th
                        key={key}
                        scope="col"
                        aria-sort={sort.key === key ? (sort.down ? 'descending' : 'ascending') : 'none'}
                        className="px-2 py-1.5 font-semibold"
                      >
                        <button
                          type="button"
                          onClick={() => setSort({ key, down: sort.key === key ? !sort.down : key === 'changed' })}
                          className="uppercase tracking-wide hover:text-ink"
                        >
                          {label}
                          {sort.key === key ? (sort.down ? ' ▾' : ' ▴') : ''}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((item) => {
                    const status = itemStatus(item);
                    return (
                      <tr
                        key={item.id}
                        onClick={() => openItem(item.id)}
                        className="cursor-pointer border-b border-black/5 last:border-b-0 hover:bg-accent-tint"
                      >
                        <td className="max-w-[18rem] truncate px-2 py-1.5">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              openItem(item.id);
                            }}
                            className="max-w-full truncate text-left focus-visible:outline-2 focus-visible:outline-accent"
                          >
                            {item.title.trim() || UNTITLED}
                          </button>
                        </td>
                        <td className="px-2 py-1.5 text-accent-deep">{typeName(item)}</td>
                        <td className={`px-2 py-1.5 ${status === 'done' ? 'text-ink-faint' : ''}`}>
                          {STATUS_LABELS[status]}
                        </td>
                        <td className="px-2 py-1.5">{item.priority ? PRIORITY_LABELS[item.priority] : ''}</td>
                        <td className="whitespace-nowrap px-2 py-1.5">{item.dueDate ?? ''}</td>
                        <td className="max-w-[14rem] truncate px-2 py-1.5 text-ink-soft">{where(item)}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-ink-faint">
                          {new Date(changedAt(item)).toLocaleDateString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
