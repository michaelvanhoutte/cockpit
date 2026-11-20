/**
 * The addresses of each source's own messages, by connector id, as connectors
 * declare them (`messageLinks` on a manifest, "Open Items captured with a pasted
 * Teams message link in Teams", issue 1738).
 */
export type DeclaredMessageLinks = Readonly<Record<string, readonly { host: string; pathStart: string }[]>> | undefined;

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
 * The link is as it stands in the text.
 */
export function firstMessageLink(
  text: string | null | undefined,
  messageLinks: DeclaredMessageLinks,
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

/**
 * The first web page or PDF links in a text, at most `limit`, in the order they
 * appear ("Capture link summaries", issue 1853): each `http` or `https`
 * address, found as `firstMessageLink` finds one, that no connector declared,
 * so a Teams link a connector reads or cannot read is never taken for a page.
 * A link written twice counts once.
 */
export function webLinks(text: string | null | undefined, messageLinks: DeclaredMessageLinks, limit: number): string[] {
  const found: string[] = [];
  if (!text) return found;
  for (const [run] of text.matchAll(/https?:\/\/[^\s\]>"<]+/gi)) {
    if (found.length >= limit) break;
    const candidate = withoutTrailingPunctuation(run);
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const host = url.hostname.toLowerCase();
    const declared = Object.values(messageLinks ?? {}).some((links) =>
      links.some((one) => one.host.toLowerCase() === host && url.pathname.startsWith(one.pathStart)),
    );
    if (!declared && !found.includes(candidate)) found.push(candidate);
  }
  return found;
}

/** The first web page or PDF link in a text, or null where there is none. */
export function firstWebLink(text: string | null | undefined, messageLinks: DeclaredMessageLinks): string | null {
  return webLinks(text, messageLinks, 1)[0] ?? null;
}

/**
 * What a person typed beside a message link they pasted, the link taken out
 * ("Read pasted Teams links", issue 1755): the words before and after it,
 * joined by one space on the line it stood on, and the Markdown around it
 * taken out whole: `[name](link)`, `[link](link)` and `<link>`, the last two
 * being how the capture box writes a link it was handed bare. Empty where the
 * link was all there was.
 */
export function wordsBesideTheLink(text: string, link: string): string {
  const at = text.indexOf(link);
  if (at < 0) return text.trim();
  let before = text.slice(0, at);
  let after = text.slice(at + link.length);
  const markdown = /\[[^\]\n]*\]\($/.exec(before);
  if (markdown && after.startsWith(')')) {
    before = before.slice(0, markdown.index);
    after = after.slice(1);
  } else if (before.endsWith('[') && after.startsWith(`](${link})`)) {
    before = before.slice(0, -1);
    after = after.slice(link.length + 3);
  } else if (before.endsWith('<') && after.startsWith('>')) {
    before = before.slice(0, -1);
    after = after.slice(1);
  }
  before = before.replace(/[ \t]+$/, '');
  after = after.replace(/^[ \t]+/, '');
  // A link on a line of its own leaves one line break, not two.
  if (before.endsWith('\n') && after.startsWith('\n')) after = after.slice(1);
  const onOneLine = before !== '' && after !== '' && !before.endsWith('\n') && !after.startsWith('\n');
  return `${before}${onOneLine ? ' ' : ''}${after}`.replace(/\n{3,}/g, '\n\n').trim();
}

/** What a person typed beside several links they pasted: `wordsBesideTheLink` for each in turn. */
export function wordsBesideTheLinks(text: string, links: readonly string[]): string {
  return links.reduce((words, link) => wordsBesideTheLink(words, link), text.trim());
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
