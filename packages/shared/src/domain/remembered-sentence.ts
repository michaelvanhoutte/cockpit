import { z } from 'zod';

/**
 * A sentence remembered from an edit made before Open ("Remember an edit as a
 * sentence you confirm", issue 1163): one line about how the person wants a kind
 * of action done ("Mails to the accountant: Dutch, short, signed Michael"),
 * shown to every later proposal it fits. Nothing is remembered but a sentence
 * the person pressed *Remember* on, worded as they left it.
 */

/** The longest a remembered sentence is: a line to read at a glance, and a few of them are shown to every proposal. */
export const REMEMBERED_SENTENCE_LIMIT = 240;

/** The longest the kind of action it applies to is named: a few words, "reply to a mail". */
export const REMEMBERED_ACTION_LIMIT = 60;

/** The most remembered sentences one proposal is shown: the few that fit, most used first. */
export const REMEMBERED_SENTENCES_SHOWN = 8;

/** What the offer to remember says, as the window shows it: the sentence, the kind of action it is about, and where it applies. */
export const rememberOfferSchema = z.object({
  sentence: z.string().trim().min(1).max(REMEMBERED_SENTENCE_LIMIT),
  action: z.string().trim().min(1).max(REMEMBERED_ACTION_LIMIT),
  /** The Workspace the sentence names, or null for every Workspace. */
  workspaceId: z.uuid().nullable(),
  workspaceName: z.string().nullable(),
  /** Where the Item the edit was on came from, as the Item names it: what "a kind of action" is matched on. */
  sourceKind: z.string().min(1).max(100),
});
export type RememberOffer = z.infer<typeof rememberOfferSchema>;

/** What asking for an offer answers: the offer, or null where there is nothing to remember. */
export const rememberOfferAnswerSchema = z.object({ offer: rememberOfferSchema.nullable() });
export type RememberOfferAnswer = z.infer<typeof rememberOfferAnswerSchema>;

/**
 * Whether an edit is worth asking about: a proposal the window opened on,
 * changed in its destination, its folder or its prompt before Open. Nothing
 * proposed means nothing was edited, only written. Pure, and here because the
 * window and the server both hold to it.
 */
export function editedTheProposal(
  proposed: { destination: string; folder: string; prompt: string } | null,
  sent: { destination: string; folder: string; prompt: string },
): boolean {
  if (proposed === null || proposed.prompt === '') return false;
  return (
    proposed.destination !== sent.destination ||
    proposed.folder.trim() !== sent.folder.trim() ||
    proposed.prompt.trim() !== sent.prompt.trim()
  );
}
