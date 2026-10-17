import { HISTORY_KEPT_DAYS, type ConnectionHistoryLine, type NameOutcomeShown } from '@cockpit/shared';

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
  /** The messages whose names the check read, each with what every name did (issue 1197); empty where it read none. */
  named: NamedMessage[];
  /** How many more messages the count says than the line names. */
  namedMore: number;
}

/** A message whose names a check read: named like an Item of `did`, then what each of its names did in words. */
export interface NamedMessage extends DidItem {
  outcomes: string[];
}

/** One kind of what a check did: *New:*, with the Items it names. */
export interface DidList {
  label: string;
  items: DidItem[];
  /** How many more the count says than the Items listed - the line keeps the first few. */
  more: number;
}

/** An Item named by its title now; `id` null where nothing opens it - a dismissed Item, which the Item form does not open, or one not held. */
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

const DISMISSED = ' (dismissed)';

export interface HistoryDay {
  /** The local calendar day, unique among the days. */
  key: string;
  /** *Today*, *Yesterday*, or the day's date - with its year where it is not this one. */
  heading: string;
  lines: HistoryLineShown[];
  /**
   * The one line a quiet past day folds into ("Keep a connection's history 30
   * days, and fold a quiet past day into one line", issue 1145), drawn in
   * place of its lines until they are asked for; null where the day is drawn
   * in full.
   */
  folded: FoldedDay | null;
}

/** A quiet past day as one line: its span, and how many checks did what. */
export interface FoldedDay {
  when: string;
  says: string;
}

/** What a folded day says of the checks that did each kind of thing, in the order a line says them. */
const DAY_SAYS = [
  { kind: 'broughtIn', says: 'brought something in' },
  { kind: 'closed', says: 'closed something' },
  { kind: 'sentBack', says: 'sent something back' },
  { kind: 'refused', says: 'had something refused' },
] as const;

/** Why a check ran, in words; a reason this release does not know says nothing. */
const REASONS: Record<string, string> = {
  scheduled: 'Scheduled',
  'follow-up': 'Follow-up',
  'check-now': 'Check now',
  delivery: 'Delivered',
};

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

/**
 * One line in words. `listed` is what the connection's mark counts in its
 * connector's words (*flagged*), which a line that worked says beside how many
 * its complete listing returned (issue 1196); without it, or on a line with no
 * count, no count is said. `noun` is what the source calls a name (*category*),
 * for the reasons that speak of it (issue 1197).
 */
export function lineShown(line: ConnectionHistoryLine, listed?: string, noun = 'name'): HistoryLineShown {
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
  const read = line.did.named.count;
  const summary = [
    ...KINDS.filter(({ kind }) => line.did[kind].count > 0).map(({ kind, summary }) => `${summary} ${line.did[kind].count}`),
    ...(read > 0 ? [`Read names of ${read}`] : []),
  ].join(', ');
  const named = line.did.named.messages.map((message) => ({
    key: message.id,
    id: message.title === null || message.dismissed ? null : message.id,
    text: message.title === null ? GONE : message.dismissed ? `${message.title}${DISMISSED}` : message.title,
    outcomes: message.names.map((one) => outcomeIn(one, noun)),
  }));
  const did = KINDS.filter(({ kind }) => line.did[kind].count > 0).map(({ kind, label }) => ({
    label,
    more: line.did[kind].count - line.did[kind].items.length,
    items: line.did[kind].items.map((item) => ({
      key: item.id,
      id: item.title === null || item.dismissed ? null : item.id,
      text: item.title === null ? GONE : item.dismissed ? `${item.title}${DISMISSED}` : item.title,
    })),
  }));
  // The source's status stands before its message, as given (issue 1142).
  const answered = failed && line.status !== null ? [`HTTP ${line.status}`, message].filter((part) => part !== null).join(' · ') : message;
  const counted =
    !failed && listed !== undefined && line.listed !== null
      ? `${line.listed} ${listed}${folded || summary ? '' : ', nothing new'}`
      : null;
  const parts = [folded ? null : (REASONS[line.reason] ?? null), summary || null, counted, answered].filter(
    (part) => part !== null,
  );
  return {
    id: line.id,
    when: folded ? `${time(line.firstAt)}–${time(line.lastAt)}` : time(line.lastAt),
    says,
    failed,
    detail: parts.length > 0 ? parts.join(' · ') : null,
    did,
    named,
    namedMore: read - named.length,
  };
}

