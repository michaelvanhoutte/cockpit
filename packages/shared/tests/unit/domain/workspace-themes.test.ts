import { describe, expect, it } from 'vitest';
import { DARK_GROUND, paintedWorkspace, shellColours } from '../../../src/domain/workspace-shell.js';
import { DEFAULT_WORKSPACE_THEME, WORKSPACE_THEMES, isPaletteTint, themeOf } from '../../../src/domain/workspace-themes.js';

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

/** A colour mixed towards black by the given share of black, as #rrggbb. */
const towardsBlack = (hex: string, black: number) =>
  '#' +
  [1, 3, 5]
    .map((i) => Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * (1 - black)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');

/** The dark appearance's surface and sunk wells (styles.css, `html[data-app-dark]`). */
const DARK_SURFACE = '#24252b';
const DARK_WELL = towardsBlack(DARK_GROUND, 0.44);
const DARK_INBOX_WELL = towardsBlack(DARK_GROUND, 0.34);

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
      it('as deep-accent text on the Inbox’s well', () => {
        // The Inbox's well is the page lifted 38% towards white (styles.css, `well-inbox`).
        expect(contrast(theme.deep, towardsWhite(theme.ground, 0.38))).toBeGreaterThanOrEqual(4.5);
      });
      it('as selected-chip text on the chip’s own fill', () => {
        // The chip is the tint at 14% over white (Layout.tsx, `--color-accent-tint`).
        expect(contrast(theme.deep, towardsWhite(theme.tint, 0.86))).toBeGreaterThanOrEqual(4.5);
      });
      it('as button text on a fill of the workspace colour', () => {
        expect(contrast(theme.onAccent, theme.tint)).toBeGreaterThanOrEqual(4.5);
      });
      it('as the logo’s dot on the top bar', () => {
        // Lifted 30% towards white, as every tint drawn on the chrome is (chrome.ts).
        expect(contrast(towardsWhite(theme.tint, 0.3), theme.header)).toBeGreaterThanOrEqual(3);
      });
    });

    // In dark the accent as text and the selected fill are the shell's own
    // computation (shellColours), so what is held is what it sets.
    describe.each(WORKSPACE_THEMES.map((theme) => [theme.name, shellColours(paintedWorkspace({ color: theme.tint }), 'dark')] as const))(
      '%s stays readable in dark',
      (_name, dark) => {
        it.each([
          { surface: 'the page', behind: DARK_GROUND },
          { surface: 'a dialog', behind: DARK_SURFACE },
          { surface: 'a list’s well', behind: DARK_WELL },
          { surface: 'the Inbox’s well', behind: DARK_INBOX_WELL },
          { surface: 'the selected fill', behind: dark.accentTint },
        ])('as accent text on $surface', ({ behind }) => {
          expect(contrast(dark.accentDeep, behind)).toBeGreaterThanOrEqual(4.5);
        });
        it('as button text on a fill of the workspace colour', () => {
          expect(contrast(dark.onAccent, dark.accent)).toBeGreaterThanOrEqual(4.5);
        });
        it('as the soft accent text on a toast', () => {
          // Written by the undo toast over `--color-toast`, a mix of the tint 55% over white.
          const soft = towardsWhite(dark.accent, 0.45);
          expect(contrast(soft, '#34363e')).toBeGreaterThanOrEqual(4.5);
        });
      },
    );

    it.each([
      { situation: 'the five light colours', names: ['Amber', 'Olive', 'Cyan', 'Teal', 'Terracotta'], text: '#16181d' },
      { situation: 'the three darker colours', names: ['Violet', 'Blue', 'Magenta'], text: '#ffffff' },
    ])('writes button text in $text on $situation', ({ names, text }) => {
      const wearing = WORKSPACE_THEMES.filter((theme) => names.includes(theme.name));

      expect(wearing).toHaveLength(names.length);
      expect(wearing.map((theme) => theme.onAccent)).toEqual(names.map(() => text));
    });

    it('wears the same page and top bar in every theme', () => {
      expect(new Set(WORKSPACE_THEMES.map((theme) => theme.ground)).size).toBe(1);
      expect(new Set(WORKSPACE_THEMES.map((theme) => theme.header)).size).toBe(1);
    });
  });

  describe('a theme is picked by its accent alone', () => {
    // L1: a pure lookup. That the server stores the palette's own four for a
    // pick, whatever the other three say, is proved against a real store in
    // apps/api/tests/integration.
    it.each([
      { situation: 'an accent the palette has', tint: WORKSPACE_THEMES[2]!.tint, recognised: true },
      { situation: 'an accent the palette does not have', tint: '#123456', recognised: false },
    ])('recognises $situation', ({ tint, recognised }) => {
      expect(isPaletteTint(tint)).toBe(recognised);
    });
  });
});
