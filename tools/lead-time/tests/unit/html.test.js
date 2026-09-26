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

  describe('a figure says what it was made from once, and never as a zero it did not measure', () => {
    it('says the pull requests behind a per-pull-request figure once, not twice', () => {
      const html = render({ pulls: [pull({ number: 1 }), pull({ number: 2 })] });
      expect(html).toContain('2 pull requests');
      expect(html).not.toMatch(/(\d+ pull requests?), \1/);
    });

    it('reads a window whose pull requests had no check run on them as no rounds to count, not as zero of zero', () => {
      const html = render({ pulls: [pull({ commits: [commit('a', 0)] })], windows: [7] });
      expect(html).not.toContain('of 0 rounds');
      expect(html.split('<h2>Where the harness minutes go</h2>')[1].split('<h2>')[0]).toContain('no data');
    });

    it('reads the time to merge from the pull request, so time away is in it', () => {
      const html = render({
        pulls: [pull({ mergedAt: at(430), commits: [commit('a', 0, [check('Test', 2, 12)]), commit('b', 420, [check('Test', 421, 430)])] })],
      });
      expect(rowOf(html, 1)).toContain('7h 10m to merge, 2 rounds');
    });

    it('reads the time to merge of a pull request no check ran on, rather than as nothing', () => {
      const html = render({ pulls: [pull({ mergedAt: at(180), commits: [commit('a', 0)] })] });
      expect(rowOf(html, 1)).toContain('3h 00m to merge, 0 rounds');
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
      // Rounds 2 and 3 also ran Test, held earlier in the round: the check named
      // here is the one whose piece ends the round, not the only piece in it.
      const heldByRound = stripOf(html, 1)
        .split('<span class="seg round')
        .slice(1)
        .map((round) => {
          const kinds = [...round.matchAll(/class="piece (\S+?)"/g)].map((match) => match[1]);
          return kinds[kinds.length - 1];
        });
      expect(heldByRound).toEqual(['checks', 'code-review', 'security-review']);
      const titles = [...stripOf(html, 1).matchAll(/title="(Round \d)/g)].map((match) => match[1]);
      expect(titles).toEqual(['Round 1', 'Round 2', 'Round 3']);
    });

    it('splits a round into the checks that held it, in the order they finished, rather than one colour for the whole span', () => {
      const html = render({
        pulls: [
          pull({
            commits: [commit('a', 0, [check('Test', 2, 12), check('claude-review', 2, 20)])],
          }),
        ],
      });
      const round = stripOf(html, 1).split('<span class="seg round')[1];
      const pieces = [...round.matchAll(/class="piece (\S+?)"/g)].map((match) => match[1]);
      // Test finishes first, at minute 12, and holds the round from the push at
      // minute 2 until then (10 minutes); code review is still running and holds
      // the remaining 8 minutes, to minute 20.
      expect(pieces).toEqual(['checks', 'code-review']);
      expect(round).toContain('Tests and checks (Test) · held it 10m 00s');
      expect(round).toContain('Code review (claude-review) · held it 8m 00s');
    });

    it('names every check that held a round in its own words, not only the last', () => {
      const html = render({
        pulls: [
          pull({
            commits: [commit('a', 0, [check('Test', 2, 12), check('claude-review', 2, 20)])],
          }),
        ],
      });
      // The round-list text is read on its own, without hovering the strip's
      // pieces, so it must not repeat the strip's old single-check mistake.
      const detail = rowOf(html, 1).split('<ol class="roundlist">')[1];
      expect(detail).toContain('held by Test, then claude-review');
      expect(detail).not.toContain('held by claude-review');
    });

    it('trims a clipped round to what is actually shown, not the full round squeezed into less room', () => {
      const html = render({
        pulls: [
          pull({
            mergedAt: at(260),
            // Test holds the round for its first 198 minutes; claude-review then
            // holds the last 60, past the scale's 240-minute cap.
            commits: [commit('a', 2, [check('Test', 2, 200), check('claude-review', 2, 260)])],
          }),
        ],
      });
      const round = stripOf(html, 1).split('<span class="seg round')[1];
      expect(round).toContain('cut');
      // Only 42 of code review's real 60 minutes fall before the cap (240 minus
      // the 198 Test already used); the old, buggy version showed its full 60.
      expect(round).toContain('Code review (claude-review) · held it 42m 00s');
      expect(round).not.toContain('60m 00s');
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
      expect(strip).not.toContain('seg round red');
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

  describe('coding against the harness: every recorded pull request is a dot, and nothing else is', () => {
    const sectionOf = (html) => html.split('<h2>Coding against the harness</h2>')[1].split('<h2>')[0];
    const dotsOf = (html) => [...sectionOf(html).matchAll(/<circle class="dot( off)?" /g)].length - keyDots;
    // The key draws its own sample dots; they are not pull requests.
    const keyDots = 3;
    // Ten minutes writing, then thirty in the harness: a ratio of three.
    const recorded = (number, harness = 30, extra = {}) =>
      pull({
        number,
        url: `https://github.com/o/r/pull/${number}`,
        mergedAt: at(harness + 30),
        body: withRecord(0),
        commits: [commit('a', 0, [check('Test', 10, 10 + harness)])],
        ...extra,
      });

    it('draws a dot for a pull request with a record, naming it and its figures', () => {
      const html = render({ pulls: [recorded(7)] });
      expect(dotsOf(html)).toBe(1);
      const title = sectionOf(html).match(/<a href="https:\/\/github.com\/o\/r\/pull\/7"[^>]*><title>([^<]*)<\/title>/)[1];
      expect(title).toBe('#7 A change · coding and fixing 10m 00s · in the harness 30m 00s · ratio 3.0× · 1 round');
    });

    it('draws no dot for a pull request with no record, and says how many it left out', () => {
      const html = render({ pulls: [recorded(1), pull({ number: 2 }), pull({ number: 3 })] });
      expect(dotsOf(html)).toBe(1);
      expect(sectionOf(html)).toContain('2 merged pull requests in this window carry no session record and are not on the chart.');
      expect(sectionOf(html)).not.toMatch(/pull\/2"|pull\/3"/);
    });

    it('says none were left out where every pull request has a record', () => {
      expect(sectionOf(render({ pulls: [recorded(1)] }))).toContain('Every merged pull request in this window carries a session record.');
    });

    it('draws a dot beyond the scale hollow on the edge, and says it is off the chart', () => {
      const html = render({ pulls: [recorded(1), recorded(2, 390)] });
      const section = sectionOf(html);
      expect(section.match(/<circle class="dot off" /g)).toHaveLength(2);
      expect(section).toContain('beyond the scale, so drawn on its edge');
      expect(section).toContain('1 dot beyond it, drawn hollow on the edge');
      expect(section).toContain('<span class="tag">off the chart</span>');
    });

    it('reads a window where no pull request has a record as no data, not as an empty chart', () => {
      const html = render({ pulls: [pull({ number: 1 }), pull({ number: 2 })] });
      expect(sectionOf(html)).not.toContain('<svg class="scatter"');
      expect(sectionOf(html)).toContain('no data');
      expect(sectionOf(html)).toContain('2 merged pull requests in this window carry no session record');
    });

    it('reads a window with no pull request in it as no data', () => {
      const html = render({ pulls: [] });
      expect(sectionOf(html)).not.toContain('<svg class="scatter"');
      expect(sectionOf(html)).toContain('no data');
    });

    it('leaves out a pull request with a record that no check ran on, and says so', () => {
      const html = render({ pulls: [recorded(1), pull({ number: 2, body: withRecord(0), commits: [commit('b', 0)] })] });
      expect(dotsOf(html)).toBe(1);
      expect(sectionOf(html)).toContain('1 pull request with a record had no check run on it');
    });

    it('puts every dot in the table behind the chart as well, so no figure needs a hover', () => {
      const html = render({ pulls: [recorded(1), recorded(2, 60)] });
      const table = sectionOf(html).split('<details>')[1];
      expect(table).toContain('#1');
      expect(table).toContain('#2');
      expect(table).toContain('1h 00m');
    });
  });

  describe("coding against the harness: the median line is the window's own", () => {
    const sectionOf = (html) => html.split('<h2>Coding against the harness</h2>')[1].split('<h2>')[0];
    const recorded = (number, harness) =>
      pull({ number, url: `https://github.com/o/r/pull/${number}`, mergedAt: at(harness + 30), body: withRecord(0), commits: [commit('a', 0, [check('Test', 10, 10 + harness)])] });

    it("draws the median line at the window's median ratio and names it, with the pull requests behind it", () => {
      // Ten minutes of coding each, so the ratios are 1, 2 and 6.
      const html = render({ pulls: [recorded(1, 10), recorded(2, 20), recorded(3, 60)] });
      expect(sectionOf(html)).toContain('Median ratio 2.0×</b> over 3 pull requests.');
      // The line leaves the plot at half the height on the right edge: y of a ratio of two is the top, at half the width.
      expect(sectionOf(html)).toMatch(/class="medianline" x1="48.0" y1="396.0" x2="238.0" y2="16.0"/);
    });

    it("uses the widest window's pull requests, not the narrowest's", () => {
      // Ten minutes of coding each: a ratio of one for the recent pull request, and of six for the one four days back.
      const recent = recorded(1, 10);
      const long = -4 * 24 * 60;
      const older = pull({ number: 2, mergedAt: at(long + 100), body: withRecord(long), commits: [commit('a', long, [check('Test', long + 10, long + 70)])] });
      const html = render({ pulls: [recent, older], windows: [1, 14] });
      expect(sectionOf(html)).toContain('14 days');
      expect(sectionOf(html)).toContain('Median ratio 3.5×</b> over 2 pull requests');
    });

    it('says how few one pull request rests on, and that the median is its own ratio', () => {
      const html = render({ pulls: [recorded(1, 30)] });
      expect(sectionOf(html)).toContain('Median ratio 3.0×</b> over 1 pull request: that one pull request&rsquo;s own ratio');
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

  describe('it is published beside the other three pages', () => {
    it('links to the test explorer, the CI stability page and the test-selection page, one directory up', () => {
      const html = render({ pulls: [pull()] });
      expect(html).toContain('href="../"');
      expect(html).toContain('href="../stability/"');
      expect(html).toContain('href="../selection/"');
    });
  });
});
