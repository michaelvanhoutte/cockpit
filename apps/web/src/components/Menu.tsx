import { useRef } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

/**
 * The control that opens a menu, wherever a menu is opened ("Open every menu
 * from the same control", issue 115).
 *
 * **Three dots always mean a menu opens here.** Before this, the header's was a
 * bordered pill, an item row's was faint and unbordered, and the one at the
 * right of the dashboard bar was not a menu at all - it was a link to a
 * settings page wearing a menu's clothes. Same glyph, three meanings,
 * and the next feature would have added a fourth: the functional definition's
 * "Dashboards and Panels" promises every Panel a menu of its own.
 *
 * **Vertical, and drawn rather than typed.** `···` is a horizontal ellipsis -
 * punctuation, whose size and baseline are the font's to decide, and which
 * reads as an abbreviation rather than as a control. The vertical triplet is
 * what a browser and a phone use for this, and as an icon it is the size this
 * file says it is.
 *
 * One component rather than one class string, so a call site cannot take the
 * look without the behaviour: the trigger carries its own accessible name,
 * which is what the walks and the tests reach for.
 */
export function MenuTrigger({
  label,
  className,
  onChrome = false,
  ref,
}: {
  label: string;
  className?: string;
  /**
   * Whether this one sits on the chrome rather than on the sheet. The chrome is
   * near-black in every theme, so the ink and the accent tint that a menu wears
   * everywhere else are both invisible on it.
   *
   * A flag rather than a class passed in, because the two sets have to replace
   * each other whole: `text-ink-faint` and `text-chrome-ink-faint` are
   * utilities of the same specificity, so which one won would be decided by
   * their order in the generated stylesheet rather than by the call site.
   */
  onChrome?: boolean;
  /** Held where something has to put the focus back on this control afterwards. */
  ref?: React.Ref<HTMLButtonElement>;
}) {
  const colors = onChrome
    ? 'text-chrome-ink-faint hover:bg-white/10 hover:text-chrome-ink focus-visible:outline-chrome-ink-soft data-[state=open]:bg-white/10 data-[state=open]:text-chrome-ink'
    : 'text-ink-faint hover:bg-accent-tint hover:text-accent-deep focus-visible:outline-accent data-[state=open]:bg-accent-tint data-[state=open]:text-accent-deep';
  return (
    <DropdownMenu.Trigger
      ref={ref}
      aria-label={label}
      // 36px, comfortably past the 24px minimum target size and reachable with
      // a thumb, in a bar whose other controls are smaller than that: the
      // control is what has to be hittable, not the text beside it.
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 ${colors}${className ? ` ${className}` : ''}`}
    >
      <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="3.2" r="1.5" />
        <circle cx="8" cy="8" r="1.5" />
        <circle cx="8" cy="12.8" r="1.5" />
      </svg>
    </DropdownMenu.Trigger>
  );
}

/** The panel a menu opens into, portalled so no bar can clip it. */
export function MenuContent({
  children,
  onCloseAutoFocus,
}: {
  children: React.ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align="end"
        sideOffset={4}
        onCloseAutoFocus={onCloseAutoFocus}
        className="min-w-44 rounded-md border border-black/10 bg-surface p-1 shadow-lg"
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

/** One entry. Exported as a class because entries are `asChild` as often as not. */
export const menuItemClass =
  'block cursor-default rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent-tint data-[highlighted]:text-accent-deep';

/** An entry that deletes something, which is the one kind that is coloured. */
const destructiveItemClass = `${menuItemClass} text-over data-[highlighted]:bg-over/10 data-[highlighted]:text-over`;

/**
 * An entry that cannot be chosen. It stays visible, reachable and says why,
 * rather than going - so it still highlights as the focus moves over it, and
 * looks unavailable rather than looking like nothing.
 */
const unavailableItemClass = `${menuItemClass} text-ink-faint data-[highlighted]:bg-black/5 data-[highlighted]:text-ink-faint`;

export interface MenuEntry {
  label: string;
  /**
   * What choosing it does. It is handed the control the menu was opened from,
   * because whatever it opens has to be able to put the focus back there when
   * it closes - a dialog opened this way has no trigger of its own to return
   * to, and dropping the focus to the top of the page is how a keyboard user
   * loses their place in a list.
   */
  onSelect: (openedFrom: HTMLElement | null) => void;
  /**
   * That choosing it opens nothing, so the focus belongs back on the control
   * the menu was opened from.
   *
   * The default is the opposite because most entries open something - a name
   * field, a question - and putting the focus back would take it straight off
   * whatever had just opened. An entry that only *does* a thing has nowhere
   * else for the focus to go, and dropping it to the top of the page is how a
   * keyboard user loses their place in the list - which is worst for exactly
   * the entry that wants choosing several times in a row ("Reorder
   * workspaces", issue 31).
   */
  keepsFocus?: boolean | undefined;
  /** Why this cannot be chosen. Present means unavailable; it is said, not hidden. */
  unavailable?: string | undefined;
  destructive?: boolean | undefined;
}

/**
 * The menu a row carries, holding what can be done to that row ("Ask before
 * deleting in a dialog, from the row's own menu", issue 116) - a Type in the
 * window they are managed in, an Item in a list.
 *
 * One component rather than the same dozen lines in each: what they offer
 * differs, how a row offers it does not. A workspace, a dashboard and a panel
 * open their own menu instead and carry `SurfaceMenu` below - a workspace and
 * a dashboard because they are tabs rather than rows, a panel because its
 * header is the trigger already, under the pointer, and a kebab beside it
 * would be a second control doing what the header already can.
 *
 * The entries are named for the action alone - "Rename", "Delete" - because the
 * control that opened them is named for the row, so a reader who cannot see the
 * screen has already been told which one this is.
 */
export function RowMenu({ label, entries }: { label: string; entries: MenuEntry[] }) {
  const chose = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <DropdownMenu.Root>
      <MenuTrigger label={label} ref={trigger} />
      <MenuContent
        onCloseAutoFocus={(event) => {
          // Choosing an entry usually opens something that takes the focus
          // itself: the name field, or the question. Radix puts the focus back
          // on this control as the menu closes, which would take it straight
          // back off whatever had just opened - so the restore is skipped
          // exactly when something else is claiming the focus, and kept when
          // the menu was simply dismissed, or when the entry chosen opens
          // nothing and said so (`keepsFocus`).
          const claimed = chose.current;
          chose.current = false;
          if (!claimed) return;
          event.preventDefault();
        }}
      >
        {entries.map((entry) => (
          <DropdownMenu.Item
            key={entry.label}
            // `aria-disabled` rather than `disabled`, which is not a smaller
            // way of saying the same thing: Radix takes `disabled` out of the
            // menu's roving focus, so arrow keys, Home/End and typeahead all
            // skip it and a keyboard reader never reaches the entry at all -
            // which is worse than the offered-then-refused it replaced, and
            // only for the people who could not see it was there. It stays
            // reachable, says why it cannot be chosen, and does nothing when
            // it is; `preventDefault` on the choice also leaves the menu open,
            // so choosing it does not read as having worked.
            {...(entry.unavailable
              ? { 'aria-disabled': true, 'aria-label': `${entry.label}: ${entry.unavailable}` }
              : {})}
            className={
              entry.unavailable
                ? unavailableItemClass
                : entry.destructive
                  ? destructiveItemClass
                  : menuItemClass
            }
            onSelect={(event) => {
              if (entry.unavailable) {
                event.preventDefault();
                return;
              }
              chose.current = !entry.keepsFocus;
              entry.onSelect(trigger.current);
            }}
          >
            {entry.label}
            {entry.unavailable && (
              // Inside the entry rather than beside it, so it is part of what
              // the entry is called: an entry that cannot be chosen and gives
              // no reason is indistinguishable from one that is broken.
              <span className="block text-xs">{entry.unavailable}</span>
            )}
          </DropdownMenu.Item>
        ))}
      </MenuContent>
    </DropdownMenu.Root>
  );
}

/**
 * The menu a tab or a panel carries, holding what can be done to the
 * workspace, dashboard or panel it names ("Change a workspace or a dashboard
 * on the tab it is", issue 267).
 *
 * **The tab or the panel is the trigger, so there is no control to add.** A
 * strip of tabs is the thing you use all day, and a three-dot button on every
 * one would be permanent chrome for something done a few times a month - and
 * it would have to fit beside the name in a strip that already scrolls. A
 * panel's header is under the pointer for a different reason: it is already
 * the handle you drag to move the panel, so right-click is a second word for
 * a target the header already is, rather than a second control competing
 * with the one that used to sit beside it. Either way, the surface opens its
 * own menu, the same ways in:
 *
 * - **a right-click**, anywhere on the tab or the header, which is what a
 *   pointer has;
 * - **a press on the tab you are already on**, which is what a finger has:
 *   that press has no other job, since you are looking at what it would
 *   switch to, and it is the only way in that needs no gesture at all
 *   (`opensOnPress`) - a panel has no "already open" state to repurpose this
 *   way, so it never passes one;
 * - **the keyboard's own menu key**, on whichever of the two is focused, which
 *   the browser turns into the same event a right-click makes, so the
 *   keyboard costs nothing to support.
 *
 * (A long press may open it as well, which is Radix's own doing on a
 * touchscreen. A tab relies on it for nothing, since a press already opens
 * it; a panel has no such fallback, so on a touchscreen this is its only way
 * in, driven by `choosePanelAction`'s `holdPanelHeader`.)
 *
 * **The menu is the row menu's, in a context menu's clothes.** Same entries,
 * same look, same rules about an entry that cannot be chosen: only the way it
 * is opened differs, and that is the whole reason this is a second component
 * rather than a flag on `RowMenu` - Radix keeps context menus and dropdowns in
 * separate primitives because what opens them is different.
 */
export function SurfaceMenu({
  label,
  entries,
  children,
  disabled = false,
}: {
  /** What the menu is called to somebody who cannot see the tab or panel it belongs to. */
  label: string;
  entries: MenuEntry[];
  /** The tab or the panel itself, which is the trigger. */
  children: React.ReactNode;
  /**
   * Shut while something else on the trigger already owns right-click and the
   * keyboard menu key - a panel being renamed edits its name in place, on the
   * same header this opens from, so the menu has to step aside rather than
   * fight the rename box for them.
   */
  disabled?: boolean;
}) {
  const chose = useRef(false);
  const tab = useRef<HTMLElement>(null);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger ref={tab} asChild disabled={disabled}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          aria-label={label}
          onCloseAutoFocus={(event) => {
            // The row menu's reasoning, and the same code: an entry that opens
            // something has to keep the focus it just took.
            const claimed = chose.current;
            chose.current = false;
            if (!claimed) return;
            event.preventDefault();
          }}
          className="min-w-44 rounded-md border border-black/10 bg-surface p-1 shadow-lg"
        >
          {entries.map((entry) => (
            <ContextMenu.Item
              key={entry.label}
              {...(entry.unavailable
                ? { 'aria-disabled': true, 'aria-label': `${entry.label}: ${entry.unavailable}` }
                : {})}
              className={
                entry.unavailable
                  ? unavailableItemClass
                  : entry.destructive
                    ? destructiveItemClass
                    : menuItemClass
              }
              onSelect={(event) => {
                if (entry.unavailable) {
                  event.preventDefault();
                  return;
                }
                chose.current = !entry.keepsFocus;
                entry.onSelect(tab.current);
              }}
            >
              {entry.label}
              {entry.unavailable && <span className="block text-xs">{entry.unavailable}</span>}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * What a press on the tab you are already on does: open that tab's
 * `SurfaceMenu` instead of going where you already are.
 *
 * Tab-only: a panel has no "already open" state to repurpose this way, so it
 * never passes one (see `SurfaceMenu`'s own doc comment).
 *
 * It opens the menu by making the event the trigger is listening for, rather
 * than by holding the menu open in state, because Radix's context menu has no
 * open of its own to set - which is also what keeps this one behaviour rather
 * than a second, parallel way for a tab menu to be open.
 *
 * The coordinates are the press's own, so the menu appears under the finger
 * that asked for it rather than at a corner of the tab.
 */
export function opensOnPress(here: boolean) {
  return (event: React.MouseEvent<HTMLElement>) => {
    if (!here) return;
    // A press, rather than a keyboard's Enter on the focused tab: that arrives
    // as a click with no pointer behind it (`detail` 0, and coordinates of
    // zero), so opening the menu on it would put the menu in the corner of the
    // window. The keyboard has the menu key for this, which arrives as the
    // event below rather than as a click.
    if (event.detail === 0) return;
    event.preventDefault();
    event.currentTarget.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        button: 2,
      }),
    );
  };
}

/**
 * What Enter or the space bar does on a panel's header: open its
 * `SurfaceMenu` the way a right-click would (found in review).
 *
 * Panel-only, and the reverse of `opensOnPress`'s carve-out: a tab is a
 * `Link`, which the browser already opens or activates on Enter, so a
 * second handler there would fight it for the key rather than fill a gap. A
 * panel's header activates nothing, and the browser's own menu key - the
 * fallback everywhere else in `SurfaceMenu` - does not exist on macOS, so
 * without this a keyboard-only user on that platform has no way to reach a
 * panel's menu at all, and therefore no way to Rename, Move or Delete one.
 *
 * The coordinates are the header's own centre rather than a press's, since a
 * key carries none of its own - unlike `opensOnPress`, which reads them off
 * the pointer event it is faking a context menu from.
 */
export function opensOnKey(disabled: boolean) {
  return (event: React.KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
        button: 2,
      }),
    );
  };
}
