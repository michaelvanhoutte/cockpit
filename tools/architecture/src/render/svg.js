/** What the diagrams share: escaping, the text-width estimate and word wrapping. */

export const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Text widths are estimated from the character count, since there is no font
 * to measure at build time. The estimate errs wide.
 */
export const SANS = 6.3;
export const MONO = 7.9;

/** The first line `text` wraps to, ending in "…" where words were left off; `cut` says whether any were. */
export function firstLine(text, width, perChar = SANS) {
  const lines = wrap(text, width, perChar);
  if (lines.length < 2) return { text: lines[0], cut: false };
  const capacity = Math.max(8, Math.floor(width / perChar));
  const head = lines[0].length >= capacity ? lines[0].slice(0, capacity - 1) : lines[0];
  return { text: `${head}…`, cut: true };
}

/** `text` broken into lines of at most `width` pixels at `perChar`; a word longer than a line is broken too. */
export function wrap(text, width, perChar = SANS) {
  const capacity = Math.max(8, Math.floor(width / perChar));
  const lines = [];
  let line = '';
  for (let word of String(text).split(/\s+/).filter(Boolean)) {
    while (word.length > capacity) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, capacity));
      word = word.slice(capacity);
    }
    if (line && line.length + 1 + word.length > capacity) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}
