import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { clearDashboardFilter } from '../dashboardFilter';
import { dayOf } from '../filters';
import { isTypedInto, somethingIsOpenOverThePage } from '../inboxCollapsed';
import { browserStore } from '../lastVisited';
import { findItems, useFindIndex } from '../itemFind';
import type { FindScope, FoundItem } from '../itemFind';
import { askToLand, forgetLanding } from '../landOnItem';
import { entriesIn, FIND_ITEM_KEY, isListedSection, modeOfKeyPress, PANEL_LIST_KEY, rowsLeftBy, rowsOfRun } from '../panelList';
import type { PanelListEntry, PanelListing, PanelListMode, PanelListRow } from '../panelList';
import { usePanelListWidth } from '../panelListWidth';
import { KEY_CAP } from './keyCap';
import { useReach } from '../panelReach';
import type { Reach, ReachDashboard, ReachWorkspace, Scope } from '../panelReach';

const KEY_NAME = PANEL_LIST_KEY.toUpperCase();
const FIND_NAME = FIND_ITEM_KEY.toUpperCase();

/** The id the open column's heading carries, which names the column. */
const HEADING_ID = 'panel-list-heading';

/** Where the Dashboard's scrolling box is, which Esc and G put back. */
const SCROLLER = '[data-drag-scroll="dashboard"]';

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
 *
 * **Find item is the same column in a second mode** ("Find an open Item with F
 * and Shift+F, and land on its row", issue 828), under the same rules: F on this
 * Dashboard, Shift+F on its Workspace (there is no *All*), nothing listed until
 * something is typed, then the open Items matching (`itemFind.ts`). The screen
 * follows the highlight onto the Item's row, and Enter lands focus on it, by a
 * request that outlives the column (`landOnItem.ts`). **Include done** (Workspace only, unticked at every opening) adds the finished Items; highlighting one leaves the screen put, and Enter goes to its row in *All items* (issue 829).
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
  const [mode, setMode] = useState<PanelListMode>('panel');
  /** Find's *Include done* box, unticked at every opening. */
  const [includeDone, setIncludeDone] = useState(false);
  const finding = mode === 'item';
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
  /** Whether the Workspace adds a Dashboard to go to; Find's Workspace scope adds the Inbox, so it is always there. */
  const workspaceAddsPanels = (here?.dashboardCount ?? 0) > 1;
  /** Find searches this Workspace at most, so no other Workspace's snapshot is read. */
  const available: Record<Scope, boolean> = {
    1: true,
    2: finding || workspaceAddsPanels,
    3: !finding && reach.workspaces.length > 1,
  };
  const needle = query.trim().toLowerCase();
  const matches = (name: string) => needle !== '' && name.toLowerCase().includes(needle);

  const rows = listing?.rows ?? [];
  const total = entriesIn(rows).length;
  // A Dashboard of Sections alone has nothing to go to, so their titles stand under "No Panels" for nothing.
  const shownRows = total === 0 ? [] : rowsLeftBy(rows, needle, (entry) => matches(entry.title));
  const onThisDashboard = (entry: PanelListEntry): Target => ({
    ...entry,
    workspaceId: reach.workspaceId,
    dashboardId: listing?.dashboardId ?? reach.dashboardId,
  });

  /** The wider scopes: a section per Workspace, a group per Dashboard, narrowed by the search at every level. */
  const sections =
    scope === 1 || finding
      ? []
      : reach.workspaces
          .filter((workspace) => scope === 3 || workspace.id === reach.workspaceId)
          .map((workspace) => {
            const workspaceMatches = scope === 3 && matches(workspace.name);
            const groups = workspace.dashboards
              .map((dashboard) => {
                const left = rowsLeftBy(
                  rowsOfRun(dashboard.entries),
                  needle,
                  (entry) => matches(entry.title),
                  needle === '' || workspaceMatches || matches(dashboard.name),
                );
                return {
                  dashboard,
                  rows: left,
                  targets: entriesIn(left).map((entry): Target => ({ ...entry, workspaceId: workspace.id, dashboardId: dashboard.id })),
                };
              })
              .filter((group) => group.targets.length > 0);
            return { workspace, groups, unread: workspace.state !== 'ready' && (needle === '' || workspaceMatches) };
          })
          .filter((section) => section.groups.length > 0 || section.unread);
  const flat: Target[] =
    scope === 1
      ? entriesIn(shownRows).map(onThisDashboard)
      : sections.flatMap((section) => section.groups.flatMap((group) => group.targets));
  // Find item: the open Items matching, over an index built once per snapshot and only while Find is open.
  const findIndex = useFindIndex(finding ? reach.snapshot : undefined, dayOf(new Date()));
  const findScope: FindScope = scope === 2 ? 2 : 1;
  const found = useMemo(
    () =>
      finding
        ? findItems(findIndex, query, findScope, reach.dashboardId, undefined, includeDone)
        : { rows: [] as FoundItem[], more: 0 },
    [finding, findIndex, query, findScope, reach.dashboardId, includeDone],
  );
  const size = finding ? found.rows.length : flat.length;
  const current = at < 0 ? -1 : Math.min(at, Math.max(size - 1, 0));

  useEffect(() => setAt(-1), [needle, scope, mode]);
  const { ask } = reach;
  // Find never reads past the Workspace on screen, which the board has already read.
  useEffect(() => ask(finding ? 1 : scope), [ask, scope, finding]);

  // A Panel is gone to once the board of its Dashboard, its filter cleared, draws it.
  useEffect(() => {
    const want = pending.current;
    if (want === null || !listing || listing.dashboardId !== want.dashboardId) return;
    if (entriesIn(listing.rows).some((entry) => entry.panelId === want.panelId && !entry.hidden)) {
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
    setMode('panel');
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
  const enter = (keys: boolean, chosenMode: PanelListMode = 'panel', chosen: Scope = 1, keepText = false) => {
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
    setIncludeDone(false);
    if (!keepText) setQuery('');
    setMode(chosenMode);
    setScope(chosen);
    setAt(-1);
  };

  /**
   * Ends the mode; `back` puts the screen where it was and hides the column,
   * whatever showed it. `keepFocus` leaves the cursor where it is, for a column
   * about to be hidden over a row that is to take the focus.
   */
  const leave = (back: boolean, keepFocus = false) => {
    const from = start.current;
    start.current = null;
    pending.current = null;
    setActive(false);
    setQuery('');
    setScope(1);
    setMode('panel');
    setIncludeDone(false);
    if (back) {
      // Nothing left to land on: the screen is going back.
      forgetLanding();
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
    if (!keepFocus) (document.activeElement as HTMLElement | null)?.blur();
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

  /**
   * Brings the screen to an Item's row, on the same history rules as a Panel's.
   * **The request to land is made first and outlives the column**, which the
   * board drawing the row (or the shell, for the Inbox) takes: a highlight lands
   * on the row outlined, and going (`commit`) focuses it.
   */
  const showFound = (item: FoundItem, commit: boolean) => {
    const from = start.current;
    const target = item.panel;
    if (item.done) {
      // On no Dashboard: a highlight leaves the screen where it is, and going is to *All items*.
      forgetLanding();
      if (!commit) return;
      askToLand({ itemId: item.itemId, place: { kind: 'allItems', workspaceId: reach.workspaceId }, focus: true });
      reach.goToAllItems(reach.workspaceId, from?.left ? 'replace' : 'push');
      return;
    }
    askToLand({
      itemId: item.itemId,
      place: target ? { kind: 'panel', dashboardId: target.dashboardId, panelId: target.panelId } : { kind: 'inbox' },
      focus: commit,
    });
    // The Inbox is the Workspace's, drawn beside every Dashboard of it.
    if (!target) return;
    const to = { workspaceId: reach.workspaceId, dashboardId: target.dashboardId };
    if (commit && from?.left && target.dashboardId === from.dashboardId) {
      from.left = false;
      shownAt.current = to;
      reach.go(to, 'back');
      return;
    }
    if (target.dashboardId === shownAt.current.dashboardId) return;
    shownAt.current = to;
    reach.go(to, from?.left ? 'replace' : 'push');
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

  const goToFound = (item: FoundItem | undefined) => {
    if (!item) return;
    showFound(item, true);
    leave(false, true);
    onCollapse(true);
  };

  const moveTo = (next: number) => {
    if (size === 0 || (next < 0 && current < 0)) return;
    const clamped = Math.max(0, Math.min(size - 1, next));
    setAt(clamped);
    if (finding) {
      const item = found.rows[clamped];
      if (item) showFound(item, false);
      return;
    }
    const entry = flat[clamped];
    if (entry) show(entry, false);
  };

  const pick = (chosen: Scope) => {
    if (available[chosen]) setScope(chosen);
  };

  // G, Shift+G, F and Shift+F show the column in a mode on a scope, hide it, or
  // switch its mode and scope. Heard here rather than in the shell: this is
  // mounted whenever the column is on screen, strip or open.
  const latest = useRef({ collapsed, enter, leave, scope, mode, workspaceAddsPanels });
  latest.current = { collapsed, enter, leave, scope, mode, workspaceAddsPanels };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const pressed = modeOfKeyPress(
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
      if (!pressed) return;
      event.preventDefault();
      const now = latest.current;
      // Shift+G where the Workspace adds nothing is G; Shift+F is always the Workspace.
      const chosen: Scope = event.shiftKey && (pressed === 'item' || now.workspaceAddsPanels) ? 2 : 1;
      if (now.collapsed) {
        onCollapse(false);
        now.enter(true, pressed, chosen);
      } else if (now.mode === pressed && now.scope === chosen) {
        if (start.current) now.leave(true);
        else onCollapse(true);
      } else if (start.current) {
        setMode(pressed);
        setScope(chosen);
        searchRef.current?.focus();
      } else now.enter(true, pressed, chosen, true);
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
      if (finding) goToFound(found.rows[Math.max(current, 0)]);
      else goTo(flat[Math.max(current, 0)]);
    } else if (event.key === 'Escape') {
      handled();
      leave(true);
    }
  };

  if (collapsed) {
    /** One half of the strip: a mode, named for what it does and the two keys that open it. */
    const half = (opens: PanelListMode, name: string, key: string, tip?: 'panels') => (
      <button
        type="button"
        onClick={() => {
          onCollapse(false);
          enter(true, opens);
        }}
        title={`${name}: ${key} on this Dashboard, Shift+${key} on its Workspace`}
        aria-label={`Open ${name}`}
        data-shortcut-tip={tip}
        className="flex flex-col items-center gap-3 py-3 hover:bg-accent-tint/40"
      >
        <span aria-hidden="true" className="text-xs text-ink-faint">
          «
        </span>
        <span
          className="text-xs font-semibold uppercase tracking-[0.11em] text-accent-deep"
          style={{ writingMode: 'vertical-rl' }}
        >
          {name}
        </span>
        <span className="flex flex-col items-center gap-1">
          <kbd className={KEY_CAP}>{key}</kbd>
          <kbd className={KEY_CAP}>⇧{key}</kbd>
        </span>
      </button>
    );
    return (
      <div className="well flex w-8 shrink-0 flex-col pb-[var(--edge-bottom)]">
        {half('panel', 'Go to panel', KEY_NAME, 'panels')}
        <div className="mx-1 border-t border-shade/15" />
        {half('item', 'Find item', FIND_NAME)}
      </div>
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

  /**
   * Rows of Panels, each Section a sub-heading in place of the hairline between
   * rows (`hairlines`): the heading is no entry, so the keys never reach it.
   */
  const listedRows = (
    list: readonly PanelListRow[],
    toTarget: (entry: PanelListEntry) => Target,
    hairlines: boolean,
    indent = '',
  ) =>
    list.map((row, place) => {
      if (isListedSection(row)) return <SectionHeading key={`section-${place}`} title={row.section} indent={indent} />;
      const next = list[place + 1];
      return (
        <ul
          // Rows have no identity of their own; the Panels in them do.
          key={row.map((entry) => entry.panelId).join()}
          className={`${indent} ${hairlines && next && !isListedSection(next) ? 'border-b border-shade/10 pb-1 mb-1' : ''}`.trim()}
        >
          {row.map((entry) => entryButton(toTarget(entry)))}
        </ul>
      );
    });

  /** A row of Find: the Item's label over, fainter, where it is. */
  const foundButton = (item: FoundItem) => {
    const highlighted = active && found.rows[current]?.itemId === item.itemId;
    return (
      <li key={item.itemId}>
        <button
          type="button"
          tabIndex={-1}
          data-current={highlighted ? '' : undefined}
          onClick={() => goToFound(item)}
          className={`flex w-full flex-col px-4 py-1.5 text-left text-sm text-ink ${
            highlighted ? 'bg-accent-tint' : 'hover:bg-accent-tint/40'
          }`}
        >
          <span className={`truncate ${item.done ? 'line-through' : ''}`.trim()}>{item.title}</span>
          <span className="truncate text-[11px] text-ink-faint">{item.where}</span>
        </button>
      </li>
    );
  };

  const scopeTitle = (chosen: Scope): string => {
    if (!available[chosen]) {
      if (finding) return 'Find searches this Workspace at most';
      return chosen === 2 ? 'Only one Dashboard in this Workspace' : 'Only one Workspace';
    }
    const key = finding ? FIND_NAME : KEY_NAME;
    if (chosen === 1) return `Search this Dashboard (${key})`;
    return chosen === 2
      ? `Search every ${finding ? 'open Item' : 'Dashboard'} of ${here?.name ?? 'this Workspace'} (Shift+${key})`
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
        onFocus={(event) => {
          if (!start.current) enter(false, mode, scope, true);
          // The box is where the keys go: a click on the column outside its controls puts the cursor there.
          if (event.target === event.currentTarget) searchRef.current?.focus();
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
            {finding ? 'Find item' : 'Go to panel'}
          </h2>
          <kbd className={KEY_CAP}>{finding ? FIND_NAME : KEY_NAME}</kbd>
          <button
            type="button"
            onClick={() => onCollapse(true)}
            title={`Hide ${finding ? 'Find item' : 'Go to panel'} (${finding ? FIND_NAME : KEY_NAME})`}
            aria-label={finding ? 'Hide Find item' : 'Hide Go to panel'}
            data-shortcut-tip={finding ? undefined : 'panels'}
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
            aria-label={finding ? 'Find an Item' : 'Search Panels'}
            placeholder={finding ? 'Find an Item' : 'Search Panels'}
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
          {finding && scope === 2 && (
            <label className="mt-2 flex items-center gap-1.5 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={includeDone}
                onChange={(event) => {
                  setIncludeDone(event.target.checked);
                  searchRef.current?.focus();
                }}
                className="size-3.5"
              />
              Include done
            </label>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {finding && needle === '' && <p className="px-4 py-1.5 text-sm text-ink-faint">Type to find an Item.</p>}
          {finding && needle !== '' && found.rows.length === 0 && (
            <p className="px-4 py-1.5 text-sm text-ink-faint">No Item matches.</p>
          )}
          {finding && <ul>{found.rows.map(foundButton)}</ul>}
          {finding && found.more > 0 && (
            <p className="px-4 py-1.5 text-xs text-ink-faint">and {found.more} more — keep typing</p>
          )}
          {!finding && noPanels && <p className="px-4 py-1.5 text-sm text-ink-faint">No Panels on this Dashboard.</p>}
          {!finding && noMatch && <p className="px-4 py-1.5 text-sm text-ink-faint">No Panel matches.</p>}
          {!finding && scope === 1 && listedRows(shownRows, onThisDashboard, true)}
          {sections.map(({ workspace, groups, unread }) => (
            <section key={workspace.id}>
              {scope === 3 && <WorkspaceHeading workspace={workspace} />}
              {unread && (
                <p className="px-4 py-1 text-xs text-ink-faint">
                  {workspace.state === 'failed' ? 'Could not be read.' : 'Loading…'}
                </p>
              )}
              {groups.map(({ dashboard, rows: groupRows }) => (
                <DashboardGroup key={dashboard.id} dashboard={dashboard} underWorkspace={scope === 3}>
                  {listedRows(
                    groupRows,
                    (entry) => ({ ...entry, workspaceId: workspace.id, dashboardId: dashboard.id }),
                    false,
                    scope === 3 ? 'pl-[1.1rem]' : 'pl-2',
                  )}
                </DashboardGroup>
              ))}
            </section>
          ))}
        </div>
        <div className="border-t border-shade/10 px-3 py-2 text-[10px] leading-relaxed text-ink-faint">
          <kbd>↑↓</kbd> move · <kbd>Enter</kbd> go · <kbd>Esc</kbd> back
          <br />
          <kbd>{KEY_NAME}</kbd> Dashboard Panels · <kbd>⇧{KEY_NAME}</kbd> Workspace Panels
          <br />
          <kbd>{FIND_NAME}</kbd> Dashboard Items · <kbd>⇧{FIND_NAME}</kbd> Workspace Items
        </div>
      </div>
    </aside>
  );
}

/** A Workspace's name over its Dashboards in *All*, with its colour, pinned while they scroll. */
function WorkspaceHeading({ workspace }: { workspace: ReachWorkspace }) {
  return (
    <h3
      className="well-fill sticky top-0 z-20 flex h-7 items-center gap-2 border-t border-shade/15 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink"
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
        className={`well-fill sticky z-10 truncate px-4 pt-1.5 pb-0.5 text-xs font-semibold text-accent-deep ${
          underWorkspace ? 'top-7 pl-[1.6rem]' : 'top-0 border-t border-shade/10'
        }`}
      >
        {dashboard.name}
      </h4>
      {children}
    </section>
  );
}

/** A Section's title over the Panels under it, drawn where the hairline between rows would be; `indent` is the group's own. */
function SectionHeading({ title, indent }: { title: string; indent: string }) {
  // The indent goes on a wrapper, so the tinted box moves in with its group's Panels
  // rather than only its title moving inside a box that stays put.
  return (
    <div className={indent || undefined}>
      <h5 className="mx-2 mt-1.5 mb-0.5 truncate rounded-t border-b-2 border-accent-deep bg-accent-tint px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-accent-deep">
        {title}
      </h5>
    </div>
  );
}

/** What the shell draws: the column, with the Workspaces it can reach read as the scope asks. */
export default function PanelListReaching(props: Omit<Parameters<typeof PanelList>[0], 'reach'>) {
  const [asked, setAsked] = useState<Scope>(1);
  return <PanelList {...props} reach={useReach(asked, setAsked)} />;
}
