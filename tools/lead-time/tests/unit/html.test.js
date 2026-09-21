import { describe, expect, it } from 'vitest';

import { renderBlock } from '../../../../scripts/lib/session-record.mjs';
import { buildModel } from '../../src/model.js';
import { renderHtml } from '../../src/render/html.js';

const MIN = 60_000;
const BASE = Date.UTC(2026, 8, 15, 9, 0);
/** A moment, as minutes past 09:00 on the 15th. */
const at = (minutes) => new Date(BASE + minutes * MIN).toISOString();
const NOW = new Date(BASE + 24 * 60 * MIN);
const DAY_MS = 86_400_000;

let nextId = 1;
const check = (name, from, to, conclusion = 'success', overrides = {}) => ({
  id: nextId++,
  name,
  suiteId: 1,
  status: 'completed',
  conclusion,
  startedAt: at(from),
  completedAt: at(to),
  ...overrides,
});
const commit = (sha, authoredAt, checks = [], parents = 1) => ({ sha, authoredAt: at(authoredAt), parents, checks });
const pull = (overrides = {}) => ({
  number: 1,
  title: 'A change',
  url: 'https://github.com/o/r/pull/1',
  createdAt: at(0),
  mergedAt: at(60),
  body: '',
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  commitCount: 1,
  commits: [commit('a', 0, [check('Test', 2, 12)])],
  ...overrides,
});
const withRecord = (start = 0) => renderBlock([{ at: at(start), phase: 'start' }, { at: at(start + 1), phase: 'pushed' }]);

const render = ({ pulls = [pull()], requestedDays = 14, coveredDays = requestedDays, truncated = false, ...rest } = {}) =>
  renderHtml(
    buildModel({
      pulls,
      now: NOW,
      requestedDays,
      coveredSince: new Date(NOW.getTime() - coveredDays * DAY_MS),
      truncated,
      repo: 'o/r',
      ...rest,
    }),
  );

/** One pull request's row, so a case looks at that row and nothing else on the page. */
const rowOf = (html, number) => {
  const rows = html.split('<h2>The numbers behind it</h2>')[0].split('<div class="pullrow">');
  return rows.find((each) => each.includes(`<b>#${number}</b>`));
};
const stripOf = (html, number) => rowOf(html, number).split('<div class="track">')[1].split('</div>')[0];

