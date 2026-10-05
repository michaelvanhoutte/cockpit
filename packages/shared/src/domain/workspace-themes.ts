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

/** The neutral page every workspace shares: its lists' wells are mixed from it, so no hollow carries a hue. */
export const NEUTRAL_GROUND = '#f3f3f1';

/** The top of the soft graphite gradient the top bar and the agents' dock wear in every workspace. */
export const NEUTRAL_HEADER = '#2d2e35';

/**
 * One workspace theme: what a workspace wears, designed together
 * (architecture.md §4.4).
 *
 * - `tint` is the saturated one: the accent, the tab dot, the logo's dot.
 * - `bar` is the dashboard band, a deep shade of the tint that near-white text
 *   reads on, chosen per theme rather than mixed.
 * - `ground` and `header` are the same two neutrals in every theme - the page,
 *   and the top of the graphite chrome. They stay in the stored colors so a
 *   later step can drop the columns without this changing.
 * - `deep` is the tint where it is text: dark enough to read on the page and on
 *   a list's well and on the selected chip's fill. Not stored; found by tint
 *   like the rest.
 * - `onAccent` is the text on a fill of the tint (a button): white, or dark ink
 *   where white reads under 4.5:1. Not stored either.
 */
export const workspaceThemeSchema = z.object({
  name: z.string(),
  tint: hexColorSchema,
  bar: hexColorSchema,
  ground: hexColorSchema,
  header: hexColorSchema,
  deep: hexColorSchema,
  onAccent: hexColorSchema,
});
export type WorkspaceTheme = z.infer<typeof workspaceThemeSchema>;

const GROUND = NEUTRAL_GROUND;
const HEADER = NEUTRAL_HEADER;

/** The two inks text is written in on a fill of a theme's tint: white, or the brand's strongest ink where white falls short of 4.5:1. */
export const ON_ACCENT_LIGHT = '#ffffff';
export const ON_ACCENT_INK = '#16181d';

/**
 * The palette: designed sets rather than a free color wheel, so the
 * legibility every theme was checked for cannot be picked away from
 * (architecture.md §4.4). Order is the order colors are handed out to new
 * workspaces.
 */
export const WORKSPACE_THEMES = [
  { name: 'Violet', tint: '#6f62b5', bar: '#594e91', ground: GROUND, header: HEADER, deep: '#6b5eae', onAccent: ON_ACCENT_LIGHT },
  { name: 'Blue', tint: '#3a72c8', bar: '#2e5ba0', ground: GROUND, header: HEADER, deep: '#3568b7', onAccent: ON_ACCENT_LIGHT },
  { name: 'Terracotta', tint: '#c06a45', bar: '#9a5537', ground: GROUND, header: HEADER, deep: '#9e5739', onAccent: ON_ACCENT_INK },
  { name: 'Teal', tint: '#3f8f78', bar: '#327260', ground: GROUND, header: HEADER, deep: '#347663', onAccent: ON_ACCENT_INK },
  { name: 'Magenta', tint: '#a8548c', bar: '#864370', ground: GROUND, header: HEADER, deep: '#9b4e81', onAccent: ON_ACCENT_LIGHT },
  { name: 'Amber', tint: '#b58a2f', bar: '#866623', ground: GROUND, header: HEADER, deep: '#886823', onAccent: ON_ACCENT_INK },
  { name: 'Cyan', tint: '#4f8fa8', bar: '#3f7286', ground: GROUND, header: HEADER, deep: '#3f7286', onAccent: ON_ACCENT_INK },
  { name: 'Olive', tint: '#7d8f3f', bar: '#637132', ground: GROUND, header: HEADER, deep: '#647232', onAccent: ON_ACCENT_INK },
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
