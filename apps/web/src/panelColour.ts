import type { Swatch } from '@cockpit/shared/board';

/**
 * A Panel's colour as its header and border are painted ("Brainstorming:
 * Panels can't be told apart at a glance", issue 1832): the swatch's ink for
 * the border and the name, and its tint behind the header. The category colour
 * variables hold a light and a dark value each (`@theme static` in
 * `styles.css`), so neither is chosen here.
 */
export const swatchInk = (colour: Swatch) => `var(--color-cat-${colour})`;
export const swatchTint = (colour: Swatch) => `var(--color-cat-${colour}-tint)`;

/** A swatch's name as a menu or a tooltip says it. */
export const swatchLabel = (colour: Swatch) => colour[0]!.toUpperCase() + colour.slice(1);
