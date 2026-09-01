import { useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

/**
 * The control that opens a menu, wherever a menu is opened ("Open every menu
 * from the same control", issue 115).
 *
 * **Three dots always mean a menu opens here.** Before this, the header's was a
 * bordered pill, an item row's was faint and unbordered, and the one at the
 * right of the dashboard bar was not a menu at all - it was a link to the
 * dashboard settings page wearing a menu's clothes. Same glyph, three meanings,
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
export function MenuTrigger({ label, className }: { label: string; className?: string }) {
  return (
    <DropdownMenu.Trigger
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

/** An entry that cannot be chosen. It stays visible and says why, rather than going. */
const unavailableItemClass = `${menuItemClass} text-ink-faint data-[highlighted]:bg-transparent data-[highlighted]:text-ink-faint`;

export interface MenuEntry {
  label: string;
  onSelect: () => void;
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

  return (
    <DropdownMenu.Root>
      <MenuTrigger label={label} />
      <MenuContent
        onCloseAutoFocus={(event) => {
          // Choosing an entry opens something that takes the focus itself: the
          // name field, or the question. Radix puts the focus back on this
          // control as the menu closes, which would take it straight back off
          // whatever had just opened - so the restore is skipped exactly when
          // something else is claiming the focus, and kept when the menu was
          // simply dismissed.
          if (!chose.current) return;
          chose.current = false;
          event.preventDefault();
        }}
      >
        {entries.map((entry) => (
          <DropdownMenu.Item
            key={entry.label}
            disabled={Boolean(entry.unavailable)}
            // Said outright rather than left to be assembled out of two
            // elements: whether a reason on its own line is read as part of
            // the entry's name is the reader's to decide, and an entry that
            // cannot be chosen and appears to give no reason is the failure
            // this exists to prevent.
            {...(entry.unavailable ? { 'aria-label': `${entry.label}: ${entry.unavailable}` } : {})}
            className={
              entry.unavailable
                ? unavailableItemClass
                : entry.destructive
                  ? destructiveItemClass
                  : menuItemClass
            }
            onSelect={() => {
              chose.current = true;
              entry.onSelect();
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
