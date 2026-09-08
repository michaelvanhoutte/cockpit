import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { nearestScreenSize, uuidv7 } from '@cockpit/shared';
import type { Layout, Panel, ScreenSize } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { useCommand } from '../api/queries';
import { browserStore } from '../lastVisited';
import { useChosenLayout } from '../panels/chosenLayout';
import { drawnRows, layoutToDraw, layoutsOf } from '../panels/arrangement';
import { useScreenWidth } from '../panels/useScreenWidth';
import { DeleteQuestion } from './DeleteQuestion';
import { MenuContent, menuItemClass } from './Menu';
import { NameQuestion } from './NameQuestion';

/**
 * Which arrangement of this dashboard you are looking at, said out loud and
 * changed here ("Pick the layout you are on, by name"; "Draw a dashboard
 * against the screen sizes its account has", issue 263).
 *
 * **A screen size is the account's; a Dashboard defines a Layout at the ones
 * it wants.** The menu is two groups and then the verbs: what this Dashboard
 * *is* - the sizes it has defined, one of them marked as the one drawn - and
 * what you can *do* - define a Layout at a size it has not, make a new size,
 * rename or remove the one in use, or delete it for every Dashboard that has
 * one.
 *
 * **In the dashboard's own bar rather than under the board**, because that is
 * the one place on screen that is about *this dashboard* and nothing else - and
 * it is beside the tab whose arrangement it names. The bar is drawn on the
 * Inbox too, where there is no dashboard to have a layout, so the shell only
 * mounts this where there is one (DashboardBar).
 */
