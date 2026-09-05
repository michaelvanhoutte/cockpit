/**
 * Which addresses a description's link is allowed to carry.
 *
 * **Cockpit's, not the editor's.** Milkdown renders an unsafe scheme as an
 * empty `href`, and so does every other candidate surveyed
 * (docs/rich-text-options.md, "Two corrections to what is written above") - but
 * all of them keep the scheme the person typed in the *stored* Markdown, which
 * is the text a connector, an export or the next editor will read. Refusing at
 * the point the link is made is the only place the dangerous address never gets
 * written down.
 */
const ALLOWED = new Set(['http:', 'https:', 'mailto:']);

/**
 * Characters a browser ignores inside a scheme, so `java\tscript:alert(1)` and
 * `java&#0;script:` both navigate. Stripped before the scheme is read, or the
 * allowlist is checking a string no browser will ever see.
 */
function withoutIgnoredCharacters(address: string): string {
  return [...address]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return !(
        code <= 32 ||
        (code >= 127 && code <= 160) ||
        (code >= 0x200b && code <= 0x200d) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0xfeff
      );
    })
    .join('');
}

/**
 * The address to store, or `null` where it is refused.
 *
 * Something with no scheme at all is a host - `example.com/a`, which is what
 * gets pasted - and becomes `https://`. A scheme that is not on the list is
 * refused rather than repaired: guessing at what `javascript:alert(1)` meant to
 * be is how a refusal becomes a redirect.
 */
export function safeHref(typed: string): string | null {
  const address = withoutIgnoredCharacters(typed.trim());
  if (!address) return null;

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(address)?.[1];
  if (!scheme) return `https://${address}`;
  return ALLOWED.has(`${scheme.toLowerCase()}:`) ? address : null;
}
