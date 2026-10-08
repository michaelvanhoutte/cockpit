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
