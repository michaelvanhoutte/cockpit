import type { ConnectionHistoryLine } from '@cockpit/shared';

/**
 * What a connection's history says, day by day ("See when a pulled connection
 * was checked, and why it failed, from its row's History…", issue 1140) -
 * pure, so the view draws exactly what a test reads, at the `now` it is given.
 */

/** One line as drawn: when, what happened in words, and what else it says. */
export interface HistoryLineShown {
  id: string;
  /** The time it ran, or the span of the checks folded into it. */
  when: string;
  /** *Worked* or *Failed*, in words, with the count where it folds several. */
  says: string;
  failed: boolean;
  /** Why a single check ran, what it did in counts, and a failure's message - null where there is none. */
  detail: string | null;
  /** What the check did, kind by kind, each Item named - empty where it did nothing (issue 1141). */
  did: DidList[];
}

/** One kind of what a check did: *New:*, with the Items it names. */
export interface DidList {
  label: string;
  items: DidItem[];
  /** How many more the count says than the Items listed - the line keeps the first few. */
  more: number;
}

/** An Item named by its title now; `id` null where it is deleted, so nothing opens. */
export interface DidItem {
  key: string;
  id: string | null;
  text: string;
}

/** The kinds of what a check did, in the order a line says them. */
const KINDS = [
  { kind: 'broughtIn', summary: 'Brought in', label: 'New' },
  { kind: 'closed', summary: 'Closed', label: 'Closed' },
  { kind: 'sentBack', summary: 'Sent back', label: 'Sent back' },
  { kind: 'refused', summary: 'Refused', label: 'Refused' },
] as const;

export const GONE = 'an Item no longer in Cockpit';

export interface HistoryDay {
  /** The local calendar day, unique among the days. */
  key: string;
  /** *Today*, *Yesterday*, or the day's date - with its year where it is not this one. */
  heading: string;
  lines: HistoryLineShown[];
}

/** Why a check ran, in words; a reason this release does not know says nothing. */
const REASONS: Record<string, string> = { scheduled: 'Scheduled', 'follow-up': 'Follow-up' };

const time = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** A local calendar day, as a key two moments on the same day share. */
const dayOf = (at: Date) => `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;

function headingFor(at: Date, now: Date): string {
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayOf(at) === dayOf(now)) return 'Today';
  if (dayOf(at) === dayOf(yesterday)) return 'Yesterday';
  return at.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** One line in words. */
export function lineShown(line: ConnectionHistoryLine): HistoryLineShown {
  const folded = line.count > 1;
  const failed = line.outcome === 'failed';
  const message = line.message === null ? null : line.messageCut ? `${line.message}…` : line.message;
  const says = failed
    ? folded
      ? `Failed ${line.count} times`
      : 'Failed'
    : folded
      ? `Checked ${line.count} times, nothing new`
      : 'Worked';
  // A folded line's checks ran for more than one reason, so it says none.
  const summary = KINDS.filter(({ kind }) => line.did[kind].count > 0)
    .map(({ kind, summary }) => `${summary} ${line.did[kind].count}`)
    .join(', ');
  const did = KINDS.filter(({ kind }) => line.did[kind].count > 0).map(({ kind, label }) => ({
    label,
    more: line.did[kind].count - line.did[kind].items.length,
    items: line.did[kind].items.map((item) => ({
      key: item.id,
      id: item.title === null ? null : item.id,
      text: item.title ?? GONE,
    })),
  }));
  const parts = [folded ? null : (REASONS[line.reason] ?? null), summary || null, message].filter(
    (part) => part !== null,
  );
  return {
    id: line.id,
    when: folded ? `${time(line.firstAt)}–${time(line.lastAt)}` : time(line.lastAt),
    says,
    failed,
    detail: parts.length > 0 ? parts.join(' · ') : null,
    did,
  };
}

/** The history's lines, newest first, under the day each last ran on. */
export function historyDays(lines: readonly ConnectionHistoryLine[], now: Date): HistoryDay[] {
  const days: HistoryDay[] = [];
  let key: string | null = null;
  for (const line of lines) {
    const at = new Date(line.lastAt);
    if (dayOf(at) !== key) {
      key = dayOf(at);
      days.push({ key, heading: headingFor(at, now), lines: [] });
    }
    days[days.length - 1]!.lines.push(lineShown(line));
  }
  return days;
}
