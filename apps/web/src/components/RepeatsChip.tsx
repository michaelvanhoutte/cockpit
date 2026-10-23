import * as Popover from '@radix-ui/react-popover';
import {
  MOST_DUE_AFTER_DAYS,
  dayOf,
  firstNextOn,
  readBack,
  ruleLabel,
  type RepeatFrequency,
  type RepeatRule,
} from '@cockpit/shared';
import { weekdayDayLabel } from '../dateFormat';
import { LIT_BUTTON, QUIET_BUTTON, STRIP_BUTTON } from './StripChoices';

/**
 * An Item's Repeats ("Set an Item to repeat from its form, and see the rule on
 * its row", issue 1406): the chip that ends the form's status / priority / Due
 * line at a desk and is one more chip on a phone, the popover both open, and the
 * ↻ a repeating row wears. What a choice does - held until Save, or written at
 * once when docked - is the form's, so this only reports it.
 */

const FREQUENCIES: readonly [RepeatFrequency | null, string][] = [
  [null, 'Never'],
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'],
  ['yearly', 'Yearly'],
];

/** A day the server takes: a four-digit year, which is what a date box passes while a fifth digit is being typed. */
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export interface RepeatsChoice {
  /** The Item's rule as the form holds it, or `null` for *Never*. */
  repeat: RepeatRule | null;
  /**
   * A choice: the whole rule it leaves. `now` says it is complete as it stands - a
   * frequency is - rather than a box still being typed into, which is written when
   * it is left (`onSettled`).
   */
  onRepeat: (repeat: RepeatRule | null, now: boolean) => void;
  /** A box was left, or the popover closed: whatever is held may be written. */
  onSettled: () => void;
  /** Why the last write was refused, said beside the choices until another is made. */
  refusal: string | null;
}

/** The popover's choices, drawn in the desk chip's popover and the phone chip's alike. */
export function RepeatsChoices({ repeat, onRepeat, onSettled, refusal }: RepeatsChoice) {
  const pick = (frequency: RepeatFrequency | null) => {
    if (!frequency) return onRepeat(null, true);
    onRepeat(
      {
        frequency,
        nextOn: repeat?.nextOn ?? firstNextOn(dayOf(new Date()), frequency),
        dueAfterDays: repeat?.dueAfterDays ?? null,
      },
      true,
    );
  };

  return (
    <>
      <div className="mb-1 text-xs font-semibold tracking-[0.11em] text-ink-faint uppercase">Repeats</div>
      <div role="group" aria-label="Repeats" className="flex flex-wrap gap-1">
        {FREQUENCIES.map(([value, name]) => {
          const lit = (repeat?.frequency ?? null) === value;
          return (
            <button
              key={name}
              type="button"
              aria-pressed={lit}
              onClick={() => pick(value)}
              className={`${STRIP_BUTTON} ${lit ? LIT_BUTTON : QUIET_BUTTON}`}
            >
              {name}
            </button>
          );
        })}
      </div>
      {repeat && (
        <>
          <label className="mt-3 flex items-center justify-between gap-2">
            <span className="text-ink-soft">Next on</span>
            <input
              type="date"
              value={repeat.nextOn}
              onChange={(e) => DAY.test(e.target.value) && onRepeat({ ...repeat, nextOn: e.target.value }, false)}
              onBlur={onSettled}
              className="rounded-md border border-shade/10 bg-field px-2 py-0.5 text-sm"
            />
          </label>
          <label className="mt-2 flex items-center justify-between gap-2">
            <span className="text-ink-soft">Due</span>
            <span className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={MOST_DUE_AFTER_DAYS}
                placeholder="—"
                value={repeat.dueAfterDays ?? ''}
                onChange={(e) =>
                  onRepeat(
                    {
                      ...repeat,
                      dueAfterDays:
                        e.target.value === ''
                          ? null
                          : Math.min(MOST_DUE_AFTER_DAYS, Math.max(0, Math.trunc(Number(e.target.value)))),
                    },
                    false,
                  )
                }
                onBlur={onSettled}
                className="w-14 rounded-md border border-shade/10 bg-field px-2 py-0.5 text-right text-sm"
              />
              <span className="text-ink-soft">days after it appears</span>
            </span>
          </label>
          <p className="mt-3 rounded-md bg-accent-tint px-2 py-1.5 text-accent-deep">{readBack(repeat, weekdayDayLabel)}</p>
          <p className="mt-2 text-xs text-ink-faint">
            A new one appears on its day, on the panels this one is on. This one keeps its own due date.
          </p>
        </>
      )}
      {refusal && (
        <p role="alert" className="mt-2 text-sm text-over-ink">
          {refusal}
        </p>
      )}
    </>
  );
}

/** The popover's frame, the same for the desk chip and the phone chip. */
export const REPEATS_POPOVER =
  'z-floating w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-shade/10 bg-surface p-3 text-sm text-ink shadow-lg';

/** The Repeats chip on the Item form's field line at a desk, opening the question. */
export function RepeatsChip({ disabled, ...choice }: RepeatsChoice & { disabled: boolean }) {
  const { repeat } = choice;
  return (
    <Popover.Root onOpenChange={(open) => !open && choice.onSettled()}>
      <Popover.Trigger
        disabled={disabled}
        title="Repeats"
        className={`${STRIP_BUTTON} gap-1 ${repeat ? LIT_BUTTON : QUIET_BUTTON}`}
      >
        <span aria-hidden="true">↻</span>
        {repeat ? ruleLabel(repeat) : 'Repeats'}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className={REPEATS_POPOVER}>
          <RepeatsChoices {...choice} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
