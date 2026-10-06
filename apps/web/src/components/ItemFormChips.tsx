import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { prioritySchema, type ItemStatus, type ItemType, type Priority } from '@cockpit/shared';
import { DEADLINE_PILLS, deadlineOf, dueDateLabel } from '../dueDate';
import { dueSevenDaysOut, dueToday, dueTomorrow } from '../dueDateShortcuts';
import type { Day } from '../filters';
import { PRIORITY_FLAG_COLOURS, PRIORITY_LABELS } from '../priority';
import { MenuContent, menuItemClass, menuItemSplitClass } from './Menu';

/**
 * The Item's fields on a phone's page, as a wrapping row of chips ("Edit an
 * Item's type, status, priority and due date from chips on a phone", issue
 * 787). Each says what is set and opens a picker for its own field; a pick
 * changes the form's draft and nothing is written until Save, like every other
 * field there. Loaded only where the form is a page, so the desk never pays
 * for it.
 */

const STATUSES: readonly [ItemStatus, string][] = [
  ['to_do', 'To do'],
  ['in_progress', 'In progress'],
  ['done', 'Done'],
];

const CHIP = 'inline-flex h-9 max-w-full items-center gap-1 rounded-full px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent-soft/60 disabled:opacity-50';
/** A field with nothing set: outline only, named for the field. */
const UNSET = 'border border-shade/20 bg-transparent text-ink-faint';
const SET = 'border border-transparent';

const days: readonly [string, (now: Date) => Day][] = [
  ['Today', dueToday],
  ['Tomorrow', dueTomorrow],
  ['+7d', dueSevenDaysOut],
];

export interface ItemFormChipsProps {
  typeId: string | null;
  status: ItemStatus;
  priority: Priority | null;
  dueDate: string | null;
  /** The Types as the form offers them: the ones used last first. */
  types: readonly ItemType[];
  disabled: boolean;
  onType: (typeId: string) => void;
  onStatus: (status: ItemStatus) => void;
  onPriority: (priority: Priority | null) => void;
  onDueDate: (dueDate: string | null) => void;
  /** Opens the file picker. */
  onAttach: () => void;
}

function Ticked({ on }: { on: boolean }) {
  return on ? <span aria-hidden="true">✓</span> : null;
}

export default function ItemFormChips(props: ItemFormChipsProps) {
  const { typeId, status, priority, dueDate, types, disabled } = props;
  const type = types.find((candidate) => candidate.id === typeId);
  const statusName = STATUSES.find(([value]) => value === status)![1];
  const deadline = deadlineOf(dueDate, Date.now());
  const dueText = dueDateLabel(dueDate);
  const [dueOpen, setDueOpen] = useState(false);
  const chooseDue = (next: string | null) => {
    props.onDueDate(next);
    setDueOpen(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Fields">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          disabled={disabled}
          className={`${CHIP} ${SET} bg-accent-tint text-accent-deep`}
        >
          <span className="truncate">{type?.name ?? 'No type'}</span>
        </DropdownMenu.Trigger>
        <MenuContent align="start">
          {/* Only while the item has none: nothing sets a type to none. */}
          {typeId === null && (
            <DropdownMenu.Item disabled className={`${menuItemClass} text-ink-faint`}>
              No type
            </DropdownMenu.Item>
          )}
          {types.map((candidate) => (
            <DropdownMenu.Item
              key={candidate.id}
              role="menuitemradio"
              aria-checked={candidate.id === typeId}
              className={menuItemSplitClass}
              onSelect={() => props.onType(candidate.id)}
            >
              <span>{candidate.name}</span>
              <Ticked on={candidate.id === typeId} />
            </DropdownMenu.Item>
          ))}
        </MenuContent>
      </DropdownMenu.Root>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger disabled={disabled} className={`${CHIP} ${SET} bg-shade/5 text-ink`}>
          {statusName}
        </DropdownMenu.Trigger>
        <MenuContent align="start">
          {STATUSES.map(([value, name]) => (
            <DropdownMenu.Item
              key={value}
              role="menuitemradio"
              aria-checked={value === status}
              className={menuItemSplitClass}
              onSelect={() => props.onStatus(value)}
            >
              <span>{name}</span>
              <Ticked on={value === status} />
            </DropdownMenu.Item>
          ))}
        </MenuContent>
      </DropdownMenu.Root>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          disabled={disabled}
          {...(priority ? { 'aria-label': `${PRIORITY_LABELS[priority]} priority` } : {})}
          className={`${CHIP} ${
            priority ? `${SET} ${PRIORITY_FLAG_COLOURS[priority]} text-white` : UNSET
          }`}
        >
          {priority ? (
            <>
              <span aria-hidden="true">⚑</span>
              <span aria-hidden="true">{PRIORITY_LABELS[priority]}</span>
            </>
          ) : (
            'Priority'
          )}
        </DropdownMenu.Trigger>
        <MenuContent align="start">
          {/* Pressing the ticked level clears it, as pressing the lit flag does at a desk. */}
          {prioritySchema.options.map((level) => (
            <DropdownMenu.Item
              key={level}
              role="menuitemradio"
              aria-checked={level === priority}
              className={menuItemSplitClass}
              onSelect={() => props.onPriority(level === priority ? null : level)}
            >
              <span>{PRIORITY_LABELS[level]}</span>
              <Ticked on={level === priority} />
            </DropdownMenu.Item>
          ))}
        </MenuContent>
      </DropdownMenu.Root>

      <Popover.Root open={dueOpen} onOpenChange={setDueOpen}>
        <Popover.Trigger
          disabled={disabled}
          className={`${CHIP} ${
            dueDate === null
              ? UNSET
              : deadline
                ? `${DEADLINE_PILLS[deadline.level]} ${deadline.level === 'week' ? '' : 'border border-transparent'}`
                : `${SET} bg-shade/5 text-ink`
          }`}
        >
          {dueDate === null ? 'Due date' : (deadline?.label ?? `Due ${dueText ?? dueDate}`)}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={4}
            role="group"
            aria-label="Due date"
            className="z-floating flex w-64 flex-col gap-2 rounded-md border border-shade/10 bg-surface p-3 shadow-lg"
          >
            <div className="flex gap-2">
              {days.map(([name, dayOf]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => chooseDue(dayOf(new Date()))}
                  className="h-9 flex-1 rounded-md border border-shade/10 text-sm text-ink hover:border-accent hover:bg-accent-tint"
                >
                  {name}
                </button>
              ))}
            </div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Pick a date
              <input
                type="date"
                value={dueDate ?? ''}
                onChange={(e) => {
                  if (e.target.value) chooseDue(e.target.value);
                }}
                className="mt-1 h-9 w-full rounded-md border border-shade/10 bg-white px-3 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
              />
            </label>
            {dueDate !== null && (
              <button
                type="button"
                onClick={() => chooseDue(null)}
                className="h-9 rounded-md text-sm text-over hover:bg-over/10"
              >
                Clear
              </button>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <button
        type="button"
        disabled={disabled}
        onClick={props.onAttach}
        className={`${CHIP} ${UNSET} hover:border-accent hover:text-ink`}
      >
        + Attach
      </button>
    </div>
  );
}
