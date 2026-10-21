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

/** The most sentences one account keeps: past it, Remember is refused with words, so what every proposal reads from stays small. */
export const REMEMBERED_SENTENCES_KEPT = 100;

/** The most remembered sentences one proposal is shown: the few that fit, most used first. */
export const REMEMBERED_SENTENCES_SHOWN = 8;

/** What the offer to remember says, as the window shows it: the sentence, the kind of action it is about, and where it applies. */
export const rememberOfferSchema = z.object({
  sentence: z.string().trim().min(1).max(REMEMBERED_SENTENCE_LIMIT),
  action: z.string().trim().min(1).max(REMEMBERED_ACTION_LIMIT),
  /** The Workspace the sentence names, or null for every Workspace. Not a uuid: an account's first Workspace is `ws-1`. */
  workspaceId: z.string().nullable(),
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

/** One remembered sentence as Settings lists it ("See and change what Cockpit remembers", issue 1164). */
export const rememberedSentenceViewSchema = z.object({
  id: z.uuid(),
  sentence: z.string(),
  /** The kind of action it applies to, as the model named it. */
  action: z.string(),
  /** Where the Items it applies to came from: a connector or kind of source, as the Item names it. */
  sourceKind: z.string(),
  /**
   * The Workspace it names, or null for every Workspace. Not a uuid: an
   * account's first Workspace is `ws-1`, and a list that would not parse for
   * a sentence naming it would show none of the others either.
   */
  workspaceId: z.string().nullable(),
  /** That Workspace's name, null where it names none or the Workspace is gone. */
  workspaceName: z.string().nullable(),
  useCount: z.number().int().nonnegative(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type RememberedSentenceView = z.infer<typeof rememberedSentenceViewSchema>;

/** The account's remembered sentences, the newest first. */
export const rememberedSentenceListSchema = z.object({
  sentences: z.array(rememberedSentenceViewSchema),
  /**
   * The newest change to a sentence this list holds, stamped by the account's
   * own store, so a tab can skip reading again for an announcement it already
   * holds (`workspaceSnapshotSchema`'s `upTo`, for the list of sentences).
   * Optional: an account that has never changed one has none, and a list from
   * an older Worker has none.
   */
  upTo: z.iso.datetime().optional(),
});
export type RememberedSentenceList = z.infer<typeof rememberedSentenceListSchema>;
