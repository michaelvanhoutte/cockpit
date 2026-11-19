import {
  demoPageOf,
  firstMessageLink,
  isDraftStarting,
  isLinkedInConversation,
  phoneAddress,
  type Conversation,
  type DeclaredPhoneLinks,
  type Item,
  type WorkspaceSnapshot,
} from '@cockpit/shared';

/**
 * What each source is called, by its connector id, as the Workspace's snapshot
 * carries it. Possibly absent: a copy kept from a release that did not send it
 * is restored without it.
 */
export type SourceNames = WorkspaceSnapshot['sourceNames'];

/**
 * The addresses of each source's own messages, by connector id, as the
 * snapshot carries them; possibly absent, as `SourceNames` is.
 */
export type MessageLinks = WorkspaceSnapshot['messageLinks'];

/**
 * How each source's own website wants an address on a phone, by connector id,
 * as the snapshot carries them, and only where the device is a phone
 * (`phoneLinksOnThisDevice`): undefined opens every stored link as it was.
 */
export type PhoneLinks = DeclaredPhoneLinks;

/**
 * What a conversation is opened by on a phone: the one an Item follows, once
 * its source has named it - never one *Email…* is still starting, and never a
 * LinkedIn one, whose id names no mailbox conversation.
 */
export function followedConversationId(conversation: Conversation | null | undefined): string | null {
  return conversation && !isDraftStarting(conversation) && !isLinkedInConversation(conversation) ? conversation.conversationId : null;
}

/**
 * What a source's own phone website opens, for the Item: the conversation it
 * follows, in that conversation's own mailbox, where it is at the Item's own
 * source; else the id its source gave it where that names a conversation (an
 * older Item brought in by one email names none: the stored link). A
 * conversation *Email…* started from another mailbox or source is never put in
 * the Item's own mailbox. Null where the source declares no phone address.
 */
function phoneAddressOfItem(item: Item, conversation: Conversation | null | undefined, phone: PhoneLinks, link: string): string | null {
  const id = conversation && conversation.source === item.source ? followedConversationId(conversation) : null;
  const followed = id ? phoneAddress(phone, item.source, conversation!.link, id) : null;
  if (followed) return followed;
  return item.sourceId ? phoneAddress(phone, item.source, link, item.sourceId) : null;
}

/**
 * What a source is called on screen ("Take source names out of the shared
 * contract", issue 927): its connector's own name, where the environment
 * registers it, and the id itself where it does not - so a source this app was
 * never built with still reads as something.
 */
export function sourceNamed(names: SourceNames, source: string): string {
  // Own keys only, so an id such as `constructor` is never read off the prototype.
  return names && Object.hasOwn(names, source) ? names[source]! : source;
}

/** Where Cockpit draws the page for one of the guest demo's addresses (`DemoPage`, pages/DemoPage.tsx). */
export const demoPath = (page: string) => `/demo/${page}`;

/**
 * Where a stored link is opened: the guest demo's own addresses become
 * Cockpit's page for them (issue 773), one on the demo host that names no page
 * opens nothing (null), and any other link passes through as it was. Both the
 * *Open ↗* of an Item and a run's ↗ ask this one place.
 */
export function whereALinkOpens(link: string): string | null {
  const demo = demoPageOf(link);
  if (demo === 'unknown') return null;
  return demo ? demoPath(demo) : link;
}

/**
 * The app that captured an Item, by the name it registered under - null for an
 * Item that no app captured.
 *
 * **The row and the form say this name where the source goes**, and no sender
 * beside it: "Task · Claude", not "mcp · Claude". The protocol is how it got
 * here, not who it is.
 */
export function capturingApp(item: Pick<Item, 'source' | 'sender'>): string | null {
  return item.source === 'mcp' ? (item.sender ?? 'An app') : null;
}

/**
 * Where an Item came from, as its row says it: the capturing app, *Own* for a
 * note typed in here, otherwise the source by its connector's name. The sender
 * is the row's to add beside it. The row and a duplicate warning's cards say
 * this one thing ("Choose which of two possible duplicates to keep, from the
 * warning", issue 1451).
 */
export function sourceOnARow(item: Pick<Item, 'source' | 'sender'>, names: SourceNames): string {
  return capturingApp(item) ?? (item.source === 'internal' ? 'Own' : sourceNamed(names, item.source));
}

/**
 * Where an Item can be opened at its source ("Open an Item at its source",
 * issue 487): the source's own name and the link back to the original.
 *
 * Null for an Item with no way back - one whose source never gave a link - so
 * every surface asks this one place rather than each deciding for itself what
 * "has a source link" means.
 *
 * **An Item with no stored link of its own, and no connector behind it** (one
 * captured in Cockpit, or by an app) is opened at the first link in its
 * description, then in its captured message, that a connector declared as one
 * of its message links ("Open Items captured with a pasted Teams message link
 * in Teams", issue 1738), under that connector's name; found here each time
 * and never stored. A Gmail, Outlook or Teams Item keeps what its source gave.
 *
 * **Only a web address is ever a link.** The stored field is any URL the schema
 * parses, `javascript:` and `data:` included, and this is the first place it is
 * put in an `href`; a connector that let one through would otherwise run script
 * in this page from a click on a row.
 *
 * **The guest demo's own addresses are translated here, once, for every
 * surface** (issue 773): a link on the reserved demo host opens Cockpit's own
 * page for that source rather than the source, and one on it that names no page
 * opens nothing. Any other link - a named person's real one included - passes
 * through as it was.
 *
 * **On a phone a source that declares how its website wants an address gets
 * it** (`phoneLinks`, "Open a Gmail Item at its email on a phone", issue 1837):
 * the conversation the Item follows at its own source, in that conversation's
 * own mailbox and never a LinkedIn one, else its source id where that names
 * one, in the stored link's mailbox; an Item that knows neither keeps its
 * stored link, and a link the guest demo translated is never turned into one.
 */
export function openableAtSource(
  item: Item,
  names: SourceNames,
  messageLinks?: MessageLinks,
  phone?: { links: PhoneLinks; conversation: Conversation | null | undefined },
): { name: string; link: string } | null {
  if (!item.sourceLink && (item.source === 'internal' || item.source === 'mcp')) {
    const found = firstMessageLink(item.description, messageLinks) ?? firstMessageLink(item.capturedMessage, messageLinks);
    return found === null ? null : { name: sourceNamed(names, found.source), link: found.link };
  }
  if (item.source === 'internal' || !item.sourceLink) return null;
  if (!/^https?:\/\//i.test(item.sourceLink)) return null;
  const name = capturingApp(item) ?? sourceNamed(names, item.source);
  const link = whereALinkOpens(item.sourceLink);
  if (link === null) return null;
  // On a phone, where the source declares how its website wants an address - never for a link the guest demo translated.
  const onThePhone = phone?.links && link === item.sourceLink ? phoneAddressOfItem(item, phone.conversation, phone.links, link) : null;
  return { name, link: onThePhone ?? link };
}

