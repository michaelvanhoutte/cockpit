import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { clearDashboardFilter } from '../dashboardFilter';
import { isTypedInto, somethingIsOpenOverThePage } from '../inboxCollapsed';
import { browserStore } from '../lastVisited';
import { PANEL_LIST_KEY, togglesThePanelList } from '../panelList';
import type { PanelListEntry, PanelListing } from '../panelList';
import { usePanelListWidth } from '../panelListWidth';
import { useReach } from '../panelReach';
import type { Reach, ReachDashboard, ReachWorkspace, Scope } from '../panelReach';

const KEY_NAME = PANEL_LIST_KEY.toUpperCase();

/** The id the open column's heading carries, which names the column. */
const HEADING_ID = 'panel-list-heading';

/** Where the Dashboard's scrolling box is, which Esc and G put back. */
const SCROLLER = '[data-drag-scroll="dashboard"]';

const KBD = 'rounded border border-shade/20 px-1 text-[10px] text-ink-faint';

/** Where the mode began, so Esc can put the screen back. */
type Start = {
  scrollTop: number;
  workspaceId: string;
  dashboardId: string;
  /** Whether the screen has been taken to another Dashboard since, which is one history entry added. */
  left: boolean;
};

/** An entry with the Dashboard and Workspace it is on. */
type Target = PanelListEntry & { workspaceId: string; dashboardId: string };

/** The scope switch, narrowest first. */
const SCOPES: readonly { scope: Scope; label: string }[] = [
  { scope: 1, label: 'Dashboard' },
  { scope: 2, label: 'Workspace' },
  { scope: 3, label: 'All' },
];

/** A pinned heading draws over the entries scrolling under it, in the column's own colour. */
const PINNED: CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--ground, var(--color-ground)) 40%, white)',
};

/**
 * Go to panel, the column at a Dashboard's right ("Go to a Panel of this
 * Dashboard from the keyboard with G", issue 813; "Go to a Panel on any
 * Dashboard or Workspace, the screen following the highlight", issue 814): every
 * Panel of the Dashboard on screen, of its Workspace or of every Workspace, to
 * find by name and go to.
 *
 * **A column of its own beside the Dashboard's scroller** (pages/Layout.tsx),
 * the Inbox's counterpart: it scrolls on its own and takes its width from the
 * Panels. The Dashboard on screen is what its board publishes (`listing`);
 * `null` is a board not yet on screen, which says nothing rather than that there
 * are none. The wider scopes are what `reach` reads from each Workspace's
 * snapshot.
 *
 * **G and Shift+G show it on a scope, with the cursor in the search box**
 * ("Type straight into Go to panel, and choose its scope with G and Shift+G",
 * issue 827): G on this Dashboard, Shift+G on its Workspace; the same key again
 * hides it and the other switches scope, keeping the text. Shown by a key, or
 * clicked into, it is in its mode: typing narrows the list with nothing
 * highlighted, the first ↓ highlights the first entry, ↑ and ↓ move it and the
 * screen follows, and Enter goes to the highlight or the top match. Esc puts
 * the screen back where the mode began. Esc and going both hide the column,
 * whatever opened it. The keys are heard from the page, so inside the box G and
 * Shift+G are letters.
 *
 * **The screen follows the highlight onto another Dashboard or Workspace**
 * through the router, and the history stays what going should leave: the first
 * move off the starting Dashboard adds one entry and the moves after it replace
 * that one, so Back after Enter returns to where G was pressed and Esc, which
 * goes back, leaves nothing behind.
 * Everything here is the column's own; the shell only holds whether it is shown.
 */
