import { describe, expect, it } from 'vitest';
import { DARK_GROUND, WORKSPACE_THEMES, paintedWorkspace, shellColours } from '@cockpit/shared';
import styles from '../../src/styles.css?raw';

/** WCAG contrast ratio of two `#rrggbb`. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((i) => {
      const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `#rrggbb` of `colour` mixed towards black by `share` percent, as the stylesheet's wells are. */
function towardsBlack(hex: string, share: number): string {
  return (
    '#' +
    [1, 3, 5]
      .map((i) => Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * (share / 100)).toString(16).padStart(2, '0'))
      .join('')
  );
}

const darkBlock = /html\[data-app-dark\]\s*\{([^}]*)\}/.exec(styles)?.[1] ?? '';
/** A colour the dark appearance gives a name, or the light one's where the dark one does not change it. */
function dark(name: string): string {
  const own = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`).exec(darkBlock)?.[1];
  const light = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6});`).exec(styles)?.[1];
  const found = own ?? light;
  if (!found) throw new Error(`no --color-${name} in styles.css`);
  return found;
}
/** How far the dark well of a given class is mixed towards black. */
function wellShare(selector: string): number {
  const share = new RegExp(`html\\[data-app-dark\\] \\.${selector} \\{\\s*background-color: color-mix\\(in srgb, var\\(--ground, var\\(--color-ground\\)\\) (\\d+)%, black\\)`).exec(styles)?.[1];
  if (!share) throw new Error(`no dark .${selector} in styles.css`);
  return Number(share);
}

describe('Appearance', () => {
  describe('in dark, every text is at least 4.5:1 on what it is drawn on', () => {
    const page = dark('ground');
    const surface = dark('surface');
    const well = towardsBlack(page, wellShare('well'));
    const inboxWell = towardsBlack(page, wellShare('well-inbox'));

    it('draws the dark page in the one ground the shell is computed against', () => {
      expect(page).toBe(DARK_GROUND);
    });

    it.each([
      { situation: 'the page', behind: page },
      { situation: 'a dialog', behind: surface },
      { situation: 'a list’s well', behind: well },
      { situation: 'the Inbox’s well', behind: inboxWell },
      { situation: 'a text field', behind: dark('field') },
    ])('body, heading, secondary and faint ink on $situation', ({ behind }) => {
      for (const ink of ['ink-strong', 'ink', 'ink-soft', 'ink-faint']) {
        expect(contrast(dark(ink), behind), ink).toBeGreaterThanOrEqual(4.5);
      }
    });

    it.each([
      { pill: 'a deadline within a week', text: 'due-ink', on: page },
      { pill: 'a deadline within two days', text: 'due-ink', on: dark('due-soft') },
      { pill: 'a deadline today', text: 'due-deep', on: dark('due') },
      { pill: 'a deadline passed', text: 'on-accent', on: dark('over-deep') },
      { pill: 'an error line on the page', text: 'over-ink', on: page },
      { pill: 'an error line on a dialog', text: 'over-ink', on: surface },
      { pill: 'an error line in a well', text: 'over-ink', on: well },
    ])('$pill', ({ text, on }) => {
      // `over-deep` carries white (`on-accent` is white in either appearance); the rest carry their ink.
      expect(contrast(text === 'on-accent' ? '#ffffff' : dark(text), on)).toBeGreaterThanOrEqual(4.5);
    });

    it.each(['slate', 'teal', 'amber', 'green', 'violet', 'grey'])('the %s category on its tint, the page and a well', (category) => {
      for (const behind of [dark(`cat-${category}-tint`), page, well]) {
        expect(contrast(dark(`cat-${category}`), behind)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('draws white on a toast', () => {
      expect(contrast('#ffffff', dark('toast'))).toBeGreaterThanOrEqual(4.5);
    });

    it('gives the default theme’s accent outside the shell the values the shell gives it inside', () => {
      const violet = shellColours(paintedWorkspace({ color: WORKSPACE_THEMES[0].tint, bar: WORKSPACE_THEMES[0].bar, ground: WORKSPACE_THEMES[0].ground, header: WORKSPACE_THEMES[0].header }), 'dark');

      expect({ deep: dark('accent-deep'), tint: dark('accent-tint') }).toEqual({ deep: violet.accentDeep, tint: violet.accentTint });
    });
  });
  describe('in dark, the list well and the Inbox well are both darker than the page, and not the same', () => {
    it('mixes each from the page towards black by a different share', () => {
      const page = contrast(dark('ground'), '#000000');
      const list = contrast(towardsBlack(dark('ground'), wellShare('well')), '#000000');
      const inbox = contrast(towardsBlack(dark('ground'), wellShare('well-inbox')), '#000000');

      expect(list).toBeLessThan(page);
      expect(inbox).toBeLessThan(page);
      expect(list).not.toBe(inbox);
    });
  });
});
