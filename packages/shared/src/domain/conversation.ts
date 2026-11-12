import { z } from 'zod';

/**
 * A conversation an Item follows at its source ("A Gmail starred conversation
 * is one Item whose status follows who wrote last", issue 1705): a Gmail
 * thread, kept as one row per Item and conversation so a second conversation
 * fits later. What the row draws its line from, and nothing else: the status a
 * turn sets lives on the Item.
 *
 * **Who wrote last is `you` or `them`**, as the source sees it: Gmail's Sent
 * label is yours, whatever address it was sent from.
 */
export const conversationTurnBySchema = z.enum(['you', 'them']);
export type ConversationTurnBy = z.infer<typeof conversationTurnBySchema>;

/** How much of the latest message a conversation keeps, for the row's hover. */
export const CONVERSATION_EXCERPT_LENGTH = 280;

export const conversationSchema = z.object({
  itemId: z.uuid(),
  /** The connector the conversation is at, by id (`gmail`); the row names it by `sourceNames`. */
  source: z.string(),
  conversationId: z.string(),
  /** Where the source shows the conversation; only an http(s) address is ever opened. */
  link: z.string(),
  lastBy: conversationTurnBySchema,
  /** Who sent the latest message, as its From names them; null where it names nobody. */
  lastFrom: z.string().nullable(),
  lastAt: z.iso.datetime(),
  /** The latest message's first lines, at most `CONVERSATION_EXCERPT_LENGTH` characters. */
  lastExcerpt: z.string(),
  messageCount: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  /** Who the conversation is with: the latest sender who is not you, where there is one. */
  withWhom: z.string().nullable(),
  /**
   * A draft *Email…* or *Reply…* made in it is still unsent ("Email… makes a
   * Gmail draft the Item then follows", issue 1708): the line reads *Draft
   * started*. Optional: absent reads as none.
   */
  draftStarted: z.boolean().optional(),
  /**
   * The unsent draft is Claude's ("Mail follow-up: a Claude draft looks like any
   * other and cannot be redone…", issue 1732): Draft with Claude wrote it and it
   * has not been found edited since. The line reads *Claude drafted an answer*,
   * and Reply… asks again what Claude should say. Absent: the draft is yours.
   */
  claudeDrafted: z.boolean().optional(),
});
export type Conversation = z.infer<typeof conversationSchema>;

/**
 * What the id of a conversation *Email…* is starting begins with, until the
 * source has made the draft and named the conversation (issue 1708): the row
 * says *Draft started* meanwhile, opens nothing, and is never read for turns.
 */
export const DRAFT_STARTING_PREFIX = 'draft:';

/** Whether a conversation is one *Email…* is still starting, whose source has not named it yet. */
export function isDraftStarting(conversation: Pick<Conversation, 'conversationId'>): boolean {
  return conversation.conversationId.startsWith(DRAFT_STARTING_PREFIX);
}

/** The most characters the points for Claude to say may run to ("Draft with Claude", issue 1730): a box for a few lines, not a document. */
export const DRAFT_POINTS_LIMIT = 2000;

/**
 * A Workspace connection *Email…* can make a draft in (issue 1708): one whose
 * connector starts conversations under the choice it follows, named as the
 * Connections window names it.
 */
export const mailboxSchema = z.object({
  sourceAccountId: z.string(),
  connectorId: z.string(),
  name: z.string(),
  /**
   * Claude can write the draft made here ("Mail follow-up: Reply… in Gmail
   * makes an empty draft…", issue 1730): its connector reads a conversation
   * for a reply, this environment has a Claude key it may spend, and the
   * account is not the guest. Absent: no box, and the empty draft as before.
   */
  claudeDrafts: z.boolean().optional(),
});
export type Mailbox = z.infer<typeof mailboxSchema>;

/**
 * What the id of a LinkedIn conversation starts with ("Follow the LinkedIn
 * conversation instead of the notification", issue 1711). LinkedIn has no
 * connector of its own: the Gmail connector reads a LinkedIn message
 * notification and reports the conversation under LinkedIn's own thread id,
 * behind this prefix so it can never be taken for a Gmail thread, and so the
 * row can say *LinkedIn* with nothing stored beside the id.
 */
export const LINKEDIN_CONVERSATION_PREFIX = 'linkedin:';

/** Whether a conversation is one at LinkedIn, followed through notification emails. */
export function isLinkedInConversation(conversation: Pick<Conversation, 'conversationId'>): boolean {
  return conversation.conversationId.startsWith(LINKEDIN_CONVERSATION_PREFIX);
}

/** The conversation one Item follows out of a Workspace's whole list, or none. */
export function conversationOf(conversations: readonly Conversation[] | undefined, itemId: string): Conversation | undefined {
  return (conversations ?? []).find((conversation) => conversation.itemId === itemId);
}
