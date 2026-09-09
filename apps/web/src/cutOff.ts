/**
 * Whether a line of text is drawn showing less than it holds, for the hover
 * that spells the rest of it out ("A row shows the next action, or the title"
 * in docs/functional-definition.md, which is where the rule itself lives).
 *
 * **A single pixel is not a cut.** Both widths are rounded to whole pixels, so
 * text that fits to within a fraction of one can still report a pixel more than
 * it has room for, and a label spelled out because of that is a label the
 * reader could already read.
 *
 * Given the two widths rather than an element, so the rule is provable without
 * a layout engine - which the F1 runner has none of, jsdom reporting every
 * element as zero-sized.
 */
export function isCutOff(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > 1;
}
