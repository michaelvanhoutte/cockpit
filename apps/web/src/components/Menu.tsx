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
export function MenuContent({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align="end"
        sideOffset={4}
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
