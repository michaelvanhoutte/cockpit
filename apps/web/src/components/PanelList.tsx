import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { NO_DASHBOARD_FILTER, useDashboardFilter } from '../dashboardFilter';
import { isTypedInto, somethingIsOpenOverThePage } from '../inboxCollapsed';
import { browserStore } from '../lastVisited';
import { PANEL_LIST_KEY, togglesThePanelList } from '../panelList';
import type { PanelListEntry, PanelListing } from '../panelList';

const KEY_NAME = PANEL_LIST_KEY.toUpperCase();

/** The id the open column's heading carries, which names the column. */
const HEADING_ID = 'panel-list-heading';

/** Where the Dashboard's scrolling box is, which Esc and G put back. */
const SCROLLER = '[data-drag-scroll="dashboard"]';

const KBD = 'rounded border border-shade/20 px-1 text-[10px] text-ink-faint';

/** Where G was pressed from, so Esc can put the Dashboard back. */
type Start = { scrollTop: number; shownByG: boolean };

/**
 * Go to panel, the column at a Dashboard's right ("Go to a Panel of this
 * Dashboard from the keyboard with G", issue 813): every Panel of the Dashboard
 * on screen, to find by name and go to.
 *
 * **A column of its own beside the Dashboard's scroller** (pages/Layout.tsx),
 * the Inbox's counterpart: it scrolls on its own and takes its width from the
 * Panels. What it draws is `listing`, published by the board that knows which
 * Panels are drawn; `null` is a board not yet on screen, which says nothing
 * rather than that there are none.
 *
 * **G shows it and hands it the keys.** Shown by G, or clicked into, it is in
 * its mode: the highlight is on an entry, ↑ and ↓ move it and the board
 * follows, Enter or a click goes there and ends the mode, Space puts the
 * cursor in the search box. Esc puts the Dashboard back where the mode began.
 * Everything here is the column's own; the shell only holds whether it is shown.
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
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const [active, setActive] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const start = useRef<Start | null>(null);
  const takeKeys = useRef(false);
  /** A Panel to go to once the board draws it, for one the filter hid. */
  const pending = useRef<string | null>(null);
  const [, setFilter] = useDashboardFilter(browserStore(), listing?.dashboardId ?? null);

  const rows = listing?.rows ?? [];
  const total = rows.reduce((sum, row) => sum + row.length, 0);
  const needle = query.trim().toLowerCase();
  const shownRows = rows
    .map((row) => row.filter((entry) => needle === '' || entry.title.toLowerCase().includes(needle)))
    .filter((row) => row.length > 0);
  const flat = shownRows.flat();
  const current = Math.min(at, Math.max(flat.length - 1, 0));

  useEffect(() => setAt(0), [needle]);

  // A hidden Panel is gone to once the board, its filter cleared, draws it.
  useEffect(() => {
    const want = pending.current;
    if (want === null || !listing) return;
    if (listing.rows.flat().some((entry) => entry.panelId === want && !entry.hidden)) {
      pending.current = null;
      listing.jumpTo(want);
    }
  }, [listing]);

  // A column hidden by its own button is not in its mode any more.
  useEffect(() => {
    if (!collapsed) return;
    start.current = null;
    setActive(false);
  }, [collapsed]);

  useEffect(() => {
    if (takeKeys.current && active && !collapsed) {
      takeKeys.current = false;
      listRef.current?.focus();
    }
  }, [active, collapsed]);

  useEffect(() => {
    if (active) listRef.current?.querySelector('[data-current]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, current, needle]);

  const scroller = () => document.querySelector<HTMLElement>(SCROLLER);

  const enter = (shownByG: boolean) => {
    start.current = { scrollTop: scroller()?.scrollTop ?? 0, shownByG };
    takeKeys.current = shownByG;
    setActive(true);
    setQuery('');
    setAt(0);
  };

  /** Ends the mode; `back` puts the Dashboard where it was, and hides the column if G showed it. */
  const leave = (back: boolean) => {
    const from = start.current;
    start.current = null;
    setActive(false);
    setQuery('');
    if (from && back) {
      const box = scroller();
      if (box) box.scrollTop = from.scrollTop;
      if (from.shownByG) onCollapse(true);
    }
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const goTo = (entry: PanelListEntry | undefined) => {
    if (!entry || !listing) return;
    if (entry.hidden) {
      pending.current = entry.panelId;
      setFilter(NO_DASHBOARD_FILTER);
    } else listing.jumpTo(entry.panelId);
    leave(false);
  };

  const moveTo = (next: number) => {
    if (flat.length === 0) return;
    const clamped = Math.max(0, Math.min(flat.length - 1, next));
    setAt(clamped);
    const entry = flat[clamped];
    if (entry && !entry.hidden) listing?.jumpTo(entry.panelId);
  };

  // G shows the column and takes the keys, or hides it. Heard here rather than
  // in the shell: this is mounted whenever the column is on screen, strip or open.
  const latest = useRef({ collapsed, enter, leave });
  latest.current = { collapsed, enter, leave };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const toggles = togglesThePanelList(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          repeat: event.repeat,
          defaultPrevented: event.defaultPrevented,
          typing: isTypedInto(event.target),
        },
        somethingIsOpenOverThePage(),
      );
      if (!toggles) return;
      event.preventDefault();
      const now = latest.current;
      if (now.collapsed) {
        onCollapse(false);
        now.enter(true);
      } else {
        if (start.current) now.leave(true);
        onCollapse(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCollapse]);

  const onListKey = (event: ReactKeyboardEvent) => {
    const inSearch = event.target === searchRef.current;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === 'ArrowDown') {
      handled();
      moveTo(current + 1);
    } else if (event.key === 'ArrowUp') {
      handled();
      moveTo(current - 1);
    } else if (event.key === 'Enter') {
      handled();
      goTo(flat[current]);
    } else if (event.key === 'Escape') {
      handled();
      if (inSearch) {
        setQuery('');
        listRef.current?.focus();
      } else leave(true);
    } else if (event.key === ' ' && !inSearch) {
      handled();
      searchRef.current?.focus();
    }
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => onCollapse(false)}
        title={`Go to panel (${KEY_NAME})`}
        aria-label="Open Go to panel"
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
          Go to panel
        </span>
        <kbd className={KBD}>{KEY_NAME}</kbd>
      </button>
    );
  }

  return (
    <aside aria-labelledby={HEADING_ID} className="well flex w-56 shrink-0 flex-col pb-[var(--edge-bottom)]">
      <div
        ref={listRef}
        tabIndex={-1}
        onKeyDown={onListKey}
        onFocus={() => {
          if (!start.current) enter(false);
        }}
        onBlur={(event) => {
          // Clicking away from the column ends the mode where you are.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            start.current = null;
            setActive(false);
          }
        }}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        <div className="flex min-h-9 items-center gap-2 px-4 pt-2 pb-1.5">
          <h2
            id={HEADING_ID}
            className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
          >
            Go to panel
          </h2>
          <kbd className={KBD}>{KEY_NAME}</kbd>
          <button
            type="button"
            onClick={() => onCollapse(true)}
            title={`Hide Go to panel (${KEY_NAME})`}
            aria-label="Hide Go to panel"
            data-shortcut-tip="panels"
            className="-mr-1 ml-auto rounded px-1 text-xs text-ink-faint hover:text-ink"
          >
            »
          </button>
        </div>
        <div className="px-3 pb-2">
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search Panels"
            placeholder={active ? 'Space to search' : 'Search Panels'}
            className="w-full rounded border border-shade/20 bg-ground px-2 py-1 text-sm"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {listing && total === 0 && (
            <p className="px-4 py-1.5 text-sm text-ink-faint">No Panels on this Dashboard.</p>
          )}
          {total > 0 && flat.length === 0 && (
            <p className="px-4 py-1.5 text-sm text-ink-faint">No Panel matches.</p>
          )}
          {shownRows.map((row, place) => (
            <ul
              // Rows have no identity of their own; the Panels in them do.
              key={row.map((entry) => entry.panelId).join()}
              className={place < shownRows.length - 1 ? 'border-b border-shade/10 pb-1 mb-1' : ''}
            >
              {row.map((entry) => {
                const highlighted = active && flat[current]?.panelId === entry.panelId;
                return (
                  <li key={entry.panelId}>
                    <button
                      type="button"
                      tabIndex={-1}
                      data-current={highlighted ? '' : undefined}
                      onClick={() => goTo(entry)}
                      className={`flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm ${
                        highlighted ? 'bg-accent-tint' : 'hover:bg-accent-tint/40'
                      } ${entry.hidden ? 'text-ink-faint' : 'text-ink'}`}
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                      {entry.hidden ? (
                        <span className="text-[10px]">filtered</span>
                      ) : (
                        entry.count !== null && (
                          <span className="text-xs tabular-nums text-ink-faint">{entry.count}</span>
                        )
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          ))}
        </div>
        <div className="border-t border-shade/10 px-3 py-2 text-[10px] leading-relaxed text-ink-faint">
          <kbd>↑↓</kbd> move · <kbd>Enter</kbd> go · <kbd>Space</kbd> search
          <br />
          <kbd>Esc</kbd> back · <kbd>{KEY_NAME}</kbd> hide
        </div>
      </div>
    </aside>
  );
}

export default PanelList;
