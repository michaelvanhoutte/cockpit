import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { snapshotQuery } from '../api/queries';
import {
  ALL_ITEMS_COLUMNS,
  ALL_ITEMS_PAGE,
  DEFAULT_SORT,
  STATUS_LABELS,
  allItemsRows,
  pressHeader,
  type AllItemsSort,
} from '../allItems';
import { allItemsFilterId } from '../allItemsTab';
import {
  isFiltering,
  itemIdsWithAttachments,
  itemIdsWithRun,
  matchesDashboardFilter,
  useDashboardFilter,
} from '../dashboardFilter';
import { dayOf } from '../filters';
import { useOpenItem } from '../itemForm';
import { browserStore } from '../lastVisited';
import { PRIORITY_LABELS } from '../priority';
import { DashboardFilterBar } from './DashboardFilterBar';
import { LoadFailure } from './LoadFailure';

/**
 * Every item of the workspace in one table, finished ones included ("Put each
 * setting where a person looks for it", issue 688). Read from the snapshot the
 * workspace already holds, so it works offline and asks the server for nothing.
 *
 * A row opens the item's form, whose Status control reopens a finished item. A
 * header sorts by its column; pressing it again reverses.
 *
 * **Sorted and filtered over every row, then drawn 50 at a time** with the
 * total said, so a filtered view never reads as the whole.
 */
export default function AllItemsBoard({ workspaceId }: { workspaceId: string }) {
  const { data, error, refetch } = useQuery(snapshotQuery(workspaceId));
  const openItem = useOpenItem();
  const [sort, setSort] = useState<AllItemsSort>(DEFAULT_SORT);
  const [filter] = useDashboardFilter(browserStore(), allItemsFilterId(workspaceId));
  // How many rows are drawn, and what they were drawn for: a different sort or
  // filter starts again from the first page.
  const [paging, setPaging] = useState({ of: '', shown: ALL_ITEMS_PAGE });

  if (error && !data) return <LoadFailure error={error} onRetry={() => void refetch()} />;
  if (!data) return <p className="text-ink-faint">Loading…</p>;

  const filtering = isFiltering(filter);
  const withAttachments = itemIdsWithAttachments(data.attachments ?? []);
  const withRun = itemIdsWithRun(data.agentRuns ?? []);
  const today = dayOf(new Date());
  const rows = allItemsRows(
    {
      ...data,
      items: filtering
        ? data.items.filter((item) => matchesDashboardFilter(filter, item, withAttachments, today, withRun))
        : data.items,
    },
    sort,
  );
  const viewKey = JSON.stringify([sort, filter]);
  const shown = paging.of === viewKey ? paging.shown : ALL_ITEMS_PAGE;
  const drawn = rows.slice(0, shown);

  return (
    <div className="flex min-w-0 flex-col">
      <DashboardFilterBar dashboardId={allItemsFilterId(workspaceId)} withDone />
      <section className="min-w-0 rounded-md border border-shade/10 bg-surface p-3" aria-label="All items">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent-deep">
          All items{' '}
          <span className="text-ink-faint">
            {filtering ? `${rows.length} of ${data.items.length}` : rows.length}
          </span>
        </h2>
        {data.items.length === 0 ? (
          <p className="text-sm text-ink-faint">There are no items yet.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-ink-faint">No item matches the filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-shade/10 text-xs uppercase tracking-wide text-ink-faint">
                  {ALL_ITEMS_COLUMNS.map(({ key, label }) => (
                    <th
                      key={key}
                      scope="col"
                      aria-sort={sort.key === key ? (sort.down ? 'descending' : 'ascending') : 'none'}
                      className="px-2 py-1.5 font-semibold"
                    >
                      <button
                        type="button"
                        onClick={() => setSort(pressHeader(sort, key))}
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
                {drawn.map((row) => (
                  <tr
                    key={row.item.id}
                    onClick={() => openItem(row.item.id)}
                    className={`cursor-pointer border-b border-shade/5 last:border-b-0 hover:bg-accent-tint ${
                      row.status === 'done' ? 'text-ink-faint' : ''
                    }`}
                  >
                    <td className="max-w-[18rem] truncate px-2 py-1.5">
                      {/* The row's press reaches a mouse; this is the way in for a keyboard. */}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openItem(row.item.id);
                        }}
                        className="max-w-full truncate text-left focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        {row.title}
                      </button>
                    </td>
                    <td className="px-2 py-1.5">{row.type}</td>
                    <td className="px-2 py-1.5">{STATUS_LABELS[row.status]}</td>
                    <td className="px-2 py-1.5">{row.priority ? PRIORITY_LABELS[row.priority] : ''}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">{row.due ?? ''}</td>
                    <td className="max-w-[14rem] truncate px-2 py-1.5">{row.where}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {new Date(row.changedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > shown && (
          <button
            type="button"
            onClick={() => setPaging({ of: viewKey, shown: shown + ALL_ITEMS_PAGE })}
            className="mt-2 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
          >
            Show more
          </button>
        )}
      </section>
    </div>
  );
}
