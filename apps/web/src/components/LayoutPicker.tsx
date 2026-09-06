import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { uuidv7 } from '@cockpit/shared';
import type { Layout, Panel } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { useCommand } from '../api/queries';
import { browserStore } from '../lastVisited';
import { AUTOMATIC, useChosenLayout } from '../panels/chosenLayout';
import {
  drawnRows,
  freeName,
  layoutLabel,
  layoutToDraw,
  nameForScreen,
} from '../panels/arrangement';
import { useScreenWidth } from '../panels/useScreenWidth';
import { DeleteQuestion } from './DeleteQuestion';
import { MenuContent, menuItemClass } from './Menu';
import { NameQuestion } from './NameQuestion';

/**
 * Why the only layout cannot go, said once so the entry a person reads and the
 * label a screen reader announces are the same string.
 */
const KEEPS_ONE = 'A dashboard keeps at least one layout';

/**
 * What the control is called to anything not looking at it: which layout is in
 * use, and whether it was picked or arrived automatically - the two things the
 * button says in type.
 */
function announced(drawnWith: Layout | null, automatic: boolean): string {
  const which = drawnWith ? layoutLabel(drawnWith) : 'none yet';
  return `Layout for this dashboard: ${which}${automatic ? ', chosen automatically' : ''}`;
}

/**
 * Which arrangement of this dashboard you are looking at, said out loud and
 * changed here ("Pick the layout you are on, by name").
 *
 * **A layout used to be a side effect.** There was none until your first drag
 * made one; it was called *Made for 1463 px*; the app picked one by comparing
 * that number to your screen; and because the guess could be wrong, every drag
 * on a screen the layout was not made for stopped to ask which layout to keep
 * the change in. Nobody could tell which arrangement they were in, and the
 * question, the width-shaped names and the menu at the foot of the board were
 * all compensation for that. Naming a layout and picking it by name removes all
 * three: the control below says what you are on, and changing the arrangement
 * changes it.
 *
 * **In the dashboard's own bar rather than under the board**, because that is
 * the one place on screen that is about *this dashboard* and nothing else - and
 * it is beside the tab whose arrangement it names. The bar is drawn on the
 * Inbox too, where there is no dashboard to have a layout, so the shell only
 * mounts this where there is one (DashboardBar).
 *
 * **Automatic is an entry, not the absence of one.** It draws the layout whose
 * recorded width is closest to this screen - which is what the app always did
 * and never said - and the control shows both that it is on and which layout it
 * landed on.
 */
