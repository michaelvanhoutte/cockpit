import { z } from 'zod';

/**
 * The colours a box on a whiteboard can take, and that a Panel takes in a
 * later issue ("Brainstorming: give every Dashboard a whiteboard of its own",
 * issue 1829), as does a line kind ("Brainstorming: the whiteboard can't show
 * how Items connect", issue 1831): the design system's six category colours plus `rose` and `sky`,
 * each with a light and a dark value in `apps/web/src/styles.css`
 * (`--color-cat-<name>` and `-tint`), held to 4.5:1 in both by
 * `appearanceTokens.test.ts`. Stored by name; no colour at all is *None*,
 * stored as null.
 */
export const SWATCHES = ['slate', 'teal', 'green', 'amber', 'rose', 'violet', 'sky', 'grey'] as const;
export type Swatch = (typeof SWATCHES)[number];
export const swatchSchema = z.enum(SWATCHES);
