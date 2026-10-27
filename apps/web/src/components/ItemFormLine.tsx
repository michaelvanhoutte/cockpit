import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { ItemStatus, Priority } from '@cockpit/shared';
import { MenuContent, menuItemSplitClass } from './Menu';
import { Suspense, lazy, useRef, useState } from 'react';
import type { WaitChoice } from './WaitForReply';
import { WhateverTheQuestionDoes } from './WhateverTheQuestionDoes';
import { DueChips, PriorityFlags, QUIET_BUTTON, STRIP_BUTTON } from './StripChoices';

/** The *Wait for reply…* chip and its popover, fetched behind the line so the entry does not carry them ("Set an Item Waiting for reply", issue 1463). */
const WaitChip = lazy(() => import('./WaitForReply').then((loaded) => ({ default: loaded.WaitChip })));

const STATUSES: readonly [ItemStatus, string][] = [
  ['to_do', 'To do'],
  ['in_progress', 'In progress'],
  ['waiting', 'Waiting for reply'],
  ['done', 'Done'],
];

/**
 * The Item form's status, priority and due date on one line at a desk, docked
 * and modal alike ("Set status, priority and due date on one line in the Item
 * form at a desk", issue 1102): a Status chip, then the flags and Due chips as
 * Capture's strip draws them. What a choice does is the form's - written at
 * once when docked, held until Save in the modal - so this only reports it.
 * *Wait for reply…* follows the Due chips, before + Attach. **Waiting for reply on
 * Status asks how long**, in the same popover.
 */
export function ItemFormLine({
  status,
  priority,
  dueDate,
  disabled,
  onStatus,
  onPriority,
  onDueDate,
  wait,
  onAttach,
}: {
  status: ItemStatus;
  priority: Priority | null;
  dueDate: string | null;
  disabled: boolean;
  onStatus: (status: ItemStatus) => void;
  onPriority: (priority: Priority | null) => void;
  onDueDate: (dueDate: string | null) => void;
  /** *Wait for reply…* or *Wait again…*; absent where the Item cannot wait. */
  wait?: WaitChoice | undefined;
  /** Opens the file picker: attaching is on the line whichever tab is open ("Give an Item's attachments a tab of their own", issue 1410). */
  onAttach: () => void;
}) {
  const [waitFailed, setWaitFailed] = useState(false);
  const [waitOpen, setWaitOpen] = useState(false);
  /** That the Status menu is closing to open the wait's question, which takes the focus itself. */
  const askingToWait = useRef(false);
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
        <MenuContent
          align="start"
          onCloseAutoFocus={(event) => {
            if (!askingToWait.current) return;
            askingToWait.current = false;
            event.preventDefault();
          }}
        >
          {STATUSES.filter(([value]) => value !== 'waiting' || (wait && !waitFailed)).map(([value, name]) => (
            <DropdownMenu.Item
              key={value}
              role="menuitemradio"
              aria-checked={value === status}
              className={menuItemSplitClass}
              onSelect={() => {
                if (value !== 'waiting') return onStatus(value);
                if (value === status) return;
                askingToWait.current = true;
                setWaitOpen(true);
              }}
            >
              <span>{name}</span>
              {value === status && <span aria-hidden="true">✓</span>}
            </DropdownMenu.Item>
          ))}
        </MenuContent>
      </DropdownMenu.Root>
      <PriorityFlags priority={priority} onPriority={onPriority} disabled={disabled} />
      <DueChips due={dueDate} onDue={onDueDate} disabled={disabled} />
      {wait &&
        (waitFailed ? (
          // A chunk that never arrives leaves the rest of the form as it was, and says so where the chip would be.
          <span role="alert" className="text-sm text-over-ink">
            Wait for reply could not load. Reload Cockpit to try again.
          </span>
        ) : (
          <WhateverTheQuestionDoes onFailure={() => setWaitFailed(true)}>
            <Suspense fallback={null}>
              <WaitChip open={waitOpen} onOpenChange={setWaitOpen} disabled={disabled} {...wait} />
            </Suspense>
          </WhateverTheQuestionDoes>
        ))}
      <button type="button" disabled={disabled} onClick={onAttach} className={`${STRIP_BUTTON} ${QUIET_BUTTON} text-ink-soft`}>
        + Attach
      </button>
    </div>
  );
}
