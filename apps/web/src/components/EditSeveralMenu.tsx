import { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { Item, ItemStatus, ItemType, Priority } from '@cockpit/shared';
import { sharedValue, type BulkField, type BulkValue } from '../bulkEdit';
import { dueDateLabel } from '../dueDate';
import { dueSevenDaysOut, dueToday, dueTomorrow } from '../dueDateShortcuts';
import { PRIORITY_LABELS } from '../priority';
import { useRoomForTheInbox } from '../roomForTheInbox';
import { menuItemSplitClass } from './Menu';

/** A submenu's width, which on a phone it also steps back from the menu's edge by. */
const SUBMENU_WIDTH_PX = 176;

export const STATUS_NAMES: Record<ItemStatus, string> = {
  to_do: 'To do',
  in_progress: 'In progress',
  done: 'Done',
};

/** One choice in a field's submenu: what it is called, and the value it sets. */
interface Choice {
  name: string;
  value: BulkValue;
}

/**
 * Edit ▾ on the selection bar: Type ▸, Priority ▸, Due ▸ and Status ▸, each
 * naming the value every picked Item shares - or *Mixed* - with a submenu that
 * ticks it ("Change the type, priority, due date or status of every selected
 * item from the selection bar", issue 864). The same menu on the Dashboard's bar
 * and the Inbox's.
 *
 * **Submenus open beside the menu and reach up from the trigger's foot**, so
 * the pointer goes sideways into one rather than across the trigger of the next
 * field, which closes the one it is leaving, and so none hangs down over the
 * undo offer drawn over the bar's own foot (`undo.tsx`), which covers whatever
 * is under it.
 *
 * **While it is open the undo offer stands aside** (`data-editing-several` on
 * the root, which `undo.tsx` hides itself by): the offer is drawn above menus,
 * and on a phone it is as wide as the screen, so it would sit over the lowest
 * entries of the very menu the next edit is made from. It comes back when the
 * menu closes, if its ten seconds have not run out by then.
 */
export function EditSeveralMenu({
  picked,
  types,
  disabled,
  onSet,
  onPickDate,
}: {
  picked: readonly Item[];
  types: readonly ItemType[];
  /** Unavailable while a run is going or a filing is. */
  disabled: boolean;
  /** `name` is what the choice is called, or null for the due date being cleared. */
  onSet: (field: BulkField, value: BulkValue, name: string | null) => void;
  onPickDate: () => void;
}) {
  /** That the menu closed to hand the focus to the date field, which the menu's own return of it would take back. */
  const handingOnFocus = useRef(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.setAttribute('data-editing-several', '');
    return () => root.removeAttribute('data-editing-several');
  }, [open]);
  const now = new Date();
  /** Whether this is a desk-width screen, where a submenu has room beside the menu. */
  const roomBesideTheMenu = useRoomForTheInbox();

  const fields: { field: BulkField; name: string; choices: Choice[] }[] = [
    {
      field: 'typeId',
      name: 'Type',
      choices: types.map((type) => ({ name: type.name, value: type.id })),
    },
    {
      field: 'priority',
      name: 'Priority',
      choices: [
        ...(['high', 'normal', 'low'] as const).map((level: Priority) => ({
          name: PRIORITY_LABELS[level],
          value: level,
        })),
        { name: 'None', value: null },
      ],
    },
    {
      field: 'dueDate',
      name: 'Due',
      choices: [
        { name: 'Today', value: dueToday(now) },
        { name: 'Tomorrow', value: dueTomorrow(now) },
        { name: 'In a week', value: dueSevenDaysOut(now) },
        { name: 'No due date', value: null },
      ],
    },
    {
      field: 'status',
      name: 'Status',
      choices: (['to_do', 'in_progress', 'done'] as const).map((status) => ({
        name: STATUS_NAMES[status],
        value: status,
      })),
    },
  ];

  /** What the picked Items share, in words - the value's own name, or Mixed. */
  const reading = (field: BulkField, choices: readonly Choice[]): string => {
    const shared = sharedValue(picked, field);
    if (shared.mixed) return 'Mixed';
    const named = choices.find((choice) => choice.value === shared.value)?.name;
    if (named) return named;
    if (shared.value === null) return field === 'typeId' ? 'No type' : 'None';
    // A due date that is not one of the shortcuts' days.
    return dueDateLabel(shared.value) ?? 'None';
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="rounded-sm border border-accent/40 bg-surface px-2 py-1 text-sm hover:border-accent disabled:opacity-50"
          disabled={disabled}
        >
          Edit ▾
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          side="top"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (!handingOnFocus.current) return;
            handingOnFocus.current = false;
            event.preventDefault();
          }}
          className="z-floating min-w-56 rounded-md border border-shade/10 bg-surface p-1 shadow-lg"
        >
          {fields.map(({ field, name, choices }) => {
            const shared = sharedValue(picked, field);
            return (
              <DropdownMenu.Sub key={field}>
                <DropdownMenu.SubTrigger
                  className={`${menuItemSplitClass} data-[state=open]:bg-accent-tint`}
                >
                  <span>{name}</span>{' '}
                  <span className="text-xs text-ink-faint">
                    {reading(field, choices)}
                    <span aria-hidden="true"> ▸</span>
                  </span>
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent
                    // On a phone the menu has no room beside it: the options are laid
                    // over its right-hand end instead, as a row's Status does.
                    sideOffset={roomBesideTheMenu ? 0 : -SUBMENU_WIDTH_PX}
                    align="end"
                    alignOffset={-4}
                    collisionPadding={8}
                    style={{ width: SUBMENU_WIDTH_PX }}
                    className="z-floating max-h-[60vh] overflow-y-auto rounded-md border border-shade/10 bg-surface p-1 shadow-lg"
                  >
                    {choices.map((choice) => {
                      const ticked = !shared.mixed && shared.value === choice.value;
                      return (
                        <DropdownMenu.Item
                          key={choice.name}
                          role="menuitemradio"
                          aria-checked={ticked}
                          className={menuItemSplitClass}
                          onSelect={() =>
                            onSet(
                              field,
                              choice.value,
                              field === 'dueDate' && choice.value === null ? null : choice.name,
                            )
                          }
                        >
                          <span>{choice.name}</span>
                          {ticked && <span aria-hidden="true">✓</span>}
                        </DropdownMenu.Item>
                      );
                    })}
                    {field === 'typeId' && choices.length === 0 && (
                      <div className="px-2 py-1.5 text-sm text-ink-faint">No types yet</div>
                    )}
                    {field === 'dueDate' && (
                      <DropdownMenu.Item
                        className={menuItemSplitClass}
                        onSelect={() => {
                          handingOnFocus.current = true;
                          onPickDate();
                        }}
                      >
                        <span>Pick a date…</span>
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
