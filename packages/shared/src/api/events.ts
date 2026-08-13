import { z } from 'zod';

/**
 * Push invalidation over SSE (architecture §5.2, §5.5): the server only ever
 * says "something changed"; the client revalidates the snapshot. Payloads stay
 * minimal on purpose — SSE is a doorbell, not a data channel.
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot_invalidated'),
    workspaceId: z.string(),
  }),
  z.object({
    type: z.literal('sync_completed'),
    connectorId: z.string(),
    workspaceId: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
