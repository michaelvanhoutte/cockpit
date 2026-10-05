import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { panelTakesItems, type Dashboard, type Panel, type Workspace } from '@cockpit/shared';
import { refusalFrom } from '../api/queries';

/**
 * Where an item can be moved: onto a panel, or into a workspace's Inbox.
 *
 * The Inbox arm names its workspace rather than being a bare null, because
 * since "Capture something before you know which workspace it belongs to"
 * (issue 165) there is more than one Inbox to mean: an item belonging to no
 * workspace is in every one of them, and picking which is how it gets one.
 */
export type MoveTarget = { panel: string } | { inboxOf: string };

/** The plain Inbox's label, which is also what searching for it matches. */
const INBOX = 'Inbox';

/**
 * Where an item should go: the Inbox, or any panel of this workspace ("Panels
 * hold the items filed into them, and the Inbox holds the rest", issue 36).
 *
 * **An ordinary dialog rather than an alert dialog.** The delete question is an
 * alert because it demands an answer before anything else happens; this is a
 * choice among many, so pressing outside it means "not now" and closes it.
 *
 * **The dashboard you are on comes first**, because the panel you want is
 * nearly always on the dashboard you are looking at. Above that, the panels
 * most recently filed into (recentPanels.ts), because the other common case is
 * filing five things into the same panel in a row - and that panel is often on
 * a dashboard you are not on.
 *
 * **Searchable, with the search focused on open**, because a workspace of
 * several dashboards is otherwise a list to be read. A dashboard is a heading
 * pinned while its panels scroll past, so a panel is never read without the
 * dashboard it is on; a search matching a dashboard's name keeps all its panels.
 *
 * **Nothing is offered that would change nothing**: see `alreadyOn`.
 *
 * **The dialog keeps the height it opened at**, so narrowing the list with a
 * search does not pull Cancel up from under the pointer.
 *
 * **The Inbox is one of the targets**, so there is a way to say "put this back
 * for me to deal with later" rather than only the side effect of removing an
 * item from its last panel. It sits on its own at the top: it is not a panel,
 * and it is where the item already is more often than not.
 *
 * **Focus goes back where the question came from.** Opened from an entry in a
 * row's menu rather than by a trigger of its own, so Radix has nothing to
 * return the focus to and would leave it at the top of the page - which, in a
 * list of rows, is losing your place.
 */
