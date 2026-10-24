/**
 * What every Monitor chart draws its series in: eight hues in a fixed order
 * (violet, orange, raspberry, teal, brown, blue, olive, purple) and a grey for
 * other or none, their light and dark values written once in look.ts as
 * `--series-1`..`--series-8` and `--series-grey`. Red (`--over`) is only for
 * what is bad and green (`--good`) only for a verdict that is fine, so neither
 * is a series colour.
 *
 * A series is coloured by what it is, never by its rank among the ones shown.
 * No chart cycles: a series counted by its place on record (an engineer, a
 * model, a feature, a starter, a workflow ever red) takes its place's slot, and
 * the ninth onward fold into one grey "Other".
 */

export const SLOT_COUNT = 8;

type SlotNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const slot = (n: SlotNumber) => `var(--series-${n})`;
/** Violet, orange and blue: the only slots the grey clears, so the series beside a grey takes one of them. */
export const VIOLET = slot(1);
export const ORANGE = slot(2);
export const BLUE = slot(6);
export const GREY = 'var(--series-grey)';
/** Bad, and only bad. */
export const RED = 'var(--over)';

/** The key of the series that ninth-onward keys fold into. */
export const OTHER = '~other';
export const OTHER_LABEL = 'Other';

/** The slot (1 to 8) a key takes by its place among every key on record; null past the eighth, or for a key that is not on record. */
function slotAt(known: readonly string[], key: string): SlotNumber | null {
  const place = known.indexOf(key);
  return place >= 0 && place < SLOT_COUNT ? ((place + 1) as SlotNumber) : null;
}

/** The colour of a key by its place on record, so it keeps its colour whatever the filters leave: grey where it has no slot. */
export const colourByPlace = (known: readonly string[], key: string): string => {
  const n = key === OTHER ? null : slotAt(known, key);
  return n === null ? GREY : slot(n);
};

/** Whether a key has no slot of its own and is drawn inside Other. */
export const isFolded = (known: readonly string[], key: string): boolean => key !== OTHER && slotAt(known, key) === null;

/** A record's amounts per key, with every folded key's added into one Other; keys without one are left as they are. */
export function foldAmounts(amounts: Record<string, number>, folded: (key: string) => boolean): Record<string, number> {
  // A key off the database is free text, so the result has no prototype either: no key can be `__proto__`.
  const out = Object.create(null) as Record<string, number>;
  for (const [key, amount] of Object.entries(amounts)) {
    const into = folded(key) ? OTHER : key;
    out[into] = (out[into] ?? 0) + amount;
  }
  return out;
}

/** A list of series with the folded ones replaced by one Other at the end, where there is any. */
export function foldSeries(series: Named[], folded: (key: string) => boolean): Named[] {
  const kept = series.filter((s) => !folded(s.key));
  return kept.length === series.length ? kept : [...kept, { key: OTHER, label: OTHER_LABEL, short: OTHER_LABEL }];
}

/** A series as the costs and Claude calls pages list it: its key, its name and the short name over a column. */
interface Named {
  key: string;
  label: string;
  short: string;
}