export function LayoutPicker({
  workspaceId,
  dashboardId,
  layouts,
  screenSizes,
  panels,
}: {
  workspaceId: string;
  dashboardId: string;
  /** Every layout of this dashboard, which is what says which sizes it has defined. */
  layouts: readonly Layout[];
  /** Every screen size the account has, whether or not this dashboard has defined one at it. */
  screenSizes: readonly ScreenSize[];
  /** This dashboard's panels, which a layout made from nothing has to arrange. */
  panels: readonly Panel[];
}) {
  const screenWidth = useScreenWidth();
  const command = useCommand();
  const [pick, choose] = useChosenLayout(browserStore());
  const drawnWith = layoutToDraw(layouts, screenSizes, dashboardId, screenWidth, pick);
  /** The app's own answer for this screen, which a pick overrides while it lasts. */
  const nearest = nearestScreenSize(screenSizes, screenWidth);
  /** The screen size the layout on screen is drawn for, or null with nothing drawn. */
  const drawnSize = drawnWith
    ? (screenSizes.find((size) => size.id === drawnWith.screenSizeId) ?? null)
    : null;

  const definedIds = new Set(
    layoutsOf(layouts, dashboardId)
      .map((layout) => layout.screenSizeId)
      .filter((id): id is string => id !== null),
  );
  /** The sizes this dashboard has a layout at, in the account's own order. */
  const defined = screenSizes.filter((size) => definedIds.has(size.id));
  /** The sizes the account has that this dashboard has not defined - actions, not choices. */
  const undefinedSizes = screenSizes.filter((size) => !definedIds.has(size.id));

  /**
   * Picking a defined size from the menu, scoped to the screen you are on.
   *
   * What the pick records is the answer it is overriding rather than a width,
   * so it expires when that answer changes and not before (`ScreenSizePick`).
   * The size you press is stored even where it is already the one drawn: that
   * is what lets pressing it clear a pick standing on a different size, which
   * is how you get back to the screen's own answer without leaving the menu.
   */
  const pickFromMenu = (screenSizeId: string) =>
    choose({ screenSizeId, whileNearestIs: nearest?.id ?? screenSizeId });

  /**
   * The name being typed, and which question is asking for it - or null while
   * nothing is being named. Held here rather than in the dialog so a refused
   * name survives the answer coming back.
   */
  const [naming, setNaming] = useState<{ what: 'newSize' | 'renameSize'; name: string } | null>(
    null,
  );
  /** The undefined size a "Define a layout for X" question is asking about. */
  const [defining, setDefining] = useState<ScreenSize | null>(null);
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
  const refusalFor = (
    what: 'save_layout' | 'create_screen_size' | 'rename_screen_size' | 'delete_layout' | 'delete_screen_size',
  ) => (refusal && command.variables?.name === what ? refusal : null);

  const opens = (open: () => void) => () => {
    command.reset();
    opening.current = true;
    open();
  };

  /**
   * The arrangement a new Layout starts as - a copy of what is drawn, whether
   * that is a Layout or the screen fitted for nothing ("Defining a layout at a
   * size copies what is drawn").
   */
  const copyOfWhatIsDrawn = () =>
    drawnRows(drawnWith, panels, screenWidth).map((row) => ({
      height: row.height,
      cells: row.cells.map((cell) => ({ panelId: cell.panelId, span: cell.span })),
    }));

  /** Defining a layout at a size this dashboard does not have one at yet. */
  const defineLayout = () => {
    if (!defining) return;
    const target = defining;
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
          name: target.name,
          screenWidth,
          screenSizeId: target.id,
          rows: copyOfWhatIsDrawn(),
        },
      },
      {
        onSuccess: () => {
          // Put on the size you just defined, on *this* screen only - the
          // same reason making a layout used to put you on it.
          choose({ screenSizeId: target.id, whileNearestIs: nearest?.id ?? target.id });
          setDefining(null);
        },
      },
    );
  };

  /**
   * A screen size the account did not have, made and immediately defined here
   * - two commands sent one after the other, since a size is made before
   * anything can be defined at it.
   */
  const createSizeAndDefine = () => {
    if (!naming) return;
    const name = naming.name.trim();
    if (!name) return;
    const screenSizeId = uuidv7();
    command.mutate(
      {
        name: 'create_screen_size',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          screenSizeId,
          name,
          width: screenWidth,
        },
      },
      {
        onSuccess: () => {
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
                screenSizeId,
                rows: copyOfWhatIsDrawn(),
              },
            },
            {
              onSuccess: () => {
                // Not `nearest`: that was read against the account's sizes
                // before this one joined them, so it can go on naming this
                // size long after some other screen has genuinely taken over
                // - a pick that never expires. A size already at this exact
                // width is what the new one ties with, the same rule an
                // existing size overrides it with; short of a tie, the size
                // just made is its own nearest answer here, which is what
                // lets a real move to another screen already in the account's
                // list expire it correctly.
                const tie = screenSizes.find((size) => size.width === screenWidth);
                choose({ screenSizeId, whileNearestIs: tie?.id ?? screenSizeId });
                setNaming(null);
              },
            },
          );
        },
      },
    );
  };

  const renameSize = () => {
    if (!naming || !drawnSize) return;
    const name = naming.name.trim();
    if (!name) return;
    command.mutate(
      {
        name: 'rename_screen_size',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          screenSizeId: drawnSize.id,
          name,
        },
      },
      { onSuccess: () => setNaming(null) },
    );
  };

  /**
   * Removing this dashboard's layout at the size in use - one press, with no
   * dialog of its own, and unlike deleting a Layout used to be, always
   * allowed: having none left is a normal state now.
   *
   * The pick is left alone rather than cleared: a pick naming a size this
   * dashboard no longer has a layout at is simply inert here, exactly as one
   * naming a size it never had is (`layoutToDraw`).
   */
  const removeLayout = () => {
    if (!drawnWith) return;
    command.mutate({
      name: 'delete_layout',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        layoutId: drawnWith.id,
      },
    });
  };

  const deleteEverywhere = () => {
    if (!drawnSize) return;
    command.mutate(
      {
        name: 'delete_screen_size',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          screenSizeId: drawnSize.id,
        },
      },
      { onSuccess: () => setDeleting(false) },
    );
  };

  return (
    <>
      <div className="relative">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            ref={trigger}
            // The name carries the value, not just the control: a label of
            // "Layout for this dashboard" alone tells a screen reader that
            // there is one and never which, and which is the whole point of
            // it.
            aria-label={`Layout for this dashboard: ${drawnSize ? drawnSize.name : 'no layout'}`}
            // On the chrome, so it takes the chrome's light set rather than the
            // ink and accent tint every control on the sheet wears - both of
            // which are invisible on a near-black bar (Menu.tsx says why this is
            // a set rather than a class).
            className="mb-1 flex max-w-52 shrink-0 items-center gap-1.5 rounded-md border border-white/15 bg-white/6 px-2 py-1 text-xs text-chrome-ink hover:bg-white/12 focus-visible:outline-2 focus-visible:outline-chrome-ink-soft data-[state=open]:bg-white/12"
          >
            <span className="truncate">{drawnSize ? drawnSize.name : 'No layout'}</span>
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
            {/* Marked against the size actually drawn rather than against what
                is stored, which is not the same thing and is why this reads
                `drawnSize`: a pick expires by itself when you change screens,
                and one naming a size this dashboard does not have falls
                through (`layoutToDraw`). Either way the stored id would mark
                nothing at all here. */}
            <DropdownMenu.RadioGroup value={drawnSize?.id ?? ''} onValueChange={pickFromMenu}>
              {defined.map((size) => (
                <Chosen key={size.id} value={size.id} name={size.name}>
                  {`${size.width} px`}
                </Chosen>
              ))}
            </DropdownMenu.RadioGroup>

            {undefinedSizes.length > 0 && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-black/10" />
                <DropdownMenu.Label className="px-2 py-1 text-xs text-ink-faint">
                  Define a layout for
                </DropdownMenu.Label>
                {undefinedSizes.map((size) => (
                  <DropdownMenu.Item
                    key={size.id}
                    className={`${menuItemClass} flex items-start gap-2`}
                    onSelect={opens(() => setDefining(size))}
                  >
                    <span className="w-3 shrink-0" aria-hidden="true" />
                    <span className="min-w-0">
                      {size.name}
                      <span className="block text-xs text-ink-faint">{`${size.width} px`}</span>
                    </span>
                  </DropdownMenu.Item>
                ))}
              </>
            )}

            <DropdownMenu.Separator className="my-1 h-px bg-black/10" />
            <DropdownMenu.Item
              className={menuItemClass}
              onSelect={opens(() => setNaming({ what: 'newSize', name: '' }))}
            >
              New screen size…
            </DropdownMenu.Item>
            {drawnSize && (
              <>
                <DropdownMenu.Item
                  className={menuItemClass}
                  onSelect={opens(() => setNaming({ what: 'renameSize', name: drawnSize.name }))}
                >
                  {`Rename ${drawnSize.name}…`}
                </DropdownMenu.Item>
                <DropdownMenu.Item className={menuItemClass} onSelect={opens(removeLayout)}>
                  {`Remove this dashboard's ${drawnSize.name} layout`}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={`${menuItemClass} text-over data-[highlighted]:bg-over/10 data-[highlighted]:text-over`}
                  onSelect={opens(() => setDeleting(true))}
                >
                  {`Delete ${drawnSize.name} everywhere`}
                </DropdownMenu.Item>
              </>
            )}
          </MenuContent>
        </DropdownMenu.Root>

        {/* A one-press action from the menu has no dialog of its own to
            report a refusal in, so it lands here instead - the one place on
            screen that is already about this control. */}
        {refusalFor('delete_layout') && (
          <p role="alert" className="absolute left-0 top-full z-10 pt-1 text-xs text-over">
            {refusalFor('delete_layout')}
          </p>
        )}
      </div>

      {/* Mounted whether or not it is open, unlike the delete question below:
          a dialog torn out from above is never told it closed, so it never
          gets to put the focus back on the control it was opened from. */}
      <NameQuestion
        open={naming !== null}
        question={naming?.what === 'renameSize' ? 'What is this screen size called?' : 'What is the new screen size called?'}
        fieldLabel={naming?.what === 'renameSize' ? 'New name for this screen size' : 'Name of the new screen size'}
        placeholder="Wide, Laptop, Phone…"
        submitLabel={naming?.what === 'renameSize' ? 'Rename' : 'Create'}
        name={naming?.name ?? ''}
        onNameChange={(name) => setNaming((was) => (was ? { ...was, name } : was))}
        onSubmit={naming?.what === 'renameSize' ? renameSize : createSizeAndDefine}
        onCancel={() => {
          setNaming(null);
          command.reset();
        }}
        refusal={
          naming?.what === 'renameSize'
            ? refusalFor('rename_screen_size')
            : (refusalFor('create_screen_size') ?? refusalFor('save_layout'))
        }
        // This question's own, not the picker's: the dialog will not close while
        // it is busy, so a delete still in flight would leave a form nobody can
        // get out of.
        busy={
          command.isPending &&
          (command.variables?.name === 'save_layout' ||
            command.variables?.name === 'create_screen_size' ||
            command.variables?.name === 'rename_screen_size')
        }
        returnFocusTo={trigger.current}
      />

      {defining && (
        <DeleteQuestion
          open
          question={`Give this dashboard its own layout for ${defining.name}? It starts as a copy of ${
            drawnSize ? drawnSize.name : 'what is fitted to the screen'
          }.`}
          confirmLabel={`Yes, define ${defining.name}`}
          confirmText={`Yes, define ${defining.name}`}
          variant="affirmative"
          canConfirm={!command.isPending}
          refusal={refusalFor('save_layout')}
          returnFocusTo={trigger.current}
          onCancel={() => {
            setDefining(null);
            command.reset();
          }}
          onConfirm={defineLayout}
        />
      )}

      {deleting && drawnSize && (
        <DeleteQuestion
          open
          question={`Delete ${drawnSize.name} everywhere? Every dashboard's ${drawnSize.name} layout goes with it, in every workspace.`}
          confirmLabel={`Yes, delete ${drawnSize.name} everywhere`}
          canConfirm={!command.isPending}
          refusal={refusalFor('delete_screen_size')}
          returnFocusTo={trigger.current}
          onCancel={() => {
            setDeleting(false);
            command.reset();
          }}
          onConfirm={deleteEverywhere}
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
 * without one listed every size identically - which is the fault this feature
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
  /** The line under the name: the width the size is matched against. */
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