function MoveToPicker({
  moving,
  adding = false,
  dashboards,
  panels,
  workspaceId,
  inboxesOf,
  openDashboardId,
  recent,
  open,
  onPick,
  onCancel,
  refusal,
  busy = false,
  returnFocusTo,
  alreadyOn,
  onAddPanel,
  filteredDashboardIds,
}: {
  /**
   * Makes a panel of items on a dashboard, answering its id - or rejecting with
   * the refusal ("Add a panel from the Move to picker", issue 709). Absent where
   * the picker may not make one, which draws no + at all. The filing that
   * follows is the ordinary `onPick`, so a panel made and then refused its
   * filing stays.
   */
  onAddPanel?: (dashboardId: string, name: string) => Promise<string>;
  /** The dashboards filtered in this browser, which + Panel is locked on and so is the + here. */
  filteredDashboardIds?: ReadonlySet<string>;
  /**
   * The panels the one item being moved is on now, left out where picking one
   * would change nothing: every one of them when adding, and the only one when
   * moving (moving to one of several still takes it off the rest, so those
   * stay). The Inbox is left out for an item on no panel, which is in it.
   *
   * Absent for a selection of several, which can mix the two, so all is offered.
   */
  alreadyOn?: readonly string[];
  /**
   * What is being moved, so the question says what it is about: one row's
   * title, or how many were picked out of the list ("Select several items, and
   * file them all in one go", issue 169).
   *
   * Two shapes rather than a title the caller has already made a sentence of,
   * because only one of them is quoted - a title is the person's own words and
   * a count is the app's.
   */
  moving: { title: string } | { several: number };
  /**
   * That this is showing the Item somewhere *as well* rather than moving it
   * ("Ask whether to move an item to a panel or add it to one", issue 142).
   *
   * The same picker either way, because the question it answers is the same
   * one - which panel - and two pickers would be two lists of the same panels
   * to keep in step. What changes is the sentence at the top and the Inbox,
   * which is not a place anything can be added to: it is what is filed nowhere.
   */
  adding?: boolean;
  dashboards: readonly Dashboard[];
  /** Every panel of the workspace, whichever dashboard it is on. */
  panels: readonly Panel[];
  /** The workspace being looked at, whose Inbox is the plain one at the top. */
  workspaceId: string;
  /**
   * Every workspace, listed as Inboxes above the panels - given only for an
   * item that belongs to none of them yet ("Capture something before you know
   * which workspace it belongs to", issue 165).
   *
   * **First, and in the order of the tabs.** For an item that is in every Inbox
   * at once, which Inbox it should be in is the question actually being asked,
   * and the panels below are the answer to a longer one. The tab order rather
   * than any other, because a second arrangement of the same workspaces is a
   * second thing to learn.
   */
  inboxesOf?: readonly Workspace[];
  /** The dashboard being looked at, or null on a screen that is not one. */
  openDashboardId: string | null;
  /** Panel ids, most recently filed into first. */
  recent: readonly string[];
  open: boolean;
  /** The chosen target: a panel, or the Inbox of one of the workspaces. */
  onPick: (target: MoveTarget) => void;
  onCancel: () => void;
  /** Why the last choice did not happen, if it did not. */
  refusal?: string | null;
  /** True while a choice is being sent, so it cannot be sent twice. */
  busy?: boolean;
  returnFocusTo?: HTMLElement | null;
}) {
  const [query, setQuery] = useState('');
  /** The dashboard a new panel is being named under, and the name so far. One at a time. */
  const [naming, setNaming] = useState<{ dashboardId: string; name: string } | null>(null);
  /** Why the panel could not be made, said under the field and gone once the name is edited. */
  const [namingRefusal, setNamingRefusal] = useState<string | null>(null);
  /** That the panel is being made, so Add cannot send it twice. A ref as well, which a second press in the same tick reads. */
  const [making, setMaking] = useState(false);
  const makingNow = useRef(false);
  const fieldRef = useRef<HTMLFormElement>(null);
  const addButtons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (open) {
      setQuery('');
      setNaming(null);
      setNamingRefusal(null);
    }
  }, [open]);

  const closeField = () => {
    const was = naming;
    setNaming(null);
    setNamingRefusal(null);
    // Back on the control that opened it, so Escape does not drop the focus on the page behind.
    if (was) addButtons.current.get(was.dashboardId)?.focus();
  };

  /**
   * Makes the panel, then files into it: the two commands in sequence, so a
   * filing that is refused leaves the panel standing. The panel's id is handed
   * to the pick, whose own wording names it - the caller knows the name because
   * it made the panel (ItemList), which is what the POC's toast got wrong.
   */
  const addAndPick = async () => {
    if (!naming || !onAddPanel || makingNow.current) return;
    const name = naming.name.trim();
    if (!name) return;
    makingNow.current = true;
    setMaking(true);
    setNamingRefusal(null);
    let panelId: string;
    try {
      panelId = await onAddPanel(naming.dashboardId, name);
    } catch (error) {
      setNamingRefusal(refusalFrom({ error }));
      makingNow.current = false;
      setMaking(false);
      return;
    }
    makingNow.current = false;
    setMaking(false);
    setNaming(null);
    onPick({ panel: panelId });
  };
  const what =
    'title' in moving
      ? `“${moving.title}”`
      : `${moving.several} ${moving.several === 1 ? 'item' : 'items'}`;
  // **Only the panels that take items**, which is every panel except one made
  // of text ("Put a panel of text on a dashboard, and write in it", issue 250):
  // an item filed onto one of those would leave the Inbox and be drawn nowhere.
  // Filtered once, here, so the tree below and the recent list above it cannot
  // come to disagree - and so the three call sites that hand this its panels
  // cannot each forget separately.
  const takesItems = panels.filter(panelTakesItems);
  const pointless = new Set(alreadyOn && (adding || alreadyOn.length === 1) ? alreadyOn : []);
  const offerable = takesItems.filter((panel) => !pointless.has(panel.id));
  const needle = query.trim().toLowerCase();
  const matches = (text: string) => needle === '' || text.toLowerCase().includes(needle);
  /** Where a panel can be made from here: not on a dashboard filtered in this browser, where + Panel is locked. */
  const canAddTo = (dashboard: Dashboard) =>
    onAddPanel !== undefined && !filteredDashboardIds?.has(dashboard.id);
  const groups = dashboardsInOrder(dashboards, openDashboardId)
    .map((dashboard) => ({
      dashboard,
      hasNone: !takesItems.some((panel) => panel.dashboardId === dashboard.id),
      panels: offerable.filter(
        (panel) =>
          panel.dashboardId === dashboard.id && (matches(dashboard.name) || matches(panel.name)),
      ),
    }))
    // A heading with nothing under it stays to say the dashboard has no panels
    // at all, and - where a panel can be made on it - for one whose panels are
    // all left out, so the way to make one is still there. Not for panels
    // merely unmatched by a search.
    .filter(
      (group) =>
        group.panels.length > 0 ||
        ((group.hasNone || canAddTo(group.dashboard)) && matches(group.dashboard.name)),
    );
  const recentPanels =
    needle === ''
      ? recent
          .map((panelId) => offerable.find((panel) => panel.id === panelId))
          .filter((panel): panel is Panel => panel !== undefined)
      : [];
  const workspaceInboxes = !adding && inboxesOf ? inboxesOf.filter((w) => matches(w.name)) : [];
  const plainInbox =
    !adding && !inboxesOf && matches(INBOX) && !(alreadyOn && alreadyOn.length === 0);
  const nothing = !plainInbox && workspaceInboxes.length === 0 && groups.length === 0;

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Only the places an item can go. The + that makes a panel, and the buttons of
  // its field, are not among them: Enter and the arrows from the search must
  // never make anything.
  const targets = () => [
    ...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-target]:not(:disabled)') ??
      []),
  ];
  const [openedHeight, setOpenedHeight] = useState<number | null>(null);
  const contentRef = useCallback((node: HTMLDivElement | null) => {
    setOpenedHeight(node ? node.getBoundingClientRect().height : null);
  }, []);

  return (
    // **Not closeable while a choice is in flight.** Cancelling resets the
    // change that is still running, so a move that goes on to happen loses the
    // handling that follows it - the panel is not remembered as a recent one
    // and no way back is offered. Escape and a press outside come through here
    // as well as the button, which is why the guard is on the root rather than
    // only on the control.
    <Dialog.Root
      open={open}
      onOpenChange={(nowOpen) => !nowOpen && !busy && !making && onCancel()}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-shade/30" />
        <Dialog.Content
          ref={contentRef}
          // Escape in the name field closes the field and leaves the picker.
          // Radix listens on the document before the field's own handler could
          // stop it, so it is told here not to dismiss. Nothing closes while the
          // panel is being made, since the filing would follow it regardless.
          onEscapeKeyDown={(event) => {
            if (naming && fieldRef.current?.contains(event.target as Node | null)) {
              event.preventDefault();
              if (!makingNow.current) closeField();
            }
          }}
          style={openedHeight ? { minHeight: openedHeight } : undefined}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          // Centred, but tall enough to reach both ends of a phone when the
          // list is long, so the height it may grow to is measured inside the
          // screen's own edges - twice the larger of them, for the reason the
          // item's form gives (ItemForm.tsx, and styles.css for the edges).
          className="fixed z-floating left-1/2 top-1/2 flex max-h-[min(32rem,calc(100vh_-_2rem_-_2_*_max(var(--edge-top),var(--edge-bottom))))] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-shade/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold">
            {adding ? `Also show ${what} on` : `Move ${what} to`}
          </Dialog.Title>

          {refusal && (
            <p role="alert" className="pt-3 text-sm text-over">
              {refusal}
            </p>
          )}

          <input
            ref={inputRef}
            type="search"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                targets()[0]?.click();
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                targets()[0]?.focus();
              }
            }}
            placeholder="Find a panel or dashboard…"
            aria-label="Find a panel or dashboard"
            className="mt-4 w-full rounded-md border border-shade/15 bg-white px-3 py-2 text-sm placeholder:text-ink-faint focus:border-accent focus:outline-none"
          />

          {/* Its own scroller rather than the dialog growing: a workspace with
              six dashboards of panels is a list longer than any screen, and a
              dialog taller than the window has a Cancel nobody can reach. */}
          <div
            ref={listRef}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              const all = targets();
              const at = all.indexOf(document.activeElement as HTMLButtonElement);
              if (at < 0) return;
              event.preventDefault();
              const next = all[at + (event.key === 'ArrowDown' ? 1 : -1)];
              if (next) next.focus();
              else if (event.key === 'ArrowUp') inputRef.current?.focus();
            }}
            className="-mx-1 mt-3 min-h-0 flex-1 overflow-y-auto px-1 pb-1 [scrollbar-width:thin]"
          >
            {nothing && (
              <p className="px-2 py-3 text-sm text-ink-faint">
                {needle === '' ? 'Nowhere else to put it.' : `Nothing called “${query.trim()}”.`}
              </p>
            )}

            {workspaceInboxes.length > 0 && (
              <Group title="Workspaces">
                {workspaceInboxes.map((workspace) => (
                  <Target
                    key={workspace.id}
                    label={workspace.name}
                    hint={workspace.id === workspaceId ? 'the one you are in' : undefined}
                    busy={busy}
                    onPick={() => onPick({ inboxOf: workspace.id })}
                  />
                ))}
              </Group>
            )}

            {plainInbox && (
              <Target
                label={INBOX}
                hint="off every panel"
                busy={busy}
                onPick={() => onPick({ inboxOf: workspaceId })}
              />
            )}

            {recentPanels.length > 0 && (
              <Group title="Recently used">
                {recentPanels.map((panel) => (
                  <Target
                    key={panel.id}
                    label={panel.name}
                    hint={`on ${nameOfDashboard(dashboards, panel.dashboardId) ?? ''}`}
                    busy={busy}
                    onPick={() => onPick({ panel: panel.id })}
                  />
                ))}
              </Group>
            )}

            {groups.map(({ dashboard, panels: onIt, hasNone }) => (
              <DashboardHeading
                key={dashboard.id}
                name={dashboard.name}
                current={dashboard.id === openDashboardId}
                add={
                  canAddTo(dashboard)
                    ? {
                        open: naming?.dashboardId === dashboard.id,
                        disabled: busy || making,
                        buttonRef: (node) => {
                          if (node) addButtons.current.set(dashboard.id, node);
                          else addButtons.current.delete(dashboard.id);
                        },
                        onToggle: () => {
                          if (naming?.dashboardId === dashboard.id) closeField();
                          else {
                            setNamingRefusal(null);
                            setNaming({ dashboardId: dashboard.id, name: '' });
                          }
                        },
                      }
                    : undefined
                }
              >
                {naming?.dashboardId === dashboard.id && (
                  <form
                    ref={fieldRef}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void addAndPick();
                    }}
                    className="pb-1 pl-7 pr-2"
                  >
                    <div className="flex gap-2">
                      <input
                        value={naming.name}
                        onChange={(event) => {
                          setNaming({ dashboardId: dashboard.id, name: event.target.value });
                          // A refusal is about the name it was given, so editing it ends the refusal.
                          setNamingRefusal(null);
                        }}
                        aria-label={`Name of the new panel on ${dashboard.name}`}
                        placeholder="Name of the new panel"
                        maxLength={60}
                        autoFocus
                        // Told to every password manager that has its own way of
                        // being told: 1Password offered to fill this in.
                        autoComplete="off"
                        data-1p-ignore
                        data-lpignore="true"
                        data-bwignore
                        className="min-w-0 flex-1 rounded-md border border-shade/15 bg-white px-2 py-1 text-sm placeholder:text-ink-faint focus:border-accent focus:outline-none"
                      />
                      <button
                        type="submit"
                        disabled={naming.name.trim() === '' || busy || making}
                        className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
                      >
                        {adding ? 'Add & show' : 'Add & move'}
                      </button>
                    </div>
                    {namingRefusal && (
                      <p role="alert" className="pt-1 text-sm text-over">
                        {namingRefusal}
                      </p>
                    )}
                  </form>
                )}
                {onIt.length === 0 ? (
                  <p className="py-1.5 pl-7 pr-2 text-sm text-ink-faint">
                    {hasNone ? 'No panels yet.' : 'Nowhere else on this dashboard.'}
                  </p>
                ) : (
                  onIt.map((panel) => (
                    <Target
                      key={panel.id}
                      label={panel.name}
                      indent
                      busy={busy}
                      onPick={() => onPick({ panel: panel.id })}
                    />
                  ))
                )}
              </DashboardHeading>
            ))}
          </div>

          <div className="flex justify-end pt-4">
            <Dialog.Close
              disabled={busy}
              className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
            >
              Cancel
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The dashboards, the one being looked at first.
 *
 * The rest keep the order the snapshot gives them, which is the order of the
 * bar across the top: a picker that sorted them some other way would be a
 * second arrangement of the same dashboards to learn.
 */
