import {
  DEFAULT_WORKSPACE_THEME,
  ON_ACCENT_LIGHT,
  isPaletteTheme,
  themeOf,
  type WorkspaceTheme,
} from './workspace-themes.js';

/** Whether the app is drawn light or dark. What decides it is the web app's (the stored choice, else the device). */
export type Appearance = 'light' | 'dark';

/**
 * The page in the dark appearance, the same in every Workspace like its light
 * counterpart: a near-black, dimmed rather than inverted. The stylesheet's
 * dark `--color-ground` is this, and a test holds the two together.
 */
export const DARK_GROUND = '#1b1c21';

/** The colours a Workspace is dressed in: the four it stores, and the two its theme gives them. */
export interface PaintedWorkspace {
  color: string;
  bar: string;
  ground: string;
  header: string;
  deep: string;
  onAccent: string;
}

/**
 * What the shell sets on itself for a Workspace in one appearance.
 *
 * `bar`, `header` and `tint` (the band, the top bar and the dot) are the
 * Workspace's own in both; the page and the accent as text or as a selected
 * fill are the ones computed against the page behind them.
 */
export interface ShellColours {
  ground: string;
  bar: string;
  header: string;
  tint: string;
  accent: string;
  accentDeep: string;
  onAccent: string;
  accentHover: string;
  accentSoft: string;
  accentTint: string;
}

/** `#rrggbb` of `colour` mixed with `other`, `share` of it being `colour`. */
function mix(colour: string, other: string, share: number): string {
  return (
    '#' +
    [1, 3, 5]
      .map((i) =>
        Math.round(Number.parseInt(colour.slice(i, i + 2), 16) * share + Number.parseInt(other.slice(i, i + 2), 16) * (1 - share)),
      )
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * What a Workspace is painted in.
 *
 * - Light is exactly what the shell has always set, as the `color-mix` it has
 *   always written.
 * - Dark lifts the tint towards white where it is text (45% white), which holds
 *   4.5:1 on the dark page, a well and a dialog in every theme in the palette
 *   (workspace-themes.test.ts); and mixes the selected fill from the tint at 22%
 *   over the dark page, so the fill stays darker than the text on it. The hover
 *   fill and the soft ring are unchanged: a fill is the tint (or its ink) in
 *   either appearance, and the ring is only a tint of the colour.
 */
export function shellColours(painted: PaintedWorkspace, appearance: Appearance): ShellColours {
  const { color, bar, header, deep, onAccent } = painted;
  const common = {
    bar,
    header,
    tint: color,
    accent: color,
    onAccent,
    accentHover: onAccent === ON_ACCENT_LIGHT ? deep : `color-mix(in srgb, ${color} 85%, white)`,
    accentSoft: `color-mix(in srgb, ${color} 55%, white)`,
  };
  if (appearance === 'dark') {
    return {
      ...common,
      ground: DARK_GROUND,
      accentDeep: mix('#ffffff', color, 0.45),
      accentTint: mix(color, DARK_GROUND, 0.22),
    };
  }
  return {
    ...common,
    ground: painted.ground,
    accentDeep: deep,
    accentTint: `color-mix(in srgb, ${color} 14%, white)`,
  };
}

/**
 * What to paint a Workspace in: its own four colours where they are a theme the
 * palette actually has, and otherwise the theme its tint belongs to (or the
 * default), so a copy stored before the palette changed never draws a bar its
 * own text cannot be read on. Nothing at all is the default theme.
 *
 * The tint is never overridden: it is the one colour a person recognises in the
 * tabs, and it is what the fallback is looked up by.
 */
export function paintedWorkspace(
  workspace: { color: string; bar: string; ground: string; header: string } | undefined,
): PaintedWorkspace {
  const fallback = (theme: WorkspaceTheme): PaintedWorkspace => ({
    color: theme.tint,
    bar: theme.bar,
    ground: theme.ground,
    header: theme.header,
    deep: theme.deep,
    onAccent: theme.onAccent,
  });
  if (!workspace) return fallback(DEFAULT_WORKSPACE_THEME);
  const { color, bar, ground, header } = workspace;
  const theme = themeOf(color);
  if (isPaletteTheme({ tint: color, bar, ground, header })) return { ...workspace, deep: theme.deep, onAccent: theme.onAccent };
  return { ...fallback(theme), color };
}
