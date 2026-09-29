import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_THEME, WORKSPACE_THEMES, isPaletteTheme, themeOf } from '../../../src/domain/workspace-themes.js';

/** WCAG relative luminance of a `#rrggbb`. */
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two `#rrggbb` colours. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** A colour mixed towards white by the given share of white, as `#rrggbb`. */
const towardsWhite = (hex: string, white: number) =>
  '#' +
  [1, 3, 5]
    .map((i) => Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * (1 - white) + 255 * white))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');

/** What text drawn on the band is: styles.css's `--color-chrome-ink`. */
const NEAR_WHITE = '#f2f1f8';

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

    // L1: contrast is arithmetic on the palette, so every place a theme's colour
    // is drawn is held to it rather than trusted; nothing else fails when one
    // entry is tuned by eye and lands unreadable.
    describe.each(WORKSPACE_THEMES.map((theme) => [theme.name, theme] as const))('%s stays readable', (_name, theme) => {
      it('under near-white text on its band', () => {
        expect(contrast(NEAR_WHITE, theme.bar)).toBeGreaterThanOrEqual(4.5);
      });
      it('as deep-accent text on the neutral page', () => {
        expect(contrast(theme.deep, theme.ground)).toBeGreaterThanOrEqual(4.5);
      });
      it('as deep-accent text on a list’s well', () => {
        // The well is the page lifted 60% towards white (styles.css, `well`).
        expect(contrast(theme.deep, towardsWhite(theme.ground, 0.6))).toBeGreaterThanOrEqual(4.5);
      });
      it('as the logo’s dot on the top bar', () => {
        // Lifted 30% towards white, as every tint drawn on the chrome is (chrome.ts).
        expect(contrast(towardsWhite(theme.tint, 0.3), theme.header)).toBeGreaterThanOrEqual(3);
      });
    });

    it('wears the same page and top bar in every theme', () => {
      expect(new Set(WORKSPACE_THEMES.map((theme) => theme.ground)).size).toBe(1);
      expect(new Set(WORKSPACE_THEMES.map((theme) => theme.header)).size).toBe(1);
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
        // What every workspace stored before the page went neutral: right tint,
        // and surfaces from the palette it replaced.
        situation: 'a set from before the page went neutral',
        colors: { tint: '#6f62b5', bar: '#211d37', ground: '#edebf7', header: '#18152b' },
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
