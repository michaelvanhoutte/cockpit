//
// Two halves, as in e2e-conventions.test.mjs: the matcher against text written
// here, then the matcher over the web app's own sources, which is the half
// that gates.
//

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { THE_THEME, literalsOutsideTheTheme } from './theme-tokens.mjs';

const sources = join(dirname(fileURLToPath(import.meta.url)), '../../apps/web/src');

describe('literalsOutsideTheTheme', () => {
  const caught = [
    ['a hex colour', 'const ink = "#17181c";'],
    ['a hex colour', 'border: 1px solid #ddd;'],
    ['a colour function', 'box-shadow: 0 1px rgb(0 0 0 / 0.2);'],
    ['an arbitrary colour', '<p className="bg-[#292b31] text-sm">'],
    ['an arbitrary colour', '<p className="border-[color:rgb(1,2,3)]">'],
    ['an arbitrary radius', '<p className="rounded-[8px]">'],
    ['an arbitrary radius', '<p className="rounded-t-[6px]">'],
    ['an arbitrary shadow', '<p className="shadow-[0_1px_2px_black]">'],
    ['black', '<p className="border-black/10 text-sm">'],
  ];
  for (const [kind, source] of caught) {
    it(`catches ${kind}: ${source}`, () => {
      assert.deepEqual(
        literalsOutsideTheTheme(source).map((found) => found.kind),
        [kind],
      );
    });
  }

  it('leaves the theme’s own names, runtime variables, white and font sizes alone', () => {
    const source = [
      '<p className="bg-ink-strong text-on-accent rounded-md shadow-field border-shade/10">',
      '<p className="bg-[var(--tab-on)] rounded-[var(--r)] shadow-[var(--s)] bg-white/10">',
      '<p className="text-[15px] tracking-[0.11em] sm:w-[74px] min-h-[44px]">',
      'const url = "https://example.com/#top"; // issue #12',
    ].join('\n');
    assert.deepEqual(literalsOutsideTheTheme(source), []);
  });
});

describe('the web app', () => {
  it(`writes no colour, radius or shadow outside ${THE_THEME}`, () => {
    const offences = readdirSync(sources, { recursive: true })
      .filter((name) => /\.(tsx?|css)$/.test(name) && name !== THE_THEME)
      .flatMap((name) =>
        literalsOutsideTheTheme(readFileSync(join(sources, name), 'utf8')).map(
          (found) => `${name}:${found.line}  ${found.kind}: ${found.text}`,
        ),
      );
    assert.deepEqual(
      offences,
      [],
      `name it in the theme (apps/web/src/${THE_THEME}) and use the name:\n  ${offences.join('\n  ')}`,
    );
  });
});
