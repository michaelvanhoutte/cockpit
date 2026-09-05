import { z } from 'zod';

/**
 * The colors a Workspace can be dressed in, and the rule that only these are
 * allowed (functional definition, "Container hierarchy": the UI chrome tints to
 * the Workspace's color "so it is always obvious at a glance which Workspace
 * you are currently in").
 *
 * **Shared, because both ends need the same list for different halves of the
 * same rule.** The settings page draws the swatches from it; the server refuses
 * anything that is not one of them. A palette living on only one side would be
 * a palette the other side could not hold anybody to.
 */

/** `#rrggbb`, the one form every color here is written and stored in. */
export const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'a color is #rrggbb, lower case');

/**
 * One workspace theme: four colors designed together, and a stepped set rather
 * than four independent choices.
 *
 * - `tint` is the saturated one, for the tab dot and the selected tab.
 * - `header` is the bar across the top, the deepest of the three surfaces.
 * - `bar` is the strip the dashboard tabs sit on, one step lighter than
 *   `header`.
 * - `ground` is the sheet behind the panels, the lightest.
 *
 * The three surfaces run deepest at the top of the screen to lightest at the
 * bottom, and the two tab strips sit at the steps between them: the selected
 * workspace tab is filled with `bar` and joins the strip below it, and the
 * selected dashboard tab is filled with `ground` and joins the page. That is
 * what makes the container hierarchy legible as depth rather than as two rows
 * of pills on one fill (functional definition, "Container hierarchy").
 *
 * **The two chrome surfaces are near-black and the sheet is near-white**, which
 * is the whole of the step rather than three neighbouring tints of one hue.
 * Chrome and content are different kinds of thing - one is where you are, the
 * other is what you are working on - and the old palette said so with eight
 * values of grey between them, which read as one pale surface with lines drawn
 * on it. The consequence for everything drawn on the chrome is that its text
 * and icons are a fixed light set rather than the app's ink, because a surface
 * this dark cannot carry the ink and no theme is light enough to need it to.
 *
 * Four rather than one because that is what actually makes a workspace
 * recognisable at a glance, and one is all the app had: the tint drove a dot
 * and a three-pixel border, and every workspace shared a page. The prototype
 * themed three of them and hard-coded them per workspace in `poc/prototype/
 * styles.css`, which is exactly why a workspace you made yourself could not be
 * themed at all.
 *
 * **`bar` is stored like the other three rather than mixed from them at render
 * time.** It is a midpoint today, so computing it would work; storing it keeps
 * an entry tunable by hand, and keeps a free color picker later a second writer
 * of the same four fields rather than a migration.
 */
export const workspaceThemeSchema = z.object({
  name: z.string(),
  tint: hexColorSchema,
  bar: hexColorSchema,
  ground: hexColorSchema,
  header: hexColorSchema,
});
export type WorkspaceTheme = z.infer<typeof workspaceThemeSchema>;

/**
 * The palette. Designed sets rather than a free color wheel, which is how the
 * legibility half of the functional definition's open decision "Workspace
 * colors" is kept: you pick, but only from combinations that were checked
 * together. Nothing else in the app recolors - cards, rows, controls and text
 * keep the fixed neutral and accent palette - so no choice here can make
 * anything unreadable.
 *
 * The tints are the ones the app has always handed out and are not touched
 * here: a tint is the colour a person already recognises in the tabs, and it is
 * also the key the change that repaints a workspace's surfaces matches on
 * (`accounts/changes.ts`, `0010-workspace-ink`).
 *
 * **The three surfaces are one set of lightnesses in eight hues**, so a
 * workspace is a near-black in its own colour rather than a near-black in
 * violet, and switching workspace still repaints the shell in front of you.
 *
 * The lightnesses are artboard 2c's ("Cockpit Shell Explorations"); the
 * saturation is not, and the difference is why. Drawn at the artboard's own
 * thirteen percent, two themes are two or three values of blue apart on a
 * near-black bar - measured in the running app, Violet and Blue were
 * indistinguishable side by side, which takes away the one thing the surfaces
 * are for. At around a third they read as a violet-black, a navy-black and a
 * brown-black while staying dark enough for one fixed light set of text.
 *
 * Every `bar` is one step up from its own theme's `header`, which is what "one
 * step lighter" means when both ends are near-black. They are written out
 * rather than computed for the reason the schema gives: an entry stays tunable
 * by hand without the others moving.
 *
 * The order is the order colors are handed out to new workspaces, so a
 * workspace is distinguishable from the moment it exists without anybody being
 * asked.
 */
export const WORKSPACE_THEMES: readonly WorkspaceTheme[] = [
  { name: 'Violet', tint: '#6f62b5', bar: '#211d37', ground: '#edebf7', header: '#18152b' },
  { name: 'Blue', tint: '#3a72c8', bar: '#1d2737', ground: '#ebf0f7', header: '#151e2b' },
  { name: 'Terracotta', tint: '#c06a45', bar: '#37251d', ground: '#f7efeb', header: '#2b1c15' },
  { name: 'Teal', tint: '#3f8f78', bar: '#1d372f', ground: '#ebf7f3', header: '#152b24' },
  { name: 'Magenta', tint: '#a8548c', bar: '#371d2e', ground: '#f7ebf3', header: '#2b1523' },
  { name: 'Amber', tint: '#b58a2f', bar: '#372f1d', ground: '#f7f3eb', header: '#2b2415' },
  { name: 'Cyan', tint: '#4f8fa8', bar: '#1d3037', ground: '#ebf4f7', header: '#15252b' },
  { name: 'Olive', tint: '#7d8f3f', bar: '#31371d', ground: '#f4f7eb', header: '#262b15' },
] as const;

/**
 * What a workspace wears when nothing else fits: the prototype's original, and
 * the one the app was painted in before any of this.
 *
 * It is what an unfamiliar color falls back to. A workspace whose tint is not
 * in the palette is not a corrupt row - it is one that looks slightly wrong -
 * and refusing to show it, or refusing a deploy over it, would be the wrong
 * loudness. Contrast that with two workspaces sharing a name, which is two
 * things a person cannot tell apart, and is refused.
 */
export const DEFAULT_WORKSPACE_THEME: WorkspaceTheme = WORKSPACE_THEMES[0]!;

/**
 * The theme a workspace is wearing, found by its tint, or the default.
 *
 * Looked up by tint because the tint is the one color a workspace has always
 * had: it is what the migration reads to give an existing workspace the rest of
 * its theme, and what the settings page reads to show which swatch is the
 * current one.
 */
export function themeOf(tint: string): WorkspaceTheme {
  return WORKSPACE_THEMES.find((theme) => theme.tint === tint) ?? DEFAULT_WORKSPACE_THEME;
}

/** Whether these four colors are a theme from the palette, exactly. */
export function isPaletteTheme(colors: {
  tint: string;
  bar: string;
  ground: string;
  header: string;
}): boolean {
  return WORKSPACE_THEMES.some(
    (theme) =>
      theme.tint === colors.tint &&
      theme.bar === colors.bar &&
      theme.ground === colors.ground &&
      theme.header === colors.header,
  );
}
