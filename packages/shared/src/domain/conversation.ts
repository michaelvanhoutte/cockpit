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
});
export type Conversation = z.infer<typeof conversationSchema>;

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
