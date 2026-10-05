/**
 * More than a title can use and little enough that the lazy matches below stay
 * cheap: a note of 60,000 characters with a marker on every word would
 * otherwise be searched from each marker to the end.
 */
const READ_LIMIT = 5000;

/** A backslash before one of these is the character itself, written the way Markdown spells it. */
const ESCAPABLE = /\\([\\`*_{}[\]()#+.!<>~-])/gu;
const KEPT = '';

/**
 * A note's words without the Markdown that Capture's toolbar writes around them
 * ("Name a captured Item by its words", issue 755): bold and italic markers, a
 * link's address, list and heading markers, backslash escapes, on one line.
 *
 * Hand-written rather than a Markdown parser, which would add about 15KB to the
 * page a phone opens on and to the Worker. Syntax outside that set, such as a
 * table's pipes, stays as typed, and so does a marker with nothing closing it.
 * Only the start of a long note is read, since a title is cut from the start.
 */
export function plainWords(markdown: string): string {
  return markdown
    .slice(0, READ_LIMIT)
    .split(/\r\n|[\n\r]/u)
    .map(plainLine)
    .join(' ')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim();
}

function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s+/u, '')
    .replace(ESCAPABLE, `${KEPT}$1`)
    .replace(/\[([^\]]*)\]\([^)\s]*\)/gu, '$1')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/gu, '$1')
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/gu, '$1')
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/gu, '$1')
    .replace(/(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/gu, '$1')
    .replaceAll(KEPT, '');
}
