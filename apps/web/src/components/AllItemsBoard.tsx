import { useState } from 'react';
import { useSnapshotWithFinishedItems } from '../api/finishedItems';
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
import { momentDateLabel } from '../dateFormat';
import { dueDateLabel } from '../dueDate';
import { useDashboardFilter } from '../dashboardFilter';
import { useOpenItem } from '../itemForm';
import { browserStore } from '../lastVisited';
import { useIsOffline } from '../offline';
import { PRIORITY_LABELS } from '../priority';
import { DashboardFilterBar } from './DashboardFilterBar';
import { LoadFailure } from './LoadFailure';
import { isFiltering, itemIdsWithAttachments, itemIdsWithRun, matchesDashboardFilter, dayOf } from '@cockpit/shared';

/**
 * Every item of the workspace in one table, finished ones included ("Put each
 * setting where a person looks for it", issue 688). Drawn from the Workspace's
 * read merged with its finished Items, which the first opening in a tab fetches
 * and says so while they arrive ("Fetch a Workspace's finished Items the first
 * time All items opens", issue 1434).
 *
 * **It needs a connection until the finished Items have been fetched**: they
 * are not saved for offline use, so opened offline it says so rather than
 * drawing a table that leaves them out.
 *
 * A row opens the item's form, whose Status control reopens a finished item. A
 * header sorts by its column; pressing it again reverses.
 *
 * **Sorted and filtered over every row, then drawn 50 at a time** with the
 * total said, so a filtered view never reads as the whole.
 */
export default function AllItemsBoard({ workspaceId }: { workspaceId: string }) {
  const { data, workspace, finished, reading: arriving } = useSnapshotWithFinishedItems(workspaceId);
  const { error, refetch } = workspace;
  const offline = useIsOffline();
  const openItem = useOpenItem();
  const [sort, setSort] = useState<AllItemsSort>(DEFAULT_SORT);
  const [filter] = useDashboardFilter(browserStore(), allItemsFilterId(workspaceId));
  // How many rows are drawn, and what they were drawn for: a different sort or
  // filter starts again from the first page.
  const [paging, setPaging] = useState({ of: '', shown: ALL_ITEMS_PAGE });

  const filtering = isFiltering(filter);
  const withAttachments = itemIdsWithAttachments(data?.attachments ?? []);
  const withRun = itemIdsWithRun(data?.agentRuns ?? []);
  const today = dayOf(new Date());
  const rows = data
    ? allItemsRows(
        {
          ...data,
          items: filtering
            ? data.items.filter((item) => matchesDashboardFilter(filter, item, withAttachments, today, withRun))
            : data.items,
        },
        sort,
      )
    : [];
  const viewKey = JSON.stringify([sort, filter]);
  const shown = paging.of === viewKey ? paging.shown : ALL_ITEMS_PAGE;
  const drawn = rows.slice(0, shown);

  if (error && !data) return <LoadFailure error={error} onRetry={() => void refetch()} />;
  if (!data) return <p className="text-ink-faint">Loading…</p>;

  // The finished Items are a read of their own: not yet fetched, and either
  // nothing can fetch them now, the server refused, or they are on their way.
  const arrived = finished.data !== undefined;
  const needsAConnection = !arrived && (offline || finished.fetchStatus === 'paused');
  const failed = !arrived && !needsAConnection && finished.isError;

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
        {needsAConnection ? (
          <p className="text-sm text-ink-soft">All items needs a connection. Go online to see every Item.</p>
        ) : data.items.length === 0 && arriving ? null : data.items.length === 0 ? (
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
                    data-item-id={row.item.id}
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
                    <td className="px-2 py-1.5">{STATUS_LABELS[row.status]}</td>
                    <td className="px-2 py-1.5">{row.priority ? PRIORITY_LABELS[row.priority] : ''}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">{dueDateLabel(row.due) ?? row.due ?? ''}</td>
                    <td className="max-w-[14rem] truncate px-2 py-1.5">{row.where}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      {momentDateLabel(row.changedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {arriving && (
          <p role="status" className="mt-2 text-sm text-ink-faint">
            Loading finished items…
          </p>
        )}
        {failed && (
          <p role="alert" className="mt-2 text-sm text-over-ink">
            Finished items could not be read.{' '}
            <button type="button" onClick={() => void finished.refetch()} className="underline">
              Try again
            </button>
          </p>
        )}
        {!needsAConnection && rows.length > shown && (
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
