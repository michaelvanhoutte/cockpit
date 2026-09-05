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
 * Whether what sits in front of a colon is a machine rather than a scheme.
 *
 * A colon does not make a scheme: `example.com:8080/a` and `localhost:3000` are
 * hosts with a port, and a scheme may itself contain digits and dots, so the
 * two cannot be told apart by shape alone. What separates them here is that a
 * host is named like one - it has a dot in it, or it is `localhost` - and that
 * what follows the colon is a port and then the end of the address or its path.
 *
 * Anything else in front of a colon is a scheme, and goes to the allowlist:
 * `tel:0201234567` is refused rather than turned into a web address, which is
 * what a rule of "digits mean a port" did.
 */
function isAMachineWithAPort(before: string, after: string): boolean {
  const named = before.includes('.') || before.toLowerCase() === 'localhost';
  return named && /^\d+(?:[/?#]|$)/.test(after);
}

/**
 * The address to store, or `null` where it is refused.
 *
 * Something with no scheme at all is a host - `example.com/a`, which is what
 * gets pasted - and becomes `https://`. A scheme that is not on the list is
 * refused rather than repaired: guessing at what `javascript:alert(1)` meant to
 * be is how a refusal becomes a redirect.
 *
 * **What is stored is what was typed, minus the surrounding whitespace.** The
 * ignorable characters are stripped to *read* the scheme and nowhere else,
 * because a browser strips them the same way before it reads one - so the
 * stripped form is what the allowlist has to judge, and the typed form is what
 * the link has to keep. Storing the stripped form silently rewrote
 * `https://example.com/Shared Documents/plan.docx` into a different address.
 */
export function safeHref(typed: string): string | null {
  const address = typed.trim();
  const forReadingTheScheme = withoutIgnoredCharacters(address);
  if (!forReadingTheScheme) return null;

  const named = /^([a-z][a-z0-9+.-]*):(.*)$/is.exec(forReadingTheScheme);
  if (!named) return `https://${address}`;

  const scheme = named[1] ?? '';
  const afterTheColon = named[2] ?? '';
  if (ALLOWED.has(`${scheme.toLowerCase()}:`)) return address;
  return isAMachineWithAPort(scheme, afterTheColon) ? `https://${address}` : null;
}
