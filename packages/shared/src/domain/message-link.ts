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
 * What a person typed beside a message link they pasted, the link taken out
 * ("Read pasted Teams links", issue 1755): the words before and after it,
 * joined by one space on the line it stood on, and a Markdown `[name](link)`
 * taken out whole. Empty where the link was all there was.
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
  }
  before = before.replace(/[ \t]+$/, '');
  after = after.replace(/^[ \t]+/, '');
  // A link on a line of its own leaves one line break, not two.
  if (before.endsWith('\n') && after.startsWith('\n')) after = after.slice(1);
  const onOneLine = before !== '' && after !== '' && !before.endsWith('\n') && !after.startsWith('\n');
  return `${before}${onOneLine ? ' ' : ''}${after}`.replace(/\n{3,}/g, '\n\n').trim();
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
