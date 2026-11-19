import { z } from 'zod';

/**
 * Push invalidation over SSE (architecture.md, "The read model" and "How the
 * client talks to the backend"; §4.4, "packages/shared: schema and command
 * rationale", for `snapshot_invalidated`'s `at`).
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot_invalidated'),
    workspaceId: z.string(),
    /** POC (own-event refetch): when the newest change this event covers was taken, compared against a held snapshot's `upTo` (architecture.md §4.4). Optional so an older client stays listening rather than going deaf to every event. */
    at: z.iso.datetime().optional(),
  }),
  /**
   * A check of a pulled connection ended and wrote its line of the history
   * ("Check a pulled connection now, from its row or its history", issue
   * 1143): an open history view of that connection reads again. Not a change
   * to the snapshot, so a tab does not read that for it.
   */
  z.object({
    type: z.literal('connection_history_changed'),
    workspaceId: z.string(),
    sourceAccountId: z.string(),
    /**
     * What the newest line says ("Inbox: mail you just labelled waits for the five-minute check, or a Check now per connection in Settings: add a ↻ to the Inbox heading that checks them all now", issue 1835), so a tab waiting on the check
     * ticks it off without a read: `at` is the line's last time, `broughtIn`
     * and `closed` what that line did. Optional so an older Worker's
     * announcement still reads.
     */
    outcome: z.enum(['worked', 'failed']).optional(),
    message: z.string().nullable().optional(),
    broughtIn: z.number().int().min(0).optional(),
    closed: z.number().int().min(0).optional(),
    at: z.iso.datetime().optional(),
  }),
  /**
   * A remembered sentence was kept, reworded or deleted ("Show a
   * remembered-sentence change the moment you make it", issue 1370): the list of
   * sentences reads again, and no Workspace does, since none draws one. An older
   * tab fails to parse it and ignores it, which is all it ever needed.
   */
  z.object({
    type: z.literal('remembered_sentences_changed'),
    /** When the newest sentence change this event covers was taken, compared against a held list's `upTo` as a snapshot's is. Optional so an older Worker's announcement always reads. */
    at: z.iso.datetime().optional(),
  }),
  z.object({
    type: z.literal('sync_completed'),
    connectorId: z.string(),
    workspaceId: z.string(),
  }),
]);
/**
 * The live-updates stream's first message, `opened`: the newest change the
 * account had taken when the stream opened, as a snapshot's `upTo` names it.
 * A tab holding a copy older than this read it before a change that no later
 * announcement will name. Absent where the account has never taken a change.
 */
export const streamOpenedSchema = z.object({ upTo: z.iso.datetime().optional() });
export type ServerEvent = z.infer<typeof serverEventSchema>;
