import { z } from 'zod';

/**
 * What the admin's Usage window reads ("Add an admin Usage window for sign-ins
 * and guest sessions", issue 654): who signed in and when, and what guest
 * sessions looked like, over a bounded window of days.
 */

/** How many days the window covers unless the request says otherwise. */
export const USAGE_DEFAULT_DAYS = 30;

/** The most it can cover: the history is kept for twelve months and no longer. */
export const USAGE_MAX_DAYS = 365;

/** One named person: their latest sign-in ever, and the ones inside the window, newest first. */
export const namedUsageSchema = z.object({
  userId: z.string(),
  name: z.string(),
  /** `null` for somebody who has never signed in. */
  latest: z.string().nullable(),
  signIns: z.array(z.string()),
});
export type NamedUsage = z.infer<typeof namedUsageSchema>;

/** Guest sessions on one UTC day, with what guests did in them. */
export const guestDaySchema = z.object({
  /** `YYYY-MM-DD`, in UTC. */
  day: z.string(),
  sessions: z.number().int(),
  itemsCaptured: z.number().int(),
  dashboardsOpened: z.number().int(),
});
export type GuestDay = z.infer<typeof guestDaySchema>;

export const usageSchema = z.object({
  /** The window actually used, after the request's own was bounded. */
  days: z.number().int(),
  /** Where Cloudflare Web Analytics shows page traffic, or `null` where none is configured. */
  analyticsUrl: z.string().nullable(),
  named: z.array(namedUsageSchema),
  guests: z.object({
    perDay: z.array(guestDaySchema),
    /** `country` is `null` for sessions that arrived with none. */
    byCountry: z.array(z.object({ country: z.string().nullable(), sessions: z.number().int() })),
    /**
     * `host` is `null` for sessions that came with no referrer. **Client
     * input**, so display text only: never markup and never a link target.
     */
    byReferrer: z.array(z.object({ host: z.string().nullable(), sessions: z.number().int() })),
  }),
});
export type Usage = z.infer<typeof usageSchema>;