/** What one name did, in words (issue 1197): `Tasks → filed on Tasks (Privé)`, or `Red: skipped, no Panel by that name`. */
function outcomeIn(one: NameOutcomeShown, noun: string): string {
  if (one.why === null) return `${one.name} → filed on ${one.panel} (${one.dashboard})`;
  const why: Record<string, string> = {
    'no-panel': 'no Panel by that name',
    several:
      one.dashboards !== null && one.dashboards > 1 ? `Panels on ${one.dashboards} Dashboards` : 'more than one Panel by that name',
    followed: `the ${noun} followed`,
    baseline: 'already on it when filing was ticked',
    off: `filing by ${noun} is off`,
    'already-there': `already on ${one.panel} (${one.dashboard})`,
  };
  // A reason this release does not know says only that it was skipped.
  return `${one.name}: skipped${Object.hasOwn(why, one.why) ? `, ${why[one.why]}` : ''}`;
}

/**
 * The history's lines, newest first, under the day each last ran on. A day
 * before today whose checks all worked folds into one line (issue 1145); today,
 * a day with a failure, a day of one line and a day of deliveries - each of
 * which is something a source sent - are drawn in full. So is the oldest day
 * shown where `olderRemain`, since the read stopped partway through it and a
 * failure it did not carry could be that day's.
 */
export function historyDays(
  lines: readonly ConnectionHistoryLine[],
  now: Date,
  olderRemain: boolean,
  listed?: string,
  noun?: string,
): HistoryDay[] {
  const days: { key: string; at: Date; held: ConnectionHistoryLine[] }[] = [];
  for (const line of lines) {
    const at = new Date(line.lastAt);
    if (dayOf(at) !== days.at(-1)?.key) days.push({ key: dayOf(at), at, held: [] });
    days.at(-1)!.held.push(line);
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return days.map(({ key, at, held }, index) => ({
    key,
    heading: headingFor(at, now),
    lines: held.map((line) => lineShown(line, listed, noun)),
    folded: at < today && !(olderRemain && index === days.length - 1) ? foldedDay(held, at) : null,
  }));
}

/** A past day's lines, newest first, as the one line they fold into; null where the day is drawn in full. */
function foldedDay(lines: readonly ConnectionHistoryLine[], day: Date): FoldedDay | null {
  if (lines.length < 2) return null;
  if (lines.some((line) => line.outcome === 'failed' || line.reason === 'delivery')) return null;
  const checks = lines.reduce((sum, line) => sum + line.count, 0);
  const did = DAY_SAYS.flatMap(({ kind, says }) => {
    const checksThatDid = lines.filter((line) => line.did[kind].count > 0).length;
    return checksThatDid > 0 ? [`${checksThatDid} ${says}`] : [];
  });
  const checksThatNamed = lines.filter((line) => line.did.named.count > 0).length;
  if (checksThatNamed > 0) did.push(`${checksThatNamed} read names`);
  // Quiet checks fold across midnight, so the day's oldest line can have begun
  // the day before; the span starts no earlier than the day itself.
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const earliest = Math.min(...lines.map((line) => new Date(line.firstAt).getTime()));
  return {
    when: `${time(new Date(Math.max(dayStart, earliest)).toISOString())}–${time(lines[0]!.lastAt)}`,
    says: did.length > 0 ? [`Checked ${checks} times`, ...did].join(' · ') : `Checked ${checks} times, nothing new`,
  };
}

/**
 * What the history ends with where the store keeps older lines than the read
 * carries (issue 1145): how far back they go, which is the 30 days the history
 * is kept. Null where the read carries every line.
 */
export function olderDaysNote(olderRemain: boolean, now: Date): string | null {
  if (!olderRemain) return null;
  const keptFrom = new Date(now);
  keptFrom.setDate(now.getDate() - HISTORY_KEPT_DAYS);
  const date = keptFrom.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    ...(keptFrom.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `Older days follow, back to ${date}`;
}
