import { PANEL_LIST_KEY } from '../panelList';
import type { PanelListing } from '../panelList';

const KEY_NAME = PANEL_LIST_KEY.toUpperCase();

/** The id the open column's heading carries, which names the column. */
const HEADING_ID = 'panel-list-heading';

/**
 * The Dashboard's Panels, listed in a column at its right ("Show a Dashboard's
 * Panels in a collapsible column at its right, and jump to one", issue 803):
 * each entry is a Panel's title and the count its header shows, a row of the
 * Dashboard at a time with a hairline between rows, and pressing one brings
 * that Panel to the top.
 *
 * **A column of its own beside the Dashboard's scroller** (pages/Layout.tsx),
 * the Inbox's counterpart: it scrolls on its own and takes its width from the
 * Panels. What it draws is `listing`, published by the board that knows which
 * Panels are drawn; `null` is a board not yet on screen, which says nothing
 * rather than that there are none.
 */
export function PanelList({
  listing,
  collapsed,
  onCollapse,
}: {
  listing: PanelListing | null;
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
}) {
  const rows = listing?.rows ?? [];
  const count = listing ? rows.reduce((sum, row) => sum + row.length, 0) : null;

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => onCollapse(false)}
        title={`Open the Panel list (${KEY_NAME})`}
        aria-label="Open the Panel list"
        data-shortcut-tip="panels"
        className="well flex w-8 shrink-0 flex-col items-center gap-3 py-3 pb-[calc(0.75rem+var(--edge-bottom))] hover:bg-accent-tint/40"
      >
        <span aria-hidden="true" className="text-xs text-ink-faint">
          «
        </span>
        <span
          className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
          style={{ writingMode: 'vertical-rl' }}
        >
          Panels
        </span>
        {count !== null && <span className="text-xs tabular-nums text-ink-faint">{count}</span>}
      </button>
    );
  }

  return (
    <aside
      aria-labelledby={HEADING_ID}
      className="well w-56 shrink-0 overflow-y-auto pb-[var(--edge-bottom)]"
    >
      <div className="flex min-h-9 items-center gap-2 px-4 pt-2 pb-1.5">
        <h2
          id={HEADING_ID}
          className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
        >
          Panels
        </h2>
        {count !== null && <span className="text-xs tabular-nums text-ink-faint">{count}</span>}
        <button
          type="button"
          onClick={() => onCollapse(true)}
          title={`Collapse the Panel list (${KEY_NAME})`}
          aria-label="Collapse the Panel list"
          data-shortcut-tip="panels"
          className="-mr-1 ml-auto rounded px-1 text-xs text-ink-faint hover:text-ink"
        >
          »
        </button>
      </div>
      {listing && rows.length === 0 && (
        <p className="px-4 py-1.5 text-sm text-ink-faint">No Panels on this Dashboard.</p>
      )}
      {rows.map((row, at) => (
        <ul
          // Rows have no identity of their own; the Panels in them do.
          key={row.map((entry) => entry.panelId).join()}
          className={at < rows.length - 1 ? 'border-b border-shade/10 pb-1 mb-1' : ''}
        >
          {row.map((entry) => (
            <li key={entry.panelId}>
              <button
                type="button"
                onClick={() => listing?.jumpTo(entry.panelId)}
                className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm text-ink hover:bg-accent-tint/40"
              >
                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                {entry.count !== null && (
                  <span className="text-xs tabular-nums text-ink-faint">{entry.count}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ))}
    </aside>
  );
}
