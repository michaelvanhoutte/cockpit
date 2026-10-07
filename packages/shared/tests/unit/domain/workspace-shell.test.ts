import { describe, expect, it } from 'vitest';
import { DARK_GROUND, paintedWorkspace, shellColours } from '../../../src/domain/workspace-shell.js';
import { DEFAULT_WORKSPACE_THEME, ON_ACCENT_LIGHT, WORKSPACE_THEMES } from '../../../src/domain/workspace-themes.js';

/** A Workspace as the shell receives it: the four colours it stores, which are its theme's. */
const stored = (theme: (typeof WORKSPACE_THEMES)[number]) => ({
  color: theme.tint,
  bar: theme.bar,
  ground: theme.ground,
  header: theme.header,
});

describe('Appearance', () => {
  describe('the Workspace’s own colours are computed against the page it is drawn on', () => {
    // L1: a pure mapping from a theme and an appearance to the colours the shell sets.
    describe.each(WORKSPACE_THEMES.map((theme) => [theme.name, theme] as const))('%s', (_name, theme) => {
      it('is exactly what the shell has always set, in light', () => {
        expect(shellColours(paintedWorkspace(stored(theme)), 'light')).toEqual({
          ground: theme.ground,
          bar: theme.bar,
          header: theme.header,
          tint: theme.tint,
          accent: theme.tint,
          accentDeep: theme.deep,
          onAccent: theme.onAccent,
          accentHover: theme.onAccent === ON_ACCENT_LIGHT ? theme.deep : `color-mix(in srgb, ${theme.tint} 85%, white)`,
          accentSoft: `color-mix(in srgb, ${theme.tint} 55%, white)`,
          accentTint: `color-mix(in srgb, ${theme.tint} 14%, white)`,
        });
      });

      it('keeps its band, top bar and dot, and sits on the dark page, in dark', () => {
        const dark = shellColours(paintedWorkspace(stored(theme)), 'dark');

        expect(dark).toMatchObject({ ground: DARK_GROUND, bar: theme.bar, header: theme.header, tint: theme.tint, accent: theme.tint });
        expect(dark.accentDeep).not.toBe(theme.deep);
      });
    });

    it.each([
      {
        situation: 'a set from before the palette changed, on a tint the palette has',
        workspace: { color: WORKSPACE_THEMES[3]!.tint, bar: '#211d37', ground: '#edebf7', header: '#18152b' },
        bar: WORKSPACE_THEMES[3]!.bar,
        tint: WORKSPACE_THEMES[3]!.tint,
      },
      {
        situation: 'a tint the palette never had',
        workspace: { color: '#123456', bar: '#211d37', ground: '#edebf7', header: '#18152b' },
        bar: DEFAULT_WORKSPACE_THEME.bar,
        tint: '#123456',
      },
      {
        situation: 'no Workspace at all',
        workspace: undefined,
        bar: DEFAULT_WORKSPACE_THEME.bar,
        tint: DEFAULT_WORKSPACE_THEME.tint,
      },
    ])('draws $situation in its tint’s theme, or the default, on the dark page', ({ workspace, bar, tint }) => {
      expect(shellColours(paintedWorkspace(workspace), 'dark')).toMatchObject({ ground: DARK_GROUND, bar, tint });
    });
  });
});
