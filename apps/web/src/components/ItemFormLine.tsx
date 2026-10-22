import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ItemStatus, Priority } from '@cockpit/shared';
import { MenuContent, menuItemSplitClass } from './Menu';
import { Suspense, lazy, useState } from 'react';
import type { RepeatsChoice } from './RepeatsChip';
import { WhateverTheQuestionDoes } from './WhateverTheQuestionDoes';
import { DueChips, PriorityFlags, QUIET_BUTTON, STRIP_BUTTON } from './StripChoices';

/** The Repeats chip and its popover, fetched behind the line so the entry does not carry them ("Set an Item to repeat from its form", issue 1406). */
const RepeatsChip = lazy(() => import('./RepeatsChip').then((loaded) => ({ default: loaded.RepeatsChip })));

const STATUSES: readonly [ItemStatus, string][] = [
  ['to_do', 'To do'],
  ['in_progress', 'In progress'],
  ['done', 'Done'],
];

/**
 * The Item form's status, priority and due date on one line at a desk, docked
 * and modal alike ("Set status, priority and due date on one line in the Item
 * form at a desk", issue 1102): a Status chip, then the flags and Due chips as
 * Capture's strip draws them. What a choice does is the form's - written at
 * once when docked, held until Save in the modal - so this only reports it. The
 * Repeats chip ends the line.
 */
export function ItemFormLine({
  status,
  priority,
  dueDate,
  disabled,
  onStatus,
  onPriority,
  onDueDate,
  repeats,
}: {
  status: ItemStatus;
  priority: Priority | null;
  dueDate: string | null;
  disabled: boolean;
  onStatus: (status: ItemStatus) => void;
  onPriority: (priority: Priority | null) => void;
  onDueDate: (dueDate: string | null) => void;
  /** The Repeats chip that ends the line ("Set an Item to repeat from its form", issue 1406); absent where the Item cannot repeat. */
  repeats?: RepeatsChoice | undefined;
}) {
  const [repeatsFailed, setRepeatsFailed] = useState(false);
  const statusName = STATUSES.find(([value]) => value === status)![1];
  return (
    <div role="group" aria-label="Fields" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          disabled={disabled}
          title="Status"
          className={`${STRIP_BUTTON} ${QUIET_BUTTON} gap-1 text-ink`}
        >
          {statusName}
          <span aria-hidden="true">▾</span>
        </DropdownMenu.Trigger>
        <MenuContent align="start">
          {STATUSES.map(([value, name]) => (
            <DropdownMenu.Item
              key={value}
              role="menuitemradio"
              aria-checked={value === status}
              className={menuItemSplitClass}
              onSelect={() => onStatus(value)}
            >
              <span>{name}</span>
              {value === status && <span aria-hidden="true">✓</span>}
            </DropdownMenu.Item>
          ))}
        </MenuContent>
      </DropdownMenu.Root>
      <PriorityFlags priority={priority} onPriority={onPriority} disabled={disabled} />
      <DueChips due={dueDate} onDue={onDueDate} disabled={disabled} />
      {repeats &&
        (repeatsFailed ? (
          // A chunk that never arrives leaves the rest of the form as it was, and says so where the chip would be.
          <span role="alert" className="text-sm text-over-ink">
            Repeats could not load. Reload Cockpit to try again.
          </span>
        ) : (
          <WhateverTheQuestionDoes onFailure={() => setRepeatsFailed(true)}>
            <Suspense fallback={null}>
              <RepeatsChip disabled={disabled} {...repeats} />
            </Suspense>
          </WhateverTheQuestionDoes>
        ))}
    </div>
  );
}
