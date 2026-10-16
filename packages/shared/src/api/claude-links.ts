import { z } from 'zod';

/**
 * Asking for the address a Claude session opens each of an Item's files at,
 * without signing in ("Send an item to Cowork or Claude Code with its prompt
 * reviewed first", issue 1159): the review window puts them in the prompt
 * before anything is sent. Each address works for an hour, as an Agent's do.
 */
export const attachmentLinksRequestSchema = z.object({
  attachmentIds: z.array(z.uuid()).max(50),
});
export type AttachmentLinksRequest = z.infer<typeof attachmentLinksRequestSchema>;

export const attachmentLinksSchema = z.object({
  /** By attachment id. Absent where Cockpit cannot make a link at all, so the prompt names the file instead. */
  links: z.record(z.string(), z.url()),
});
export type AttachmentLinks = z.infer<typeof attachmentLinksSchema>;
