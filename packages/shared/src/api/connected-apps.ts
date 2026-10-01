import { z } from 'zod';

/**
 * An app somebody allowed into their Cockpit ("See the apps connected to your
 * Cockpit, and disconnect one", issue 600): the name it registered itself as,
 * which Cockpit has not checked, and when it was connected and last captured.
 */
export const connectedAppSchema = z.object({
  /** Which grant this is, and what disconnecting names. */
  id: z.string(),
  name: z.string(),
  connectedAt: z.iso.datetime(),
  /** `null` for an app that has not captured anything since it was connected. */
  lastCapturedAt: z.iso.datetime().nullable(),
});
export type ConnectedApp = z.infer<typeof connectedAppSchema>;

/** The apps the signed-in person allowed, oldest first. */
export const connectedAppListSchema = z.object({ apps: z.array(connectedAppSchema) });
export type ConnectedAppList = z.infer<typeof connectedAppListSchema>;

/** That an app can no longer reach Cockpit. */
export const appDisconnectedSchema = z.object({ disconnected: z.literal(true) });
export type AppDisconnected = z.infer<typeof appDisconnectedSchema>;
