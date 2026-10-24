import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ACCOUNT_WIDE, FOLLOW_UP_DAYS, MOST_FOLLOW_UP_DAYS, dayOf, daysOnFrom, followUpDaysSchema, uuidv7 } from '@cockpit/shared';
import { snapshotQuery, useSendCommand, whyNotDone } from '../api/queries';
import { weekdayDayLabel } from '../dateFormat';
import { DEADLINE_PILLS } from '../dueDate';
import { SettingsPanel } from './SettingsPanel';

/** A whole number of days from 1 to 365, or null for anything else typed. */
function daysIn(typed: string): number | null {
  if (typed.trim() === '') return null;
  const parsed = followUpDaysSchema.safeParse(Number(typed));
  return parsed.success ? parsed.data : null;
}

/**
 * Settings › Follow-ups ("Choose in Settings how many days to wait for a reply",
 * issue 1465): the number *Wait for reply…* starts on, kept on the account.
 * Read off the open Workspace's held copy, which every Workspace's carries, and
 * saved on Enter or on leaving the box; a change that has not been read back
 * yet is drawn at once.
 */
export default function ManageFollowUps({ workspaceId }: { workspaceId: string | undefined }) {
  const { data: saved = FOLLOW_UP_DAYS } = useQuery({
    ...snapshotQuery(workspaceId ?? ''),
    // Never read for: the open Workspace's copy is already held, and the change below reads it again.
    enabled: false,
    select: (held) => held.followUpDays ?? FOLLOW_UP_DAYS,
  });
  /** A number sent and not yet read back. */
  const [chosen, setChosen] = useState<number | null>(null);
  const shown = chosen ?? saved;
  const [typed, setTyped] = useState(String(shown));
  const [failed, setFailed] = useState<string | null>(null);
  const box = useRef<HTMLInputElement>(null);
  const send = useSendCommand();

  // What the account holds wins once it is read, here or from another device; the box follows unless it is being typed in.
  useEffect(() => {
    setChosen(null);
    if (document.activeElement !== box.current) setTyped(String(saved));
  }, [saved]);

  const days = daysIn(typed);
  const refused = days === null;

  const commit = () => {
    if (days === null || days === shown) return;
    setChosen(days);
    setFailed(null);
    send({
      name: 'set_follow_up_days',
      payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId: ACCOUNT_WIDE, days },
    }).catch((failure: unknown) => {
      setChosen(null);
      setFailed(`Not saved. ${whyNotDone(failure)}`);
    });
  };

  const today = dayOf(new Date());

  return (
    <section>
      <h3 className="text-base font-semibold">Follow-ups</h3>
      <p className="mt-1 text-sm text-ink-soft">
        When you have answered someone and are waiting for them, set the Item's status to{' '}
        <span className="font-medium text-ink-strong">Waiting for reply</span>. It stays where it is, and gets a due date
        so it comes back to you if they never answer.
      </p>

      <SettingsPanel name="How long to wait" hint="Yours, the same on every device you sign in on.">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>Give it a due date</span>
          <input
            ref={box}
            type="number"
            inputMode="numeric"
            min={1}
            max={MOST_FOLLOW_UP_DAYS}
            step={1}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              commit();
            }}
            aria-label="Days after you set it"
            aria-invalid={refused}
            className="w-16 rounded-md border border-shade/20 bg-field px-2 py-1 text-right text-sm text-ink-strong focus:border-accent focus:outline-none"
          />
          <span>days after you set it</span>
          {refused && (
            <span role="alert" className="text-over-ink">
              Use a whole number from 1 to {MOST_FOLLOW_UP_DAYS}.
            </span>
          )}
        </div>
        {failed && (
          <p role="alert" className="mt-2 text-sm text-over-ink">
            {failed}
          </p>
        )}

        <p className="mt-4 text-xs font-medium text-ink-soft">Set today, it looks like this:</p>
        <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-shade/10 bg-field px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm text-ink-strong">Reply from Jan about the audit trail</span>
          <span className="shrink-0 rounded-full bg-shade/10 px-1.5 py-0.5 text-[11px] font-medium leading-none text-ink-soft">
            Waiting since {weekdayDayLabel(today)}
          </span>
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none ${shown <= 2 ? DEADLINE_PILLS.near : DEADLINE_PILLS.week}`}
          >
            Due {weekdayDayLabel(daysOnFrom(today, shown))}
          </span>
        </div>
        <p className="mt-2 text-xs text-ink-faint">
          If nobody has replied by then, the date turns red like any overdue Item. Changing the number here leaves Items
          already waiting as they are.
        </p>
      </SettingsPanel>

      <p className="mt-4 text-xs text-ink-faint">
        It counts for every Item you set to Waiting for reply, and for mail you Cc or Bcc to your Email to Cockpit
        address. To wait a different time for one Item, change its due date on the Item.
      </p>
    </section>
  );
}
