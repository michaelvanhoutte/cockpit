import { z } from 'zod';

/**
 * The colors a Workspace can be dressed in, and the rule that only these are
 * allowed (functional-definition.md, "Container hierarchy"; architecture.md
 * §4.4, "packages/shared: schema and command rationale", for the full design
 * rationale). Shared, because both the workspaces window and the server need
 * the same list for different halves of one rule.
 */

/** `#rrggbb`, the one form every color here is written and stored in. */
export const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, 'a color is #rrggbb, lower case');

/**
 * One workspace theme: four colors designed together, a stepped set rather
 * than four independent choices (architecture.md §4.4).
 *
 * - `tint` is the saturated one, for the tab dot and the selected tab.
 * - `header` is the bar across the top, the deepest of the three surfaces.
 * - `bar` is the strip the dashboard tabs sit on, one step lighter than `header`.
 * - `ground` is the sheet behind the panels, the lightest.
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
 * The palette: designed sets rather than a free color wheel, so the
 * legibility every theme was checked for cannot be picked away from
 * (architecture.md §4.4). Order is the order colors are handed out to new
 * workspaces.
 */
export const WORKSPACE_THEMES = [
  { name: 'Violet', tint: '#6f62b5', bar: '#211d37', ground: '#edebf7', header: '#18152b' },
  { name: 'Blue', tint: '#3a72c8', bar: '#1d2737', ground: '#ebf0f7', header: '#151e2b' },
  { name: 'Terracotta', tint: '#c06a45', bar: '#37251d', ground: '#f7efeb', header: '#2b1c15' },
  { name: 'Teal', tint: '#3f8f78', bar: '#1d372f', ground: '#ebf7f3', header: '#152b24' },
  { name: 'Magenta', tint: '#a8548c', bar: '#371d2e', ground: '#f7ebf3', header: '#2b1523' },
  { name: 'Amber', tint: '#b58a2f', bar: '#372f1d', ground: '#f7f3eb', header: '#2b2415' },
  { name: 'Cyan', tint: '#4f8fa8', bar: '#1d3037', ground: '#ebf4f7', header: '#15252b' },
  { name: 'Olive', tint: '#7d8f3f', bar: '#31371d', ground: '#f4f7eb', header: '#262b15' },
] as const satisfies readonly WorkspaceTheme[];

/**
 * The tint of a theme in the palette, as a type. `themeOf` answers an unknown
 * tint with the default rather than refusing it, which is right for a column
 * read out of a store; it makes a tint *written down in source* a silent
 * mistake, so anything naming one names it as this.
 */
export type WorkspaceTint = (typeof WORKSPACE_THEMES)[number]['tint'];

/** What a workspace wears when nothing else fits — an unrecognised tint's fallback, not a refusal (architecture.md §4.4). */
export const DEFAULT_WORKSPACE_THEME: WorkspaceTheme = WORKSPACE_THEMES[0]!;

/** The theme a workspace is wearing, found by its tint — the one color a workspace has always had — or the default. */
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