function dashboardsInOrder(
  dashboards: readonly Dashboard[],
  openDashboardId: string | null,
): Dashboard[] {
  const open = dashboards.find((dashboard) => dashboard.id === openDashboardId);
  if (!open) return [...dashboards];
  return [open, ...dashboards.filter((dashboard) => dashboard.id !== open.id)];
}

function nameOfDashboard(dashboards: readonly Dashboard[], dashboardId: string): string | undefined {
  return dashboards.find((dashboard) => dashboard.id === dashboardId)?.name;
}

/** A dashboard's heading, pinned while its panels scroll past. */
function DashboardHeading({
  name,
  current,
  add,
  children,
}: {
  name: string;
  current: boolean;
  /** The + that makes a panel on this dashboard; absent where one cannot be made. */
  add:
    | {
        open: boolean;
        disabled: boolean;
        buttonRef: (node: HTMLButtonElement | null) => void;
        onToggle: () => void;
      }
    | undefined;
  children: React.ReactNode;
}) {
  const square = (x: number, y: number) => (
    <rect x={x} y={y} width="5.5" height="5.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
  );
  return (
    <section className="mt-3 border-t border-shade/10">
      {/* The + sits beside the heading rather than in it, so it is not part of
          the heading's name. */}
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface px-2 pb-1 pt-3">
        <h3 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-ink">
          <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0 text-ink-soft">
            {square(1.5, 1.5)}
            {square(9, 1.5)}
            {square(1.5, 9)}
            {square(9, 9)}
          </svg>
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {current && (
            <span className="shrink-0 text-xs font-normal text-ink-faint">this dashboard</span>
          )}
        </h3>
        {add && (
          <button
            type="button"
            ref={add.buttonRef}
            disabled={add.disabled}
            onClick={add.onToggle}
            aria-expanded={add.open}
            aria-label={add.open ? `Do not add a panel to ${name}` : `Add a panel to ${name}`}
            className="flex size-6 shrink-0 items-center justify-center rounded text-base leading-none text-ink-soft hover:bg-accent-tint hover:text-accent-deep focus-visible:bg-accent-tint focus-visible:outline-none disabled:opacity-50"
          >
            {add.open ? '×' : '+'}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pt-3">
      <h3 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * One place an item can go.
 *
 * A button rather than a row with a button in it, so the whole target is the
 * hit area — the same reason a panel is the drop target while only its header
 * is the handle.
 */
function Target({
  label,
  hint,
  indent = false,
  busy,
  onPick,
}: {
  label: string;
  /** Under a dashboard's heading rather than beside it. */
  indent?: boolean;
  /** Which dashboard it is on, where the list does not already say. */
  hint?: string | undefined;
  busy: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      data-target
      disabled={busy}
      onClick={onPick}
      className={`flex w-full items-baseline gap-2 rounded py-1.5 pr-2 text-left text-sm text-ink hover:bg-accent-tint hover:text-accent-deep focus-visible:bg-accent-tint focus-visible:text-accent-deep focus-visible:outline-none disabled:opacity-50 ${indent ? 'pl-7' : 'pl-2'}`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-xs text-ink-faint">{hint}</span>}
    </button>
  );
}

export default MoveToPicker;