export function LayoutPicker({
  workspaceId,
  dashboardId,
  layouts,
  panels,
}: {
  workspaceId: string;
  dashboardId: string;
  /** Every layout of this dashboard, which is what the menu lists. */
  layouts: readonly Layout[];
  /** This dashboard's panels, which a layout made from nothing has to arrange. */
  panels: readonly Panel[];
}) {
  const screenWidth = useScreenWidth();
  const command = useCommand();
  const [chosen, choose] = useChosenLayout(browserStore(), dashboardId);
  const drawnWith = layoutToDraw(layouts, dashboardId, screenWidth, chosen);
  /**
   * The choice as it actually took effect, which is not always the one stored.
   *
   * A choice naming a layout another device has since deleted falls through to
   * the closest remaining one (`layoutToDraw`), and deliberately nothing clears
   * the stored id when that happens. So `chosen` can name a layout that is not
   * there while the board draws a different one - and every reading of it here
   * would then be wrong in the same direction: the control would drop the
   * *Auto* badge and announce a hand-picked layout, and the menu's radio group
   * would match neither *Automatic* nor any layout in the list and so mark
   * nothing at all, which is the undifferentiated list this whole control
   * exists to replace.
   *
   * Derived rather than repaired, because a render is not where a write to
   * storage belongs. The dead id is cleared by the board the next time it saves
   * an arrangement (PanelBoard).
   */
  const picked = drawnWith && chosen === drawnWith.id ? chosen : null;

  /**
   * The name being typed, and which question is asking for it - or null while
   * nothing is being named. Held here rather than in the dialog so a refused
   * name survives the answer coming back.
   */
  const [naming, setNaming] = useState<{ what: 'new' | 'rename'; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  /** That the entry just chosen opens something, so the menu must not take the focus back. */
  const opening = useRef(false);

  const refusal =
    command.error instanceof CommandRefused
      ? command.error.message
      : command.error
        ? 'That did not reach the server. Try again.'
        : null;

  /** The refusal belongs to the control that asked for it. */
  const refusalFor = (what: 'save_layout' | 'rename_layout' | 'delete_layout') =>
    refusal && command.variables?.name === what ? refusal : null;

  const opens = (open: () => void) => () => {
    command.reset();
    opening.current = true;
    open();
  };

  /**
   * A layout made from what is on screen.
   *
   * **From the drawn layout's own placements where there is one**, which is what
   * *from this one* means: the new layout starts as a copy and diverges from
   * the first thing you move.
   *
   * With no layout at all it is the panels fitted to the screen, which is what
   * such a dashboard is already drawn with - close but not exact, because how
   * many fit across is decided by the width the *panels* have and the Inbox
   * takes about a fifth of it (PanelBoard). The board redraws it within the
   * grid either way, and the first drag records the truth; getting it exact
   * here would mean the bar knowing how wide the sheet beside it is.
   */
  const createLayout = () => {
    if (!naming) return;
    const name = naming.name.trim();
    if (!name) return;
    // The arrangement as it is *drawn*, not the one stored: `drawnRows`
    // is what reconciles a layout against the panels beside it, dropping one it
    // still names that is no longer there and appending one it has never heard
    // of. Copying the stored list instead would make "from this one" a copy of
    // something nobody is looking at - and a placement naming a panel that has
    // gone is refused outright by the server.
    const rows = drawnRows(drawnWith, panels, screenWidth);
    const layoutId = uuidv7();
    command.mutate(
      {
        name: 'save_layout',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          dashboardId,
          layoutId,
          name,
          screenWidth,
          rows: rows.map((row) => ({
            height: row.height,
            cells: row.cells.map((cell) => ({ panelId: cell.panelId, span: cell.span })),
          })),
        },
      },
      {
        onSuccess: () => {
          // You are put on the layout you just made: making one and then having
          // to pick it is two gestures for what reads as one.
          choose(layoutId);
          setNaming(null);
        },
      },
    );
  };

  const renameLayout = () => {
    if (!naming || !drawnWith) return;
    const name = naming.name.trim();
    if (!name) return;
    command.mutate(
      {
        name: 'rename_layout',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          layoutId: drawnWith.id,
          name,
        },
      },
      { onSuccess: () => setNaming(null) },
    );
  };

  const deleteLayout = () => {
    if (!drawnWith) return;
    command.mutate(
      {
        name: 'delete_layout',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          layoutId: drawnWith.id,
        },
      },
      {
        onSuccess: () => {
          // The choice goes with the layout. Leaving it would only fall through
          // to the closest remaining one anyway (arrangement.ts), but a stored
          // id naming nothing is a thing to explain later rather than now.
          if (chosen === drawnWith.id) choose(null);
          setDeleting(false);
        },
      },
    );
  };

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          ref={trigger}
          // The name carries the value, not just the control: a label of
          // "Layout for this dashboard" alone tells a screen reader that there
          // is one and never which, and which is the whole point of it.
          aria-label={announced(drawnWith, picked === null)}
          // On the chrome, so it takes the chrome's light set rather than the
          // ink and accent tint every control on the sheet wears - both of
          // which are invisible on a near-black bar (Menu.tsx says why this is
          // a set rather than a class).
          className="mb-1 flex max-w-52 shrink-0 items-center gap-1.5 rounded-md border border-white/15 bg-white/6 px-2 py-1 text-xs text-chrome-ink hover:bg-white/12 focus-visible:outline-2 focus-visible:outline-chrome-ink-soft data-[state=open]:bg-white/12"
        >
          {/* Which of the two ways you are on it, where you are on it that way.
              It is the one thing the old menu could not say, and it is why the
              automatic choice used to feel like magic. */}
          {picked === null && (
            <span className="shrink-0 text-[0.625rem] font-semibold uppercase tracking-[0.09em] text-[var(--tint)]">
              Auto
            </span>
          )}
          <span className="truncate">{drawnWith ? layoutLabel(drawnWith) : 'No layout yet'}</span>
          <svg viewBox="0 0 10 6" className="size-2 shrink-0" aria-hidden="true">
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </DropdownMenu.Trigger>

        <MenuContent
          onCloseAutoFocus={(event) => {
            const claimed = opening.current;
            opening.current = false;
            if (claimed) event.preventDefault();
          }}
        >
          <DropdownMenu.Label className="px-2 py-1 text-xs text-ink-faint">
            Layout for this dashboard
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={picked ?? AUTOMATIC}
            onValueChange={(value) => choose(value === AUTOMATIC ? null : value)}
          >
            <Chosen value={AUTOMATIC} name="Automatic">
              {/* Which one it lands on, so choosing it is not a leap. */}
              {drawnWith && `now ${layoutLabel(drawnWith)}`}
            </Chosen>
            {layouts.map((layout) => (
              <Chosen key={layout.id} value={layout.id} name={layoutLabel(layout)}>
                {/* The width is still worth saying - it is what Automatic
                    compares - but as a note under the name rather than as the
                    name itself. */}
                {`made at ${layout.screenWidth} px`}
              </Chosen>
            ))}
          </DropdownMenu.RadioGroup>

          <DropdownMenu.Separator className="my-1 h-px bg-black/10" />
          <DropdownMenu.Item
            className={menuItemClass}
            onSelect={opens(() =>
              setNaming({
                what: 'new',
                // Offered rather than imposed, and free on this dashboard so
                // the commonest press is not met with a name collision.
                name: freeName(layouts, nameForScreen(screenWidth)),
              }),
            )}
          >
            {drawnWith ? 'New layout from this one…' : 'New layout…'}
          </DropdownMenu.Item>
          {drawnWith && (
            <>
              <DropdownMenu.Item
                className={menuItemClass}
                onSelect={opens(() => setNaming({ what: 'rename', name: layoutLabel(drawnWith) }))}
              >
                {`Rename ${layoutLabel(drawnWith)}…`}
              </DropdownMenu.Item>
              {/* Unavailable and saying why, rather than offered and then
                  refused - the same shape the last dashboard's entry takes. */}
              {layouts.length === 1 ? (
                <DropdownMenu.Item
                  disabled
                  className={`${menuItemClass} text-ink-faint data-[highlighted]:bg-black/5 data-[highlighted]:text-ink-faint`}
                  aria-label={`Delete ${layoutLabel(drawnWith)}: ${KEEPS_ONE}`}
                >
                  {`Delete ${layoutLabel(drawnWith)}`}
                  <span className="block text-xs">{KEEPS_ONE}</span>
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item
                  className={`${menuItemClass} text-over data-[highlighted]:bg-over/10 data-[highlighted]:text-over`}
                  onSelect={opens(() => setDeleting(true))}
                >
                  {`Delete ${layoutLabel(drawnWith)}`}
                </DropdownMenu.Item>
              )}
            </>
          )}
        </MenuContent>
      </DropdownMenu.Root>

      {/* Mounted whether or not it is open, unlike the delete question below:
          a dialog torn out from above is never told it closed, so it never
          gets to put the focus back on the control it was opened from. */}
      <NameQuestion
        open={naming !== null}
        question={naming?.what === 'rename' ? 'What is this layout called?' : 'What is the new layout called?'}
        fieldLabel={naming?.what === 'rename' ? 'New name for this layout' : 'Name of the new layout'}
        placeholder="Wide, Laptop, Phone…"
        submitLabel={naming?.what === 'rename' ? 'Rename' : 'Create'}
        name={naming?.name ?? ''}
        onNameChange={(name) => setNaming((was) => (was ? { ...was, name } : was))}
        onSubmit={naming?.what === 'rename' ? renameLayout : createLayout}
        onCancel={() => {
          setNaming(null);
          command.reset();
        }}
        refusal={refusalFor(naming?.what === 'rename' ? 'rename_layout' : 'save_layout')}
        // This question's own, not the picker's: the dialog will not close while
        // it is busy, so a delete still in flight would leave a form nobody can
        // get out of.
        busy={
          command.isPending &&
          (command.variables?.name === 'save_layout' ||
            command.variables?.name === 'rename_layout')
        }
        returnFocusTo={trigger.current}
      />

      {deleting && drawnWith && (
        <DeleteQuestion
          open
          question={`Delete ${layoutLabel(drawnWith)}? The panels stay; what goes is this way of arranging them.`}
          confirmLabel={`Yes, delete ${layoutLabel(drawnWith)}`}
          canConfirm={!command.isPending}
          refusal={refusalFor('delete_layout')}
          returnFocusTo={trigger.current}
          onCancel={() => {
            setDeleting(false);
            command.reset();
          }}
          onConfirm={deleteLayout}
        />
      )}
    </>
  );
}

/**
 * One entry of the layout menu, with a mark against the one in use.
 *
 * **The mark is the whole reason this is a component.** Radix knows which
 * `RadioItem` is checked and renders nothing to say so, so the menu opened
 * without one listed every layout identically - which is the fault this feature
 * exists to fix, one menu deeper. `ItemIndicator` draws only in the checked
 * item; the column it sits in is always there, so the names line up whichever
 * one is marked.
 */
function Chosen({
  value,
  name,
  children,
}: {
  value: string;
  name: string;
  /** The line under the name: what Automatic lands on, or the width it was made at. */
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu.RadioItem value={value} className={`${menuItemClass} flex items-start gap-2`}>
      <span className="flex w-3 shrink-0 justify-center pt-1.5">
        <DropdownMenu.ItemIndicator>
          <span className="block size-1.5 rounded-full bg-accent" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className="min-w-0">
        {name}
        {children && <span className="block text-xs text-ink-faint">{children}</span>}
      </span>
    </DropdownMenu.RadioItem>
  );
}
