//
// The web app's one rule about colour, radius and shadow that cannot be seen by
// running it: they come from the theme (`apps/web/src/styles.css`), and nothing
// else writes one. A literal that drifts back in is invisible until someone
// compares two screens, so this is the rule as something that fails.
//
// A read of source text, so it runs in the checkout-only Scripts step with the
// rest of `scripts/lib/*.test.mjs`. Font sizes are not part of it.
//

/** The one file allowed to write a literal: the theme itself. */
export const THE_THEME = 'styles.css';

const UTILITY_COLOUR = 'bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|placeholder|shadow';

/** Each shape a literal takes, with what to call it; the specific ones first, since a line is named for the first it matches. */
const SHAPES = [
  {
    kind: 'an arbitrary colour',
    pattern: new RegExp(`\\b(?:${UTILITY_COLOUR})-\\[(?:color:|#|rgba?\\(|hsla?\\(|oklch\\()`),
  },
  { kind: 'an arbitrary radius', pattern: /\brounded(?:-[a-z]{1,2})?-\[(?!var\()/ },
  { kind: 'an arbitrary shadow', pattern: /\b(?:inset-)?shadow-\[(?!var\()(?!color:)/ },
  { kind: 'black', pattern: new RegExp(`\\b(?:${UTILITY_COLOUR})-black\\b`) },
  { kind: 'a hex colour', pattern: /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/ },
  { kind: 'a colour function', pattern: /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/ },
];

/**
 * Every colour, radius or shadow written as a literal in one file's source, as
 * `{ line, kind, text }`. Text rather than a path, so each shape can be
 * asserted without a file.
 *
 * **Runtime variables are not literals**: `bg-[var(--tab-on)]` is the theme
 * reaching a place it cannot reach by name, which is what the sweep is for.
 */
export function literalsOutsideTheTheme(source) {
  const found = [];
  source.split('\n').forEach((text, index) => {
    for (const { kind, pattern } of SHAPES) {
      if (!pattern.test(text)) continue;
      found.push({ line: index + 1, kind, text: text.trim() });
      break;
    }
  });
  return found;
}
