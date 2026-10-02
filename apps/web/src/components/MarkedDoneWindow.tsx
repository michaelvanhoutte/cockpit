import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { snapshotQuery } from '../api/queries';
import { useOpenItem } from '../itemForm';
import { GROUPS, MARKED_DONE_PAGE, markedDoneRows } from '../markedDone';
import { CloseWindow, ManageWindow } from './ManageWindow';

/**
 * Every item this workspace has marked done, in a window over the screen you
 * are on ("See the items you have marked done, from the header menu", issue
 * 637).
 *
 * **Client-side only.** Finished items already travel in the workspace snapshot
 * (`filing.ts`, `stillOpen`), so this reads the copy the rest of the app draws
 * from and works offline. Opening a row opens that Item's form over this window
 * (`itemForm.tsx`); reopening is the form's own status change, which returns
 * the item to where it was filed and so takes its row out of this list.
 */
export default function MarkedDoneWindow({
  workspaceId,
  open,
  onClose,
  returnFocusTo,
}: {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const { data } = useQuery({ ...snapshotQuery(workspaceId), enabled: open });
  const openItem = useOpenItem();
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(MARKED_DONE_PAGE);

  // Fixed for this render, so the group a row is in and the age it says agree.
  const rows = data ? markedDoneRows(data, search, new Date()) : [];
  const everyFinished = data ? data.items.some((item) => item.completedAt) : false;
  const drawn = rows.slice(0, shown);

  return (
    <ManageWindow
      title="Marked done"
      open={open}
      onClose={() => {
        onClose();
        setSearch('');
        setShown(MARKED_DONE_PAGE);
      }}
      returnFocusTo={returnFocusTo}
      wide
      tall
    >
      <label className="mt-3 block">
        <span className="sr-only">Search items marked done</span>
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setShown(MARKED_DONE_PAGE);
          }}
          placeholder="Search by title, description or next action"
          className="w-full rounded-md border border-black/15 bg-surface px-3 py-1.5 text-sm"
        />
      </label>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {!data ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : !everyFinished ? (
          <p className="text-sm text-ink-faint">Nothing has been marked done.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-ink-faint">Nothing finished matches.</p>
        ) : (
          <>
            {GROUPS.map((group) => {
              const inGroup = drawn.filter((row) => row.group === group);
              if (inGroup.length === 0) return null;
              return (
                <section key={group} aria-label={group} className="mb-3">
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                    {group}
                  </h3>
                  <ul>
                    {inGroup.map((row) => (
                      <li key={row.item.id}>
                        <button
                          type="button"
                          onClick={() => openItem(row.item.id)}
                          className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-accent-tint focus-visible:outline-2 focus-visible:outline-accent"
                        >
                          <span className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate">{row.title}</span>
                            {row.type && (
                              <span className="shrink-0 text-sm text-accent-deep">{row.type}</span>
                            )}
                          </span>
                          <span className="block truncate text-sm text-ink-faint">{row.line}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {rows.length > shown && (
              <button
                type="button"
                onClick={() => setShown(shown + MARKED_DONE_PAGE)}
                className="rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
              >
                Show more
              </button>
            )}
          </>
        )}
      </div>
      <CloseWindow label="Close" />
    </ManageWindow>
  );
}
