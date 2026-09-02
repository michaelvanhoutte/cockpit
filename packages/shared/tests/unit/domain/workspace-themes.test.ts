import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_THEME, WORKSPACE_THEMES, isPaletteTheme, themeOf } from '../../../src/domain/workspace-themes.js';

describe('Workspace management', () => {
  describe('a workspace wears a whole theme, and one whose color is not from the palette wears the default', () => {
    // L1: which theme a color belongs to is a pure lookup over a fixed list.
    // That the create and recolor paths actually ask it is proved against a
    // real store in apps/api/tests/integration.
    it.each([
      {
        situation: 'a color the palette has',
        color: WORKSPACE_THEMES[3]!.tint,
        expected: WORKSPACE_THEMES[3]!,
      },
      {
        situation: 'a color the palette does not have',
        color: '#123456',
        expected: DEFAULT_WORKSPACE_THEME,
      },
    ])('dresses $situation in every color of its theme', ({ color, expected }) => {
      expect(themeOf(color)).toEqual(expected);
    });

    // The bar is the surface the workspace tabs sit on, between the header
    // above it and the ground below. It is stored like the other three rather
    // than mixed at render time, so an entry can be tuned by hand.
    it('gives every theme a bar between its header and its ground', () => {
      const lightness = (hex: string) =>
        Number.parseInt(hex.slice(1, 3), 16) +
        Number.parseInt(hex.slice(3, 5), 16) +
        Number.parseInt(hex.slice(5, 7), 16);

      for (const theme of WORKSPACE_THEMES) {
        expect(lightness(theme.header), theme.name).toBeLessThan(lightness(theme.bar));
        expect(lightness(theme.bar), theme.name).toBeLessThan(lightness(theme.ground));
      }
    });
  });

  describe('only the palette’s own combinations count as a theme', () => {
    it.each([
      {
        situation: 'a theme exactly as the palette has it',
        colors: {
          tint: WORKSPACE_THEMES[2]!.tint,
          bar: WORKSPACE_THEMES[2]!.bar,
          ground: WORKSPACE_THEMES[2]!.ground,
          header: WORKSPACE_THEMES[2]!.header,
        },
        recognised: true,
      },
      {
        situation: 'colors taken from different themes',
        colors: {
          tint: WORKSPACE_THEMES[1]!.tint,
          bar: WORKSPACE_THEMES[1]!.bar,
          ground: WORKSPACE_THEMES[2]!.ground,
          header: WORKSPACE_THEMES[3]!.header,
        },
        recognised: false,
      },
      {
        // The case the fourth color exists to make possible to get wrong: three
        // right and the new one from somewhere else.
        situation: 'a theme with somebody else’s bar',
        colors: {
          tint: WORKSPACE_THEMES[4]!.tint,
          bar: WORKSPACE_THEMES[5]!.bar,
          ground: WORKSPACE_THEMES[4]!.ground,
          header: WORKSPACE_THEMES[4]!.header,
        },
        recognised: false,
      },
    ])('recognises $situation', ({ colors, recognised }) => {
      expect(isPaletteTheme(colors)).toBe(recognised);
    });
  });
});
