import { z } from 'zod';

/**
 * How a source's own website wants an address on a phone, as its connector
 * declares it (`phoneLink` on a manifest, "Open a Gmail Item at its email on a
 * phone", issue 1837): the address stored with an Item opens only the source's
 * inbox there. The address is `https://<host><path>` with the mailbox the stored
 * link names under `mailboxParam`, then `#` and one of the two fragments; a
 * conversation id follows `conversationFragment` as one encoded path segment.
 */
export const phoneLinkSchema = z.object({
  host: z.string().max(255),
  path: z.string().max(255),
  mailboxParam: z.string().max(64),
  conversationFragment: z.string().max(255),
  draftsFragment: z.string().max(255),
  /** What starts a source id that names one email, which the source's phone website cannot open. */
  notAConversationPrefix: z.string().max(64).optional(),
});
export type PhoneLinkDeclaration = z.infer<typeof phoneLinkSchema>;

/** The declarations by connector id, as the snapshot carries them; possibly absent in a copy saved by an older release. */
export type DeclaredPhoneLinks = Readonly<Record<string, PhoneLinkDeclaration>> | undefined;

/**
 * Where a source opens on a phone: the conversation by id, or its Drafts folder
 * where `conversationId` is null. Null where the source declares none, or the
 * stored link is not on the declared host, or the id names one email only, so
 * the caller keeps the stored link. The mailbox is the one the stored link
 * names; none there, and the source opens the first account signed in.
 *
 * The result is only ever `https` on the declared host: the id is encoded into
 * one path segment, so it can never add a second fragment, path or query.
 */
export function phoneAddress(
  declared: DeclaredPhoneLinks,
  source: string,
  storedLink: string,
  conversationId: string | null,
): string | null {
  const how = declared && Object.hasOwn(declared, source) ? declared[source] : undefined;
  if (!how) return null;
  if (conversationId !== null && how.notAConversationPrefix && conversationId.startsWith(how.notAConversationPrefix)) return null;
  let stored: URL;
  try {
    stored = new URL(storedLink);
  } catch {
    return null;
  }
  if (stored.protocol !== 'https:' || stored.hostname.toLowerCase() !== how.host.toLowerCase()) return null;
  const address = new URL(`https://${how.host}${how.path}`);
  const mailbox = stored.searchParams.get(how.mailboxParam);
  if (mailbox) address.searchParams.set(how.mailboxParam, mailbox);
  address.hash = conversationId === null ? how.draftsFragment : `${how.conversationFragment}${encodeURIComponent(conversationId)}`;
  return address.href;
}