describe('Lead time', () => {
  describe('the page says what period it covered and what it cannot see', () => {
    it('names the period it actually covered, not the one asked for, where the fetch was capped', () => {
      const html = render({ requestedDays: 14, coveredDays: 9, truncated: true });
      expect(html).toContain('This covers 9 days, not 14');
      expect(html).toContain('14 days (only 9 covered)');
      expect(html).toContain('pull request budget');
    });

    it('says the period it covered even where it covered all that was asked', () => {
      const html = render({ requestedDays: 14, coveredDays: 14 });
      expect(html).toContain('This covers 14 days.');
      expect(html).not.toContain('not 14');
    });

    it('says that time before the session starts is not measured', () => {
      expect(render()).toContain('Time before the session&rsquo;s start is not measured');
    });

    it('says that only merged pull requests count', () => {
      expect(render()).toContain('Only merged pull requests count');
    });

    it('says how many of the pull requests carry a session record', () => {
      const html = render({ pulls: [pull({ number: 1, body: withRecord() }), pull({ number: 2 }), pull({ number: 3 })] });
      expect(html).toContain('1 of 3 merged pull requests carry a session record');
    });

    it('reads a window with no pull requests as no data, and never as a zero', () => {
      const html = render({ pulls: [pull({ mergedAt: at(-8 * 24 * 60), createdAt: at(-8 * 24 * 60 - 60) })], windows: [7, 14] });
      const [week] = html.split('<h2>Where the harness minutes go</h2>')[0].split('<tbody>')[1].split('</tr>');
      // The seven-day column is the first after the row heading; nothing merged in it.
      expect(week).toContain('no data');
      expect(week).not.toMatch(/<span class="fig">0<\/span>/);
      expect(html.split('<h2>Where the harness minutes go</h2>')[1].split('<h2>')[0]).toContain('no data');
    });
  });

  describe('the strip draws every round', () => {
    it('draws three rounds in order, each coloured by the check that held it', () => {
      const html = render({
        pulls: [
          pull({
            mergedAt: at(120),
            commits: [
              commit('a', 0, [check('Test', 2, 12)]),
              commit('b', 30, [check('Test', 31, 40), check('claude-review', 31, 50)]),
              commit('c', 70, [check('Test', 71, 76), check('Security review', 71, 85)]),
            ],
          }),
        ],
      });
      const rounds = [...stripOf(html, 1).matchAll(/class="seg round (\S+?)[" ]/g)].map((match) => match[1]);
      expect(rounds).toEqual(['checks', 'code-review', 'security-review']);
      const titles = [...stripOf(html, 1).matchAll(/title="(Round \d)/g)].map((match) => match[1]);
      expect(titles).toEqual(['Round 1', 'Round 2', 'Round 3']);
    });

    it('marks a red round red and names the check that failed', () => {
      const html = render({ pulls: [pull({ commits: [commit('a', 0, [check('Test', 2, 12), check('Lint', 2, 5, 'failure')])] })] });
      const strip = stripOf(html, 1);
      expect(strip).toContain('mark red');
      expect(strip).toContain('RED: Lint failed');
      expect(strip).not.toContain('mark fluke');
    });

    it('marks a fluke as a fluke, and not as a red round', () => {
      const html = render({
        pulls: [pull({ commits: [commit('a', 0, [check('Test', 2, 8), check('E2E (F3)', 2, 10, 'failure'), check('E2E (F3)', 12, 25)])] })],
      });
      const strip = stripOf(html, 1);
      expect(strip).toContain('mark fluke');
      expect(strip).toContain('FLUKE: E2E (F3) failed and passed on re-run');
      expect(strip).not.toContain('mark red');
      expect(strip).not.toContain('seg round checks red');
    });

    it('draws a gap of over three hours as away, off the time scale', () => {
      const html = render({
        pulls: [pull({ mergedAt: at(250), commits: [commit('a', 0, [check('Test', 2, 12)]), commit('b', 20, [check('Test', 212, 222)])] })],
      });
      const strip = stripOf(html, 1);
      expect(strip).toContain('Away for 3h 20m');
      // Off the scale: the fixed-width break carries no share of it, and the strip
      // is still no longer than its rounds and the short wait for merge.
      expect(strip).not.toMatch(/seg away" style/);
      expect(strip).not.toContain('Fixing before the next push');
    });

    it('cuts a pull request longer than the scale, and says how much it cut', () => {
      const html = render({
        pulls: [
          pull({
            mergedAt: at(60 * 8),
            commits: [commit('a', 0, [check('Test', 2, 12)]), commit('b', 100, [check('Test', 101, 170)]), commit('c', 300, [check('Test', 301, 420)])],
          }),
        ],
      });
      expect(html).toContain('Clipped:');
      expect(html).toContain('the first 4h 00m shown');
      expect(stripOf(html, 1)).toContain('clipmark');
    });

    it('does not say clipped of a pull request that fits its scale', () => {
      const html = render();
      expect(html).not.toContain('Clipped:');
      expect(stripOf(html, 1)).not.toContain('clipmark');
    });

    it('reads a pull request with no session record as not recorded, never as a stretch of zero width', () => {
      const html = render({ pulls: [pull({ number: 1, body: withRecord() }), pull({ number: 2 })] });
      const unrecorded = rowOf(html, 2);
      const recorded = rowOf(html, 1);
      expect(unrecorded).toContain('tag unrecorded');
      expect(unrecorded).toContain('>not recorded<');
      expect(unrecorded).toContain('seg coding unrecorded');
      expect(recorded).not.toContain('unrecorded');
      expect(recorded).not.toContain('not recorded');
    });

    it('reads a pull request no check ran on as having no rounds, not as a strip of nothing', () => {
      const html = render({ pulls: [pull({ commits: [commit('a', 0)] })] });
      expect(stripOf(html, 1)).toContain('no check ran on it');
    });
  });

  describe('the page is one file that opens from disk', () => {
    it('asks for nothing outside itself: styles and data are inline', () => {
      const html = render({ pulls: [pull({ body: withRecord() }), pull({ number: 2 })] });
      expect(html).toContain('<style>');
      expect(html).not.toMatch(/<link\b/i);
      expect(html).not.toMatch(/<script\b/i);
      expect(html).not.toMatch(/<img\b|<iframe\b|<source\b/i);
      expect(html).not.toMatch(/@import|url\(/i);
      // The only addresses are anchors a reader follows, never something the page loads.
      const outside = [...html.matchAll(/(?:src|href)="(https?:[^"]*)"/g)].filter((match) => !html.includes(`<a href="${match[1]}"`));
      expect(outside).toEqual([]);
    });

    it('escapes a pull request title rather than letting it write markup into the page', () => {
      const html = render({ pulls: [pull({ title: '<script>alert(1)</script>' })] });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });
  });
});
