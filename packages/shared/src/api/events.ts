import { z } from 'zod';

/**
 * Push invalidation over SSE (architecture.md, "The read model" and "How the
 * client talks to the backend"; §4.4 for `snapshot_invalidated`'s `at`).
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot_invalidated'),
    workspaceId: z.string(),
    /** POC (own-event refetch): when the newest change this event covers was taken, compared against a held snapshot's `upTo` (architecture.md §4.4). Optional so an older client stays listening rather than going deaf to every event. */
    at: z.iso.datetime().optional(),
  }),
  z.object({
    type: z.literal('sync_completed'),
    connectorId: z.string(),
    workspaceId: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
