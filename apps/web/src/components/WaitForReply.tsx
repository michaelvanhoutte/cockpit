import { useState, type RefObject } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { FOLLOW_UP_CHOICES, FOLLOW_UP_DAYS, MOST_FOLLOW_UP_DAYS, dayOf, daysOnFrom } from '@cockpit/shared';
import { momentWeekdayDayLabel, weekdayDayLabel } from '../dateFormat';
import { QUIET_BUTTON, STRIP_BUTTON } from './StripChoices';

/**
 * *Wait for reply…* and *Wait again…* ("Set an Item Waiting for reply, and wait
 * again after chasing", issue 1463): the popover asking *Remind me in [N] days*,
 * drawn as the Repeats popover is, opened from a row's menu, the form's chip and
 * either's Status. What a choice does - written at once from a row, held until
 * Save or written at once docked in the form - is the caller's, so this only
 * reports the days.
 */

/** The popover's frame, the Repeats popover's own. */
const WAIT_POPOVER =
  'z-floating w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-shade/10 bg-surface p-3 text-sm text-ink shadow-lg';

export interface WaitChoice {
  /** The Item already waits, so this waits again from the day it first did. */
  waitingSince: string | null;
  /** A wait chosen: the whole number of days, 1 to 365. */
  onWait: (days: number) => void;
}

/** Whether what is typed is a wait the server takes: a whole number of days from 1 to 365. */
export function daysTyped(typed: string): number | null {
  const days = Number(typed);
  return typed.trim() !== '' && Number.isInteger(days) && days >= 1 && days <= MOST_FOLLOW_UP_DAYS ? days : null;
}

/** The question itself: a number Enter accepts, and the usual waits in one press each. */
export function WaitChoices({ waitingSince, onWait }: WaitChoice) {
  const [typed, setTyped] = useState(String(FOLLOW_UP_DAYS));
  const days = daysTyped(typed);
  const due = days === null ? null : daysOnFrom(dayOf(new Date()), days);
  return (
    <div>
      <div className="mb-1 text-xs font-semibold tracking-[0.11em] text-ink-faint uppercase">
        {waitingSince ? 'Wait again' : 'Wait for reply'}
      </div>
      <label className="flex items-center gap-1.5">
        <span className="text-ink-soft">Remind me in</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={MOST_FOLLOW_UP_DAYS}
          step={1}
          autoFocus
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          // Enter accepts what is typed; the buttons beside it each accept their own.
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (days !== null) onWait(days);
          }}
          aria-label="Days to wait"
          aria-invalid={days === null}
          className="w-16 rounded-md border border-shade/10 bg-field px-2 py-0.5 text-right text-sm"
        />
        <span className="text-ink-soft">days</span>
      </label>
      <div role="group" aria-label="Wait" className="mt-2 flex flex-wrap gap-1">
        {FOLLOW_UP_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            onClick={() => onWait(choice)}
            className={`${STRIP_BUTTON} ${QUIET_BUTTON}`}
          >
            {choice === 1 ? '1 day' : `${choice} days`}
          </button>
        ))}
      </div>
      {due ? (
        <p className="mt-3 rounded-md bg-accent-tint px-2 py-1.5 text-accent-deep">Due {weekdayDayLabel(due)}</p>
      ) : (
        <p role="alert" className="mt-3 text-sm text-over-ink">
          Use a whole number from 1 to {MOST_FOLLOW_UP_DAYS}.
        </p>
      )}
      <p className="mt-2 text-xs text-ink-faint">
        {waitingSince
          ? `Its due date moves; it has been waiting since ${momentWeekdayDayLabel(waitingSince)}.`
          : 'It stays where it is, and its due date is replaced.'}
      </p>
    </div>
  );
}

/** The chip on the Item form's line, or one more chip on a phone, opening the question; `open` is held by the form, so its Status can open it too. */
export function WaitChip({
  open,
  onOpenChange,
  disabled,
  className,
  ...choice
}: WaitChoice & { open: boolean; onOpenChange: (open: boolean) => void; disabled: boolean; className?: string }) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger disabled={disabled} className={className ?? `${STRIP_BUTTON} ${QUIET_BUTTON} text-ink-soft`}>
        {choice.waitingSince ? 'Wait again…' : 'Wait for reply…'}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className={WAIT_POPOVER}>
          <WaitChoices
            {...choice}
            onWait={(days) => {
              onOpenChange(false);
              choice.onWait(days);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The same question opened from a row's menu, beside the control the menu was opened from. */
export function WaitPopover({
  anchor,
  onClose,
  ...choice
}: WaitChoice & { anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  return (
    <Popover.Root open onOpenChange={(open) => !open && onClose()}>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className={WAIT_POPOVER}
          // Back to the control the menu was opened from, there being no trigger of its
          // own - unless something else has the focus by then, such as the question
          // opened again, which would take this for a step outside it and close.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const now = document.activeElement;
            if (now === null || now === document.body) anchor.current?.focus();
          }}
          // Drawn in a portal but inside the row in React's tree: what is pressed
          // or typed here is the question's, never a click, key or swipe on the row.
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <WaitChoices
            {...choice}
            onWait={(days) => {
              onClose();
              choice.onWait(days);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
