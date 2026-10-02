import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS, type Usage } from '@cockpit/shared';
import { statusOf } from '../api/loadFailure';
import { usageQuery } from '../api/queries';
import { CloseWindow, ManageWindow } from './ManageWindow';

/**
 * Who has signed in and what guest sessions looked like, in a window only an
 * admin is offered ("Add an admin Usage window for sign-ins and guest
 * sessions", issue 654). It follows Manage users: a window over the
 * workspace, read only while open, with the refusal drawn as a refusal.
 *
 * **Page traffic is not here.** Cloudflare Web Analytics holds it, and this
 * window only links there when the server was given an address to link to.
 *
 * **A referrer host is client input**, so it is drawn as React text and
 * nothing else: never as markup and never as a link target.
 */

/** The windows offered, in days; the longest is as far back as the history is kept. */
const WINDOWS = [7, USAGE_DEFAULT_DAYS, 90, USAGE_MAX_DAYS] as const;

/** Fixed to UTC, like the days the server counts in, so the screen and the figures agree. */
const WHEN = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

function when(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? instant : `${WHEN.format(date)} UTC`;
}

export default function UsageWindow({
  open,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const [days, setDays] = useState<number>(USAGE_DEFAULT_DAYS);
  // Read only while open: who signed in is other people's business and is never
  // fetched for somebody who has not asked for it.
  const { data, error, isPending, refetch, isFetching } = useQuery({ ...usageQuery(days), enabled: open });

  return (
    <ManageWindow title="Usage" wide open={open} onClose={onClose} returnFocusTo={returnFocusTo}>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-ink-faint">
        <label className="flex items-center gap-2">
          Show the last
          <select
            className="rounded border border-black/15 px-2 py-1 text-sm text-ink"
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {WINDOWS.map((option) => (
              <option key={option} value={option}>
                {option} days
              </option>
            ))}
          </select>
        </label>
        {data?.analyticsUrl && (
          <a className="underline" href={data.analyticsUrl} target="_blank" rel="noopener noreferrer">
            Page traffic in Cloudflare Web Analytics
          </a>
        )}
      </div>
      {isPending && !error && <p className="mt-3 text-sm text-ink-faint">Reading usage…</p>}
      {/* Only a 403 is "you are not an admin", as in Manage users: anything else
          would tell an admin they had lost their role when a request failed. */}
      {error &&
        (statusOf(error) === '403' ? (
          <p className="mt-3 text-sm text-ink-faint">
            This is for admins, and Cockpit does not have you down as one.
          </p>
        ) : (
          <p role="alert" className="mt-3 text-sm text-ink-faint">
            Usage could not be read just now.{' '}
            <button type="button" className="underline" disabled={isFetching} onClick={() => void refetch()}>
              Try again
            </button>
          </p>
        ))}
      {data && <Figures usage={data} />}
      <CloseWindow />
    </ManageWindow>
  );
}

function Figures({ usage }: { usage: Usage }) {
  const { guests, named } = usage;
  const sessions = guests.perDay.reduce((sum, day) => sum + day.sessions, 0);

  return (
    <div className="-mx-2 mt-4 min-h-0 flex-1 space-y-6 overflow-y-auto px-2">
      <section aria-labelledby="usage-guests">
        <h3 id="usage-guests" className="text-sm font-medium">
          Guest sessions
        </h3>
        {sessions === 0 ? (
          <p className="mt-1 text-sm text-ink-faint">No guest sessions in the last {usage.days} days.</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-faint">
              {sessions} in the last {usage.days} days.
            </p>
            <table className="mt-2 w-full text-left text-sm">
              <caption className="sr-only">Guest sessions per day</caption>
              <thead className="text-xs text-ink-faint">
                <tr>
                  <th className="py-1 font-normal">Day (UTC)</th>
                  <th className="py-1 font-normal">Sessions</th>
                  <th className="py-1 font-normal">Items captured</th>
                  <th className="py-1 font-normal">Dashboards opened</th>
                </tr>
              </thead>
              <tbody>
                {guests.perDay.map((day) => (
                  <tr key={day.day} className="border-t border-black/5">
                    <td className="py-1">{day.day}</td>
                    <td className="py-1">{day.sessions}</td>
                    <td className="py-1">{day.itemsCaptured}</td>
                    <td className="py-1">{day.dashboardsOpened}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-4 grid gap-6 sm:grid-cols-2">
              <Breakdown
                title="By country"
                rows={guests.byCountry.map((row) => ({ name: row.country, sessions: row.sessions }))}
              />
              <Breakdown
                title="By referrer"
                rows={guests.byReferrer.map((row) => ({ name: row.host, sessions: row.sessions }))}
              />
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="usage-named">
        <h3 id="usage-named" className="text-sm font-medium">
          Sign-ins
        </h3>
        <ul className="mt-1">
          {named.map((person) => (
            <li key={person.userId} className="border-t border-black/5 py-2 first:border-t-0">
              <p className="text-sm">{person.name}</p>
              <p className="text-sm text-ink-faint">
                {person.latest ? `Latest ${when(person.latest)}` : 'Has not signed in yet'}
              </p>
              {person.signIns.length > 0 && (
                <ul className="mt-1 text-xs text-ink-faint" aria-label={`Sign-ins of ${person.name}`}>
                  {person.signIns.map((at) => (
                    <li key={at}>{when(at)}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: { name: string | null; sessions: number }[] }) {
  return (
    <div>
      <h4 className="text-xs text-ink-faint">{title}</h4>
      <ul className="mt-1 text-sm">
        {rows.map((row) => (
          <li key={row.name ?? ''} className="flex justify-between gap-3 border-t border-black/5 py-1">
            {/* Plain text, whatever it holds: a referrer is client input. */}
            <span className="min-w-0 truncate">{row.name ?? 'Unknown'}</span>
            <span>{row.sessions}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
