import { z } from 'zod';

/**
 * The requests behind *Follow a sent email…* in Capture ("Follow a sent email…
 * in Capture", issue 1710). Its own entry point (`@cockpit/shared/sent-emails`),
 * outside the package's index, so the app fetches it with the list's chunk
 * rather than in its initial bundle.
 */

/** How many sent emails the list shows, newest first, across the Workspace's mailboxes. */
export const SENT_EMAILS_SHOWN = 10;

/** One sent email, as the list shows it and the pick sends it back. */
export const sentEmailSchema = z.object({
  /** The connection (mailbox) it was sent from. */
  sourceAccountId: z.string().min(1),
  connectorId: z.string().min(1),
  /** That connection's name, as Settings shows it. */
  mailbox: z.string(),
  conversationId: z.string().min(1).max(500),
  subject: z.string().max(200),
  to: z.string().max(200).nullable(),
  sentAt: z.iso.datetime(),
  /** Where the source shows the conversation: always an https address. */
  link: z.string().max(2_000).regex(/^https:\/\//),
  excerpt: z.string().max(280),
});
export type SentEmailEntry = z.infer<typeof sentEmailSchema>;

/** The list: the newest sent emails, and the mailboxes that could not be read, each with why. */
export const sentEmailsSchema = z.object({
  emails: z.array(sentEmailSchema).max(SENT_EMAILS_SHOWN),
  failing: z.array(z.object({ mailbox: z.string(), why: z.string() })),
});
export type SentEmails = z.infer<typeof sentEmailsSchema>;

/** Whether the Workspace has a connection to list sent mail from: whether Capture offers *Follow a sent email…*. */
export const sentEmailsAvailableSchema = z.object({ available: z.boolean() });
export type SentEmailsAvailable = z.infer<typeof sentEmailsAvailableSchema>;

/**
 * A sent email picked: what the list showed, and where it is filed as Capture's
 * *Where* and *File on* have it (an Item in the Inbox, of every Workspace until
 * somebody says which, unless `decided`).
 */
export const followSentAskedSchema = sentEmailSchema.omit({ connectorId: true, mailbox: true }).extend({
  /** The Item's title, so never empty. */
  subject: z.string().trim().min(1).max(200),
  decided: z.boolean(),
  panelIds: z.array(z.uuid()).max(50).optional(),
});
export type FollowSentAsked = z.infer<typeof followSentAskedSchema>;

/** The Item that follows the conversation: made now, or the open one that already did. */
export const followSentAnswerSchema = z.object({ itemId: z.uuid(), made: z.boolean() });
export type FollowSentAnswer = z.infer<typeof followSentAnswerSchema>;
