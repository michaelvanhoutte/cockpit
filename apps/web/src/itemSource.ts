import { demoPageOf, type Item, type WorkspaceSnapshot } from '@cockpit/shared';

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
 */
export function openableAtSource(
  item: Item,
  names: SourceNames,
  messageLinks?: MessageLinks,
): { name: string; link: string } | null {
  if (!item.sourceLink && (item.source === 'internal' || item.source === 'mcp')) {
    const found = firstMessageLink(item.description, messageLinks) ?? firstMessageLink(item.capturedMessage, messageLinks);
    return found === null ? null : { name: sourceNamed(names, found.source), link: found.link };
  }
  if (item.source === 'internal' || !item.sourceLink) return null;
  if (!/^https?:\/\//i.test(item.sourceLink)) return null;
  const name = capturingApp(item) ?? sourceNamed(names, item.source);
  const link = whereALinkOpens(item.sourceLink);
  return link === null ? null : { name, link };
}

/**
 * The first message link in a text, or null, with the connector that declared
 * it. A candidate is an `https?://` run up to whitespace, a square or angle
 * bracket or a double quote, less the sentence punctuation after it and any
 * closing parenthesis it never opened: so a Markdown `[name](link)` or "see
 * link." gives the link alone, while a channel link keeps the `(` `)` and `'`
 * that Teams leaves unencoded in a team or channel name. It counts only when it
 * parses as an `https` address whose host is exactly a declared one and whose
 * path starts with that declaration's. It is text somebody else may have
 * written and goes into an `href`, so the parsed host decides, never a pattern
 * over the text. No declarations (a copy from a release that sent none): none.
 */
export function firstMessageLink(
  text: string | null | undefined,
  messageLinks: MessageLinks,
): { source: string; link: string } | null {
  if (!text || !messageLinks) return null;
  for (const [run] of text.matchAll(/https?:\/\/[^\s\]>"<]+/gi)) {
    const candidate = withoutTrailingPunctuation(run);
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    const host = url.hostname.toLowerCase();
    for (const [source, declared] of Object.entries(messageLinks)) {
      if (declared.some((one) => one.host.toLowerCase() === host && url.pathname.startsWith(one.pathStart))) {
        return { source, link: candidate };
      }
    }
  }
  return null;
}

/** A link as written in a sentence, less the punctuation that ends the sentence and a `)` that closes something around it. */
function withoutTrailingPunctuation(run: string): string {
  let link = run;
  for (;;) {
    const last = link.at(-1);
    if (last && ".,;:!?'".includes(last)) link = link.slice(0, -1);
    else if (last === ')' && link.split(')').length > link.split('(').length) link = link.slice(0, -1);
    else return link;
  }
}
