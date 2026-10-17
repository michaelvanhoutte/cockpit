import {
  itemSchema,
  rewriteHistoryResponseSchema,
  signedInSchema,
  workspaceListSchema,
  workspaceSnapshotSchema,
  type WorkspaceSnapshot,
} from '@cockpit/shared';

/**
 * Whether a read this device saved can still be drawn by this version
 * (architecture, "The read model: persisted snapshot, revalidate, push"). Pure:
 * the IndexedDB side is `persistence.tsx`.
 */

/** What the check asks of a schema: Zod's own safeParse. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** What a saved read becomes once checked: the copy to draw, and how many of its Items were left out. */
export interface CheckedRead {
  data: unknown;
  itemsLeftOut: number;
}

/**
 * The read re-parsed by the schema the server's answer was parsed with, or
 * `undefined` where it does not convert reliably.
 *
 * **Re-parsing must change nothing but what was absent.** Zod drops a property
 * its object no longer has, so a dropped one is a property this version does
 * not know; a `.catch` that replaced a value is a value that did not parse. A
 * property absent from the saved read may come back filled - that is an
 * optional or defaulted property this version added - and a required one with
 * no default fails the parse itself.
 */
export function convertsReliably<T>(schema: Schema<T>, saved: unknown): T | undefined {
  const parsed = schema.safeParse(saved);
  if (!parsed.success) return undefined;
  return keptWhole(saved, parsed.data) ? parsed.data : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Whether everything `saved` holds is in `parsed` unchanged, at every depth. */
function keptWhole(saved: unknown, parsed: unknown): boolean {
  if (saved === undefined) return true;
  if (Array.isArray(saved)) {
    return (
      Array.isArray(parsed) &&
      parsed.length === saved.length &&
      saved.every((value, index) => keptWhole(value, parsed[index]))
    );
  }
  if (isPlainObject(saved)) {
    if (!isPlainObject(parsed)) return false;
    return Object.entries(saved).every(
      ([key, value]) => value === undefined || (key in parsed && keptWhole(value, parsed[key])),
    );
  }
  return Object.is(saved, parsed);
}

/**
 * A Workspace's read, its Items checked one by one: one that fails is left out
 * and counted, along with every filing, pair, run, file and association naming
 * it. Any other part failing leaves nothing to draw.
 */
export function checkSavedWorkspace(saved: unknown): CheckedRead | undefined {
  if (!isPlainObject(saved) || !Array.isArray(saved.items)) return undefined;
  const items = saved.items.flatMap((item) => {
    const checked = convertsReliably(itemSchema, item);
    return checked ? [checked] : [];
  });
  const rest = convertsReliably(workspaceSnapshotSchema, { ...saved, items: [] });
  if (!rest) return undefined;
  const kept = new Set(items.map((item) => item.id));
  const data: WorkspaceSnapshot = {
    ...rest,
    items,
    filings: rest.filings.filter((filing) => kept.has(filing.itemId)),
    associations: rest.associations.filter((association) => kept.has(association.itemId)),
    attachments: rest.attachments.filter((attachment) => kept.has(attachment.itemId)),
    agentRuns: rest.agentRuns.filter((run) => kept.has(run.itemId)),
    duplicates: rest.duplicates.filter((pair) => kept.has(pair.itemId) && kept.has(pair.otherItemId)),
  };
  return { data, itemsLeftOut: saved.items.length - items.length };
}

function whole<T>(schema: Schema<T>): (saved: unknown) => CheckedRead | undefined {
  return (saved) => {
    const data = convertsReliably(schema, saved);
    return data === undefined ? undefined : { data, itemsLeftOut: 0 };
  };
}

/**
 * Every read that may be saved, by the first part of its query key, and the
 * check it is restored through. **A read missing here is never saved or
 * restored**, so a read added later is drawn offline only once somebody names
 * the schema it converts by.
 *
 * Left out on purpose, and never to be added:
 *
 * - **the register** (`registeredUsers`): every person's name, address, role and
 *   account, which one admin's browser has no business keeping for a week, and
 *   the one list whose whole point is being current;
 * - **a connection's history** (`connectionHistory`; "See when a pulled
 *   connection was checked, and why it failed, from its row's History…",
 *   issue 1140):
 *   hundreds of lines of a source's failure messages that nothing paints from,
 *   which offline would read as current.
 */
const CHECKS: Record<string, (saved: unknown) => CheckedRead | undefined> = {
  me: whole(signedInSchema),
  workspaces: whole(workspaceListSchema),
  snapshot: checkSavedWorkspace,
  rewriteHistory: whole(rewriteHistoryResponseSchema),
  // `/health`'s one answer the app keeps, read without a shared schema (`api/transcription.ts`).
  'transcription-offered': whole({
    safeParse: (saved: unknown) =>
      typeof saved === 'boolean' ? { success: true as const, data: saved } : { success: false as const },
  }),
};

export function hasCheck(queryKey: readonly unknown[]): boolean {
  return Object.hasOwn(CHECKS, String(queryKey[0]));
}

/** A saved read checked: what to draw, `'unusable'` where it does not convert, `'unchecked'` where no schema is named. */
export function checkSavedRead(
  queryKey: readonly unknown[],
  saved: unknown,
): CheckedRead | 'unusable' | 'unchecked' {
  const check = CHECKS[String(queryKey[0])];
  if (!check || !hasCheck(queryKey)) return 'unchecked';
  return check(saved) ?? 'unusable';
}