export function PanelList({
  listing,
  collapsed,
  onCollapse,
  reach,
  rowWidth,
}: {
  listing: PanelListing | null;
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  reach: Reach;
  /** The row the column shares with the Dashboard, a third of which is the widest it goes. */
  rowWidth: number;
}) {
  const resize = usePanelListWidth(browserStore(), rowWidth);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>(1);
  /** The highlighted entry; -1 is the cursor in the box with nothing highlighted yet. */
  const [at, setAt] = useState(-1);
  const [active, setActive] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const start = useRef<Start | null>(null);
  const takeKeys = useRef(false);
  /** Where the screen has been taken to, which the router reports a render late. */
  const shownAt = useRef({ workspaceId: reach.workspaceId, dashboardId: reach.dashboardId });
  /** A Panel to go to once the board of its Dashboard draws it: after a crossing, or for one the filter hid. */
  const pending = useRef<{ dashboardId: string; panelId: string } | null>(null);
  /** The scroll to give a Dashboard back once its board has drawn again. */
  const restore = useRef<{ dashboardId: string; scrollTop: number } | null>(null);

  const here = reach.workspaces.find((workspace) => workspace.id === reach.workspaceId);
  const available: Record<Scope, boolean> = {
    1: true,
    2: (here?.dashboardCount ?? 0) > 1,
    3: reach.workspaces.length > 1,
  };
  const needle = query.trim().toLowerCase();
  const matches = (name: string) => needle !== '' && name.toLowerCase().includes(needle);

  const rows = listing?.rows ?? [];
  const total = rows.reduce((sum, row) => sum + row.length, 0);
  const shownRows = rows
    .map((row) => row.filter((entry) => needle === '' || entry.title.toLowerCase().includes(needle)))
    .filter((row) => row.length > 0);
  const onThisDashboard = (entry: PanelListEntry): Target => ({
    ...entry,
    workspaceId: reach.workspaceId,
    dashboardId: listing?.dashboardId ?? reach.dashboardId,
  });

  /** The wider scopes: a section per Workspace, a group per Dashboard, narrowed by the search at every level. */
  const sections =
    scope === 1
      ? []
      : reach.workspaces
          .filter((workspace) => scope === 3 || workspace.id === reach.workspaceId)
          .map((workspace) => {
            const workspaceMatches = scope === 3 && matches(workspace.name);
            const groups = workspace.dashboards
              .map((dashboard) => ({
                dashboard,
                targets: dashboard.entries
                  .filter(
                    (entry) =>
                      needle === '' ||
                      workspaceMatches ||
                      matches(dashboard.name) ||
                      entry.title.toLowerCase().includes(needle),
                  )
                  .map((entry): Target => ({ ...entry, workspaceId: workspace.id, dashboardId: dashboard.id })),
              }))
              .filter((group) => group.targets.length > 0);
            return { workspace, groups, unread: workspace.state !== 'ready' && (needle === '' || workspaceMatches) };
          })
          .filter((section) => section.groups.length > 0 || section.unread);
  const flat: Target[] =
    scope === 1
      ? shownRows.flat().map(onThisDashboard)
      : sections.flatMap((section) => section.groups.flatMap((group) => group.targets));
  const current = at < 0 ? -1 : Math.min(at, Math.max(flat.length - 1, 0));

  useEffect(() => setAt(-1), [needle, scope]);
  const { ask } = reach;
  useEffect(() => ask(scope), [ask, scope]);

  // A Panel is gone to once the board of its Dashboard, its filter cleared, draws it.
  useEffect(() => {
    const want = pending.current;
    if (want === null || !listing || listing.dashboardId !== want.dashboardId) return;
    if (listing.rows.flat().some((entry) => entry.panelId === want.panelId && !entry.hidden)) {
      pending.current = null;
      listing.jumpTo(want.panelId);
    }
  }, [listing]);

  // A Dashboard put back is scrolled to where it was once its board has drawn.
  useEffect(() => {
    const back = restore.current;
    if (back === null || !listing || listing.dashboardId !== back.dashboardId) return;
    restore.current = null;
    const box = document.querySelector<HTMLElement>(SCROLLER);
    if (box) box.scrollTop = back.scrollTop;
  }, [listing]);

  // A column hidden by its own button is not in its mode any more.
  useEffect(() => {
    if (!collapsed) return;
    start.current = null;
    setActive(false);
    setQuery('');
    // Hidden, it asks for no other Workspace's snapshot any more.
    setScope(1);
  }, [collapsed]);

  useEffect(() => {
    if (takeKeys.current && active && !collapsed) {
      takeKeys.current = false;
      searchRef.current?.focus();
    }
  }, [active, collapsed]);

  useEffect(() => {
    if (active) listRef.current?.querySelector('[data-current]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, current, needle, scope]);

  const scroller = () => document.querySelector<HTMLElement>(SCROLLER);

  /** Begins the mode on `chosen`; `keys` puts the cursor in the box, `keepText` leaves what is typed there. */
  const enter = (keys: boolean, chosen: Scope = 1, keepText = false) => {
    shownAt.current = { workspaceId: reach.workspaceId, dashboardId: reach.dashboardId };
    start.current = {
      scrollTop: scroller()?.scrollTop ?? 0,
      workspaceId: reach.workspaceId,
      dashboardId: reach.dashboardId,
      left: false,
    };
    takeKeys.current = keys;
    pending.current = null;
    restore.current = null;
    setActive(true);
    if (!keepText) setQuery('');
    setScope(chosen);
    setAt(-1);
  };

  /** Ends the mode; `back` puts the screen where it was and hides the column, whatever showed it. */
  const leave = (back: boolean) => {
    const from = start.current;
    start.current = null;
    pending.current = null;
    setActive(false);
    setQuery('');
    setScope(1);
    if (back) {
      if (from?.left) {
        // The one entry the moves added is undone by going back over it.
        restore.current = { dashboardId: from.dashboardId, scrollTop: from.scrollTop };
        shownAt.current = { workspaceId: from.workspaceId, dashboardId: from.dashboardId };
        reach.go(from, 'back');
      } else if (from) {
        const box = scroller();
        if (box) box.scrollTop = from.scrollTop;
      }
      onCollapse(true);
    }
    (document.activeElement as HTMLElement | null)?.blur();
  };

  /**
   * Brings the screen to a Panel. A highlight only passes through (`commit`
   * false) and leaves nothing behind it; going keeps the screen there, and clears
   * the filter of a Dashboard that hid the Panel.
   */
  const show = (entry: Target, commit: boolean) => {
    const from = start.current;
    const wantsJump = commit || !entry.hidden;
    if (commit && entry.hidden) clearDashboardFilter(browserStore(), entry.dashboardId);
    const board = shownAt.current;
    if (commit && from?.left && entry.dashboardId === from.dashboardId) {
      // Going to a Panel where G was pressed: the history entry the moves added goes, none is added.
      from.left = false;
      pending.current = { dashboardId: entry.dashboardId, panelId: entry.panelId };
      shownAt.current = { workspaceId: entry.workspaceId, dashboardId: entry.dashboardId };
      reach.go(entry, 'back');
      return;
    }
    if (entry.dashboardId === board.dashboardId) {
      if (!wantsJump) return;
      if (listing?.dashboardId === entry.dashboardId && !entry.hidden) listing.jumpTo(entry.panelId);
      else pending.current = { dashboardId: entry.dashboardId, panelId: entry.panelId };
      return;
    }
    pending.current = wantsJump ? { dashboardId: entry.dashboardId, panelId: entry.panelId } : null;
    shownAt.current = { workspaceId: entry.workspaceId, dashboardId: entry.dashboardId };
    reach.go(entry, from?.left ? 'replace' : 'push');
    if (from) from.left = true;
  };

  const goTo = (entry: Target | undefined) => {
    if (!entry) return;
    show(entry, true);
    // Going ends the mode and hides the column as Esc does, but the screen stays.
    const pendingJump = pending.current;
    leave(false);
    pending.current = pendingJump;
    onCollapse(true);
  };

  const moveTo = (next: number) => {
    if (flat.length === 0 || (next < 0 && current < 0)) return;
    const clamped = Math.max(0, Math.min(flat.length - 1, next));
    setAt(clamped);
    const entry = flat[clamped];
    if (entry) show(entry, false);
  };

  const pick = (chosen: Scope) => {
    if (available[chosen]) setScope(chosen);
  };

  // G and Shift+G show the column on a scope, hide it, or switch its scope. Heard
  // here rather than in the shell: this is mounted whenever the column is on
  // screen, strip or open.
  const latest = useRef({ collapsed, enter, leave, scope, available });
  latest.current = { collapsed, enter, leave, scope, available };
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
      // Shift+G where the Workspace adds nothing is G.
      const chosen: Scope = event.shiftKey && now.available[2] ? 2 : 1;
      if (now.collapsed) {
        onCollapse(false);
        now.enter(true, chosen);
      } else if (now.scope === chosen) {
        if (start.current) now.leave(true);
        else onCollapse(true);
      } else if (start.current) {
        setScope(chosen);
        searchRef.current?.focus();
      } else now.enter(true, chosen, true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCollapse]);

  const onListKey = (event: ReactKeyboardEvent) => {
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
      // With nothing highlighted, the top match.
      goTo(flat[Math.max(current, 0)]);
    } else if (event.key === 'Escape') {
      handled();
      leave(true);
    }
  };

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => onCollapse(false)}
        title={`Go to panel: ${KEY_NAME} on this Dashboard, Shift+${KEY_NAME} on its Workspace`}
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
        <span className="flex flex-col items-center gap-1">
          <kbd className={KBD}>{KEY_NAME}</kbd>
          <kbd className={KBD}>⇧{KEY_NAME}</kbd>
        </span>
      </button>
    );
  }

  const entryButton = (entry: Target) => {
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
            entry.count !== null && <span className="text-xs tabular-nums text-ink-faint">{entry.count}</span>
          )}
        </button>
      </li>
    );
  };

  const scopeTitle = (chosen: Scope): string => {
    if (!available[chosen]) {
      return chosen === 2 ? 'Only one Dashboard in this Workspace' : 'Only one Workspace';
    }
    if (chosen === 1) return `Search this Dashboard (${KEY_NAME})`;
    return chosen === 2
      ? `Search every Dashboard of ${here?.name ?? 'this Workspace'} (Shift+${KEY_NAME})`
      : 'Search every Workspace';
  };

  const noPanels = scope === 1 ? listing && total === 0 : false;
  const noMatch = scope === 1 ? total > 0 && flat.length === 0 : needle !== '' && flat.length === 0 && sections.length === 0;

  return (
    <aside
      ref={resize.column}
      aria-labelledby={HEADING_ID}
      className="well relative flex shrink-0 flex-col pb-[var(--edge-bottom)]"
      style={{ width: resize.width }}
    >
      {/* The column's left edge is where it is resized from, reaching over the seam as the Inbox's does. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Drag to resize Go to panel, double-click to reset its width"
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.reset}
        className="group absolute inset-y-0 -left-2 z-10 w-3 cursor-col-resize touch-none"
      >
        <div className="absolute inset-y-2 left-1/2 w-[2px] -translate-x-1/2 rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-60 group-active:opacity-100" />
      </div>
      <div
        ref={listRef}
        tabIndex={-1}
        onKeyDown={onListKey}
        onFocus={() => {
          if (!start.current) enter(false, scope, true);
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
            placeholder="Search Panels"
            className="w-full rounded border border-shade/20 bg-ground px-2 py-1 text-sm"
          />
          <div role="group" aria-label="Search in" className="mt-2 flex min-w-0 items-center gap-1 text-xs">
            {SCOPES.map(({ scope: chosen, label }) => (
              <button
                key={chosen}
                type="button"
                tabIndex={-1}
                aria-pressed={scope === chosen}
                aria-disabled={!available[chosen]}
                title={scopeTitle(chosen)}
                onClick={() => {
                  pick(chosen);
                  searchRef.current?.focus();
                }}
                className={`truncate rounded px-1.5 py-0.5 ${
                  scope === chosen
                    ? 'bg-accent-tint font-semibold text-accent-deep'
                    : available[chosen]
                      ? 'text-ink-faint hover:text-ink'
                      : 'text-ink-faint/40'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {noPanels && <p className="px-4 py-1.5 text-sm text-ink-faint">No Panels on this Dashboard.</p>}
          {noMatch && <p className="px-4 py-1.5 text-sm text-ink-faint">No Panel matches.</p>}
          {scope === 1 &&
            shownRows.map((row, place) => (
              <ul
                // Rows have no identity of their own; the Panels in them do.
                key={row.map((entry) => entry.panelId).join()}
                className={place < shownRows.length - 1 ? 'border-b border-shade/10 pb-1 mb-1' : ''}
              >
                {row.map((entry) => entryButton(onThisDashboard(entry)))}
              </ul>
            ))}
          {sections.map(({ workspace, groups, unread }) => (
            <section key={workspace.id}>
              {scope === 3 && <WorkspaceHeading workspace={workspace} />}
              {unread && (
                <p className="px-4 py-1 text-xs text-ink-faint">
                  {workspace.state === 'failed' ? 'Could not be read.' : 'Loading…'}
                </p>
              )}
              {groups.map(({ dashboard, targets }) => (
                <DashboardGroup key={dashboard.id} dashboard={dashboard} underWorkspace={scope === 3}>
                  {targets.map(entryButton)}
                </DashboardGroup>
              ))}
            </section>
          ))}
        </div>
        <div className="border-t border-shade/10 px-3 py-2 text-[10px] leading-relaxed text-ink-faint">
          <kbd>↑↓</kbd> move · <kbd>Enter</kbd> go · <kbd>Esc</kbd> back
          <br />
          <kbd>{KEY_NAME}</kbd> Dashboard · <kbd>⇧{KEY_NAME}</kbd> Workspace
        </div>
      </div>
    </aside>
  );
}

/** A Workspace's name over its Dashboards in *All*, with its colour, pinned while they scroll. */
function WorkspaceHeading({ workspace }: { workspace: ReachWorkspace }) {
  return (
    <h3
      style={PINNED}
      className="sticky top-0 z-20 flex h-7 items-center gap-2 border-t border-shade/15 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink"
    >
      <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: workspace.color }} aria-hidden="true" />
      <span className="truncate">{workspace.name}</span>
    </h3>
  );
}

/**
 * A Dashboard's name, pinned, over its Panels indented. The heading and the list
 * are siblings in a section of their own so the heading sticks for as long as
 * its Panels are in view; under a Workspace it sticks beneath that heading.
 */
function DashboardGroup({
  dashboard,
  underWorkspace,
  children,
}: {
  dashboard: ReachDashboard;
  underWorkspace: boolean;
  children: ReactNode;
}) {
  return (
    <section>
      <h4
        style={PINNED}
        className={`sticky z-10 truncate px-4 pt-1.5 pb-0.5 text-xs font-semibold text-accent-deep ${
          underWorkspace ? 'top-7 pl-[1.6rem]' : 'top-0 border-t border-shade/10'
        }`}
      >
        {dashboard.name}
      </h4>
      <ul className={underWorkspace ? 'pl-[1.1rem]' : 'pl-2'}>{children}</ul>
    </section>
  );
}

/** What the shell draws: the column, with the Workspaces it can reach read as the scope asks. */
export default function PanelListReaching(props: Omit<Parameters<typeof PanelList>[0], 'reach'>) {
  const [asked, setAsked] = useState<Scope>(1);
  return <PanelList {...props} reach={useReach(asked, setAsked)} />;
}
