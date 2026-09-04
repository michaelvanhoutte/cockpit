import { useRef } from 'react';
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
  ref,
}: {
  label: string;
  className?: string;
  /** Held where something has to put the focus back on this control afterwards. */
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <DropdownMenu.Trigger
      ref={ref}
      aria-label={label}
      // 36px, comfortably past the 24px minimum target size and reachable with
      // a thumb, in a bar whose other controls are smaller than that: the
      // control is what has to be hittable, not the text beside it.
      className={`inline-flex size-9 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-accent-tint hover:text-accent-deep focus-visible:outline-2 focus-visible:outline-accent data-[state=open]:bg-accent-tint data-[state=open]:text-accent-deep${className ? ` ${className}` : ''}`}
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
 * The menu a row of a settings page carries, holding what can be done to that
 * row ("Ask before deleting in a dialog, from the row's own menu", issue 116).
 *
 * One component rather than the same dozen lines on each settings page: what
 * the two pages offer differs, how a row offers it does not.
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
