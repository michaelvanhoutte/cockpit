import { z } from 'zod';

/**
 * What an app was allowed to do ("Read a Panel from an app allowed only to
 * read, and open Capture from its address", issue 1445): create Items, as
 * Claude does and as every app connected before this existed does, or only
 * read your Panels.
 */
export const connectedAppKindSchema = z.enum(['captures', 'reads-panels']);
export type ConnectedAppKind = z.infer<typeof connectedAppKindSchema>;

/**
 * An app somebody allowed into their Cockpit ("See the apps connected to your
 * Cockpit, and disconnect one", issue 600): the name it registered itself as,
 * which Cockpit has not checked, what it may do, and when it was connected and
 * last captured or read.
 */
export const connectedAppSchema = z.object({
  /** Which grant this is, and what disconnecting names. */
  id: z.string(),
  name: z.string(),
  /** Defaulted, for a list a browser kept from before apps could be told apart: every app then was one that captures. */
  kind: connectedAppKindSchema.default('captures'),
  connectedAt: z.iso.datetime(),
  /** `null` for an app that has not captured anything since it was connected, and for one that cannot. */
  lastCapturedAt: z.iso.datetime().nullable(),
  /** `null` for an app that has read no Panel since it was connected, and for one that cannot. */
  lastReadAt: z.iso.datetime().nullable().default(null),
});
export type ConnectedApp = z.infer<typeof connectedAppSchema>;

/** The apps the signed-in person allowed, oldest first. */
export const connectedAppListSchema = z.object({ apps: z.array(connectedAppSchema) });
export type ConnectedAppList = z.infer<typeof connectedAppListSchema>;

/** That an app can no longer reach Cockpit. */
export const appDisconnectedSchema = z.object({ disconnected: z.literal(true) });
export type AppDisconnected = z.infer<typeof appDisconnectedSchema>;
