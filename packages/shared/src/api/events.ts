import { z } from 'zod';

/**
 * Push invalidation over SSE (architecture, "The read model" and "How the
 * client talks to the backend"): the server says *that* something changed and
 * when, never what; the client revalidates the snapshot. Payloads stay minimal
 * on purpose — SSE is a doorbell, not a data channel.
 *
 * POC (own-event refetch): "and when" is the new half. It carries no data about
 * the change, only enough for a tab to tell whether the copy it holds already
 * contains it — so the doorbell still does not say who is at the door.
 */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('snapshot_invalidated'),
    workspaceId: z.string(),
    // POC (own-event refetch): when the newest change this event covers was
    // taken, to be compared against a held snapshot's `upTo`. Validated as a
    // datetime because that comparison is a string one, and only fixed-width
    // ISO strings order correctly under it.
    //
    // **Optional, like `upTo`, and for a sharper reason.** Required, an event
    // without it fails this schema and `useServerEvents` drops it whole - so a
    // client that had been deployed ahead of the Worker sending it would go
    // silently deaf to every change. Optional, it cannot satisfy the guard and
    // the tab refetches the way it does today.
    at: z.iso.datetime().optional(),
  }),
  z.object({
    type: z.literal('sync_completed'),
    connectorId: z.string(),
    workspaceId: z.string(),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
