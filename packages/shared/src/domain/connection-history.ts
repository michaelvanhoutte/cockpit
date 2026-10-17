import { z } from 'zod';

/**
 * One line of a connection's history ("See when a pulled connection was
 * checked, and why it failed, from its row's History…", issue 1140): a check,
 * or `count` alike checks in a row folded into one, from `firstAt` to `lastAt`.
 *
 * - `reason` is why the line's first check ran - `scheduled`, `follow-up`,
 *   `check-now` or, for a pushed connection, `delivery`. A bare string, so a client built before another reason is added
 *   still parses the line, and says nothing of why.
 * - `message` is a failure's, as the source gave it and kept to 2 KB, with
 *   `messageCut` where it ran longer; null where it said nothing.
 * - `status` is the HTTP status the source answered a failure with, as given
 *   (issue 1142); null where it gave none.
 * - `did` is what the check did ("Say what each check of a connection brought
 *   in, closed and sent back", issue 1141): per kind the exact `count` and the
 *   first Items by `id`, each named by its title now - `title` null only where
 *   no such Item is held, and `dismissed` where it is dismissed, which the
 *   Item form does not open. An Item of another Workspace is counted and not
 *   listed.
 */
export const itemDidSchema = z.object({ id: z.string(), title: z.string().nullable(), dismissed: z.boolean() });
export const didKindSchema = z.object({ count: z.number().int().min(0), items: itemDidSchema.array() });
/**
 * What one name a message carried did ("Name each category a check read, and
 * whether it filed or why it skipped", issue 1197): filed on `panel` of
 * `dashboard` where `why` is null, otherwise skipped for `why` - a bare string,
 * so a client built before another reason is added still parses it. `dashboards`
 * says how many Dashboards hold a Panel the name matched, where it matched several.
 */
export const nameOutcomeSchema = z.object({
  name: z.string(),
  panel: z.string().nullable().default(null),
  dashboard: z.string().nullable().default(null),
  why: z.string().nullable().default(null),
  dashboards: z.number().int().nullable().default(null),
  /** How many Panels the name matched where it read as a Dashboard-qualified name of several (issue 1198). */
  panels: z.number().int().nullable().default(null),
});
export type NameOutcomeShown = z.infer<typeof nameOutcomeSchema>;
export const messageNamedSchema = itemDidSchema.extend({ names: nameOutcomeSchema.array() });
export const checkDidSchema = z.object({
  broughtIn: didKindSchema,
  closed: didKindSchema,
  sentBack: didKindSchema,
  refused: didKindSchema,
  /** The messages whose names the check read, the exact `count` and the first by Item (issue 1197). */
  named: z.object({ count: z.number().int().min(0), messages: messageNamedSchema.array() }).default({ count: 0, messages: [] }),
});
export type CheckDidShown = z.infer<typeof checkDidSchema>;

export const connectionHistoryLineSchema = z.object({
  id: z.string(),
  outcome: z.enum(['worked', 'failed']),
  reason: z.string(),
  message: z.string().nullable(),
  messageCut: z.boolean(),
  status: z.number().int().nullable(),
  count: z.number().int().min(1),
  firstAt: z.iso.datetime(),
  lastAt: z.iso.datetime(),
  did: checkDidSchema,
  /** How many messages the check's complete listing returned (issue 1196); null where it listed nothing completely, and on a line from before it. */
  listed: z.number().int().min(0).nullable().default(null),
});
export type ConnectionHistoryLine = z.infer<typeof connectionHistoryLineSchema>;

/**
 * How many days a connection's history is kept ("Keep a connection's history
 * 30 days, and fold a quiet past day into one line", issue 1145): the nightly
 * run deletes every line that last ran before then.
 */
export const HISTORY_KEPT_DAYS = 30;

/**
 * A connection's history, newest line first and at most a fixed number of
 * lines; `olderRemain` where the store keeps older lines than the read carries
 * ("Keep a connection's history 30 days, and fold a quiet past day into one
 * line", issue 1145). Absent reads as none.
 */
export const connectionHistorySchema = z.object({
  lines: connectionHistoryLineSchema.array(),
  olderRemain: z.boolean().default(false),
});
export type ConnectionHistory = z.infer<typeof connectionHistorySchema>;

/**
 * What pressing *Check now* did ("Check a pulled connection now, from its row
 * or its history", issue 1143): `queued` a check due at once; `already queued`
 * one that was, now labelled *Check now*; `running` one under way, which keeps
 * its own reason. Each leaves exactly one check.
 */
export const checkedNowSchema = z.object({
  status: z.enum(['queued', 'already queued', 'running']),
});
export type CheckedNow = z.infer<typeof checkedNowSchema>;
