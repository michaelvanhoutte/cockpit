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
/** A job created `created` minutes past 09:00 whose check run ran `from` to `to`, its job list read. */
const job = (name, created, from, to, conclusion = 'success') => check(name, from, to, conclusion, { queue: { state: 'read', createdAt: at(created), startedAt: at(from) } });
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
/** A session record that starts at 09:00, holds `marks`, and pushes at 09:19. */
const session = (...marks) => renderBlock([{ at: at(0), phase: 'start' }, ...marks, { at: at(19), phase: 'pushed' }]);
const reviewMarks = (kind, from, to) => [
  { at: at(from), phase: 'review-start', kind, level: 'high' },
  { at: at(to), phase: 'review-end', kind, level: 'high' },
];
const testRunMark = (from, to, ...scopes) => ({ run: 'test', scopes, start: at(from), end: at(to) });
const browserMarks = (from, to) => [
  { at: at(from), phase: 'browser-start' },
  { at: at(to), phase: 'browser-end' },
];

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
  const rows = html.split('<footer>')[0].split('<div class="pullrow">');
  return rows.find((each) => each.includes(`<b>#${number}</b>`));
};
/** A row's strip as it is closed, on the shared scale: the first track in it, up to the end of the label it is clicked through. */
const stripOf = (html, number) => rowOf(html, number).split(/<span class="track[^"]*"[^>]*>/)[1].split(/<\/label>|<input /)[0];
/** The same pull request zoomed: the track, the axis and the detail box in the block a click opens. */
const zoomedOf = (html, number) => rowOf(html, number).split('<div class="zoomed">')[1];
/** The stylesheet the page carries, the generated rules included. */
const cssOf = (html) => html.split('<style>')[1].split('</style>')[0];
/**
 * Every element of one pull request's zoomed strip a reader can pick: the radio laid over it, the words it is
 * labelled with, and the detail the page's own rules show once that radio is checked (`undefined` where no rule does).
 */
const pickablesIn = (html, number) => {
  const zoomed = zoomedOf(html, number);
  const details = Object.fromEntries([...zoomed.matchAll(/<div class="detail" id="([\w-]+)">([\s\S]*?)<\/div>/g)].map((match) => [match[1], match[2]]));
  const shownBy = {};
  // One rule per detail, naming every radio that shows it: `.strip:has(:is(#a, #b):checked) #detail { display: block; }`, or `:has(#a:checked)` for one.
  for (const [, radios, detailId] of cssOf(html).matchAll(/\.strip:has\((:is\([^)]*\)|#[\w-]+):checked\) #([\w-]+) \{ display: block; \}/g)) {
    for (const radio of radios.replace(/^:is\(|\)$/g, '').split(', ')) shownBy[radio.replace(/^#/, '')] = detailId;
  }
  return [...zoomed.matchAll(/<input type="radio" class="pick" name="([^"]+)" id="([^"]+)" aria-label="([^"]*)">/g)].map(([, name, id, label]) => ({
    name,
    id,
    label,
    detailId: shownBy[id],
    detail: details[shownBy[id]],
  }));
};
/** The pickable elements of a pull request whose label matches, for a case that looks at one kind of element. */
const pickingIn = (html, number, label) => pickablesIn(html, number).filter((each) => label.test(each.label));
/** A detail's heading, its line and its context, as the page words them. */
const readDetail = (detail) => {
  const part = (name) => new RegExp(`<p class="${name}">([\\s\\S]*?)</p>`).exec(detail)?.[1];
  return { head: part('dhead'), line: part('dline'), context: part('dctx') };
};

describe('Cycle time', () => {
  it('is titled and headed "Cycle time"', () => {
    const html = render({});
    expect(html).toContain('<title>Cockpit Cycle Time</title>');
    expect(html).toContain('<h1>Cycle time</h1>');
  });

  describe('a pull request into a feature branch shows its base, and a landing is marked and left out of the figures', () => {
    const unit = pull({ number: 2, base: 'feature/find-items-1238', head: 'unit-2', body: withRecord(0) });
    const landing = pull({ number: 9, base: 'main', head: 'feature/find-items-1238', mergedAt: at(300), body: withRecord(0) });

    it('marks the row of a pull request into a feature branch with its base', () => {
      const html = render({ pulls: [pull({ number: 1 }), unit] });
      expect(rowOf(html, 2)).toContain('into feature/find-items-1238');
      expect(rowOf(html, 1)).not.toContain('class="tag base"');
    });

    it('marks a feature branch into main as a landing, and no other row', () => {
      const html = render({ pulls: [pull({ number: 1 }), unit, landing] });
      expect(rowOf(html, 9)).toContain('feature branch landing');
      expect(rowOf(html, 9)).not.toContain('class="tag base"');
      expect(rowOf(html, 2)).not.toContain('feature branch landing');
      expect(rowOf(html, 1)).not.toContain('feature branch landing');
    });

    it('leaves the landing out of the scatter and the evolution, though its row stays', () => {
      const html = render({ pulls: [pull({ number: 1, body: withRecord(0) }), unit, landing] });
      // A dot or bar names its pull request as "#n title"; a row names it "<b>#n</b> title".
      expect(html).not.toContain('#9 A change');
      expect(html).toContain('#2 A change');
      expect(rowOf(html, 9)).toContain('<b>#9</b>');
    });

    it('says in the limits box that feature branch pull requests are read and landings are in no figure', () => {
      expect(render({ pulls: [unit, landing] })).toContain('1 feature branch landing (a feature branch into main) is shown but in no figure');
    });

    it('renders a window of only pull requests into main with no mention of branches', () => {
      const html = render({ pulls: [pull({ number: 1 }), pull({ number: 2 })] });
      expect(html).not.toContain('feature branch');
      expect(html).not.toContain('class="tag base"');
    });
  });

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
  });

  describe('a figure says what it was made from once, and never as a zero it did not measure', () => {
    it('says the pull requests behind a per-pull-request figure once, not twice', () => {
      const recorded = (number) => pull({ number, body: withRecord(0), commits: [commit('a', 0, [check('Test', 10, 20)])] });
      const html = render({ pulls: [recorded(1), recorded(2)] });
      expect(html).toContain('2 pull requests');
      expect(html).not.toMatch(/(\d+ pull requests?), \1/);
    });

    it('reads the time to merge from the pull request, so time away is in it', () => {
      const html = render({
        pulls: [pull({ mergedAt: at(430), commits: [commit('a', 0, [check('Test', 2, 12)]), commit('b', 420, [check('Test', 421, 430)])] })],
      });
      expect(rowOf(html, 1)).toContain('7h 10m to merge, 2 CI Rounds');
    });

    it('reads the time to merge of a pull request no check ran on, rather than as nothing', () => {
      const html = render({ pulls: [pull({ mergedAt: at(180), commits: [commit('a', 0)] })] });
      expect(rowOf(html, 1)).toContain('3h 00m to merge, 0 CI Rounds');
    });
  });

  describe('the strip draws every round', () => {
    it('draws three rounds in order, each held by tests and checks, whatever the check is named', () => {
      const html = render({
        pulls: [
          pull({
            mergedAt: at(120),
            commits: [
              commit('a', 0, [check('Test', 2, 12)]),
              commit('b', 30, [check('Test', 31, 40), check('E2E (F3)', 31, 50)]),
              commit('c', 70, [check('Test', 71, 76), check('claude-review', 71, 85)]),
            ],
          }),
        ],
      });
      // Rounds 2 and 3 also ran Test, held earlier in the round. A check named for a remote
      // review is one of them: those reviews no longer exist, so it draws as any other.
      const heldByRound = stripOf(html, 1)
        .split('<span class="seg round')
        .slice(1)
        .map((round) => {
          const kinds = [...round.matchAll(/class="piece (\S+?)"/g)].map((match) => match[1]);
          return kinds[kinds.length - 1];
        });
      expect(heldByRound).toEqual(['checks', 'checks', 'checks']);
      expect(stripOf(html, 1)).not.toMatch(/piece (code|security)-review/);
      const titles = [...stripOf(html, 1).matchAll(/title="(CI Round \d)/g)].map((match) => match[1]);
      expect(titles).toEqual(['CI Round 1', 'CI Round 2', 'CI Round 3']);
    });

    it('splits a round into the checks that held it, in the order they finished, rather than one colour for the whole span', () => {
      const html = render({
        pulls: [
          pull({
            commits: [commit('a', 0, [check('Test', 2, 12), check('E2E (F3)', 2, 20)])],
          }),
        ],
      });
      const round = stripOf(html, 1).split('<span class="seg round')[1];
      const pieces = [...round.matchAll(/class="piece (\S+?)"/g)].map((match) => match[1]);
      // Test finishes first, at minute 12, and holds the round from the push at
      // minute 2 until then (10 minutes); E2E is still running and holds
      // the remaining 8 minutes, to minute 20.
      expect(pieces).toEqual(['checks', 'checks']);
      expect(round).toContain('Tests and checks (Test) · held it 10m 00s');
      expect(round).toContain('Tests and checks (E2E (F3)) · held it 8m 00s');
    });

    it('names every check that held a round in its own words, not only the last', () => {
      const html = render({
        pulls: [
          pull({
            commits: [commit('a', 0, [check('Test', 2, 12), check('E2E (F3)', 2, 20)])],
          }),
        ],
      });
      // The round's detail is read on its own, without hovering the strip's
      // pieces, so it must not repeat the strip's old single-check mistake.
      const [round] = pickingIn(html, 1, /^CI Round 1 · /);
      expect(round.detail).toContain('held by Test, then E2E (F3)');
      expect(round.detail).not.toContain('held by E2E (F3)');
    });

    it('trims a clipped round to what is actually shown, not the full round squeezed into less room', () => {
      const html = render({
        pulls: [
          pull({
            mergedAt: at(260),
            // Test holds the round for its first 198 minutes; E2E then
            // holds the last 60, past the scale's 240-minute cap.
            commits: [commit('a', 2, [check('Test', 2, 200), check('E2E (F3)', 2, 260)])],
          }),
        ],
      });
      const round = stripOf(html, 1).split('<span class="seg round')[1];
      expect(round).toContain('cut');
      // Only 42 of E2E's real 60 minutes fall before the cap (240 minus
      // the 198 Test already used); the old, buggy version showed its full 60.
      expect(round).toContain('Tests and checks (E2E (F3)) · held it 42m 00s');
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
      expect(strip).not.toMatch(/seg away" style="[^"]*width/);
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
      expect(recorded).not.toContain('>not recorded<');
    });

    it('reads a pull request no check ran on as having no rounds, not as a strip of nothing', () => {
      const html = render({ pulls: [pull({ commits: [commit('a', 0)] })] });
      expect(rowOf(html, 1)).toContain('no check ran on it');
    });

    it('offers nothing to zoom on a pull request no check ran on', () => {
      const html = render({ pulls: [pull({ commits: [commit('a', 0)] })] });
      expect(rowOf(html, 1)).not.toContain('zoomtoggle');
      expect(rowOf(html, 1)).not.toContain('class="zoomed"');
    });
  });

  describe('the strip draws a local review as its own slice, apart from CI', () => {
    const reviewed = (...reviews) =>
      renderBlock([
        { at: at(0), phase: 'start' },
        ...reviews.flatMap(([kind, level, from, to]) => [
          { at: at(from), phase: 'review-start', kind, level },
          { at: at(to), phase: 'review-end', kind, level },
        ]),
        { at: at(19), phase: 'pushed' },
      ]);
    const withReviews = (...reviews) => pull({ body: reviewed(...reviews), mergedAt: at(60), commits: [commit('a', 0, [check('Test', 20, 40)])] });
    const sliceTitles = (html) => [...stripOf(html, 1).matchAll(/<span class="seg review ([\w-]+)[^"]*" style="[^"]*" title="([^"]*)"/g)].map((match) => [match[1], match[2]]);
    const legendOf = (html) => html.split('<h2>Each pull request, start to merge</h2>')[1].split('<div class="card">')[0];

    it('names the kind, the level and how long it took on hover, in the order the reviews ran', () => {
      const html = render({ pulls: [withReviews(['code-review', 'high', 2, 6], ['security-review', 'xhigh', 8, 10])] });
      expect(sliceTitles(html)).toEqual([
        ['local-code-review', 'Local code review · high · 4m 00s'],
        ['local-security-review', 'Local security review · xhigh · 2m 00s'],
      ]);
    });

    it('keeps the coding either side of a review, and the slice in its own place in the row', () => {
      const strip = stripOf(render({ pulls: [withReviews(['code-review', 'high', 5, 15])] }), 1);
      expect(strip.match(/<span class="seg (coding|review|round)\b/g)).toEqual(['<span class="seg coding', '<span class="seg review', '<span class="seg coding', '<span class="seg round']);
    });

    it('names a local review in the legend as local, never as holding a round', () => {
      const legend = legendOf(render({ pulls: [withReviews(['code-review', 'high', 5, 15])] }));
      expect(legend).toContain('code review (local, at the time it ran)');
      expect(legend).toContain('security review (local, at the time it ran)');
      expect(legend).not.toMatch(/held by (code|security) review/);
    });

    it('puts every kind under exactly one of Local and CI, and waiting to merge and away under neither', () => {
      const legend = legendOf(render({ pulls: [withReviews(['code-review', 'high', 5, 15])] }));
      const swatchesIn = (group) => [...group.matchAll(/class="swatch ([\w-]+)"/g)].map((match) => match[1]);
      const [, local, ci, neither] = legend.split('<div class="keygroup');
      expect(swatchesIn(local)).toEqual(['coding', 'fixing', 'local-code-review', 'local-security-review', 'local-test', 'local-browser']);
      expect(swatchesIn(ci)).toEqual(['checks']);
      expect(local).toContain('>Local<');
      expect(ci).toContain('>CI<');
      expect(swatchesIn(neither)).toEqual(expect.arrayContaining(['wait', 'away']));
      expect(neither).not.toContain('keyhead');
    });

    describe('each group is a colour family, and a kind has one colour on strip and panel', () => {
      const css = cssOf(render());
      const hueOf = (hex) => {
        const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
        const max = Math.max(r, g, b);
        const delta = max - Math.min(r, g, b);
        const hue = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
        return (hue * 60 + 360) % 360;
      };
      const valuesOf = (name) => [...css.matchAll(new RegExp(`--${name}: (#[0-9a-f]{6});`, 'g'))].map((match) => match[1]);

      it.each(['coding', 'fixing', 'local-code-review', 'local-security-review', 'local-test', 'local-browser'])('draws the local kind %s in greens and teals, in dark and light', (name) => {
        const values = valuesOf(name);
        expect(values).toHaveLength(2);
        for (const value of values) expect([hueOf(value) >= 90, hueOf(value) <= 180]).toEqual([true, true]);
      });

      it('draws the CI kind in blue, in dark and light', () => {
        const values = valuesOf('checks');
        expect(values).toHaveLength(2);
        for (const value of values) expect([hueOf(value) >= 200, hueOf(value) <= 250]).toEqual([true, true]);
      });

      it.each([
        { kind: 'local-code-review', strip: '.seg.review.local-code-review' },
        { kind: 'local-security-review', strip: '.seg.review.local-security-review' },
        { kind: 'checks', strip: '.piece.checks' },
      ])('gives $kind the same colour on the strip, the key and the panel', ({ kind, strip }) => {
        expect(css).toContain(`${strip} { background: var(--${kind}); }`);
        expect(css).toContain(`.swatch.${kind} { background: var(--${kind}); }`);
        expect(css).toContain(`.evobar.${kind} { fill: var(--${kind}); }`);
      });
    });

    it('reads a pull request with no session record as not recorded, with no review slice drawn', () => {
      const html = render({ pulls: [pull({ commits: [commit('a', 0, [check('Test', 20, 40)])] })] });
      expect(stripOf(html, 1)).not.toContain('seg review');
      expect(rowOf(html, 1)).toContain('>not recorded<');
      expect(rowOf(html, 1)).toContain('test runs and browser pass are not measured');
    });

    it('draws no review slice for a record that marks no review, and does not call it not recorded', () => {
      const html = render({ pulls: [pull({ body: withRecord(0), commits: [commit('a', 0, [check('Test', 20, 40)])] })] });
      expect(stripOf(html, 1)).not.toContain('seg review');
      expect(rowOf(html, 1)).not.toContain('>not recorded<');
    });
  });

  describe('coding against the harness: every recorded pull request is a dot, and nothing else is', () => {
    const sectionOf = (html) => html.split('<h2>Coding against the harness</h2>')[1].split('<h2>')[0];
    // The key draws its own sample dots, as `keydot`; they are not pull requests.
    const dotsOf = (html) => [...sectionOf(html).matchAll(/<circle class="dot step\d( off)?" /g)].length;
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
      expect(title).toBe('#7 A change · coding and fixing 10m 00s · in the harness 30m 00s · ratio 3.0× · 1 round · 12 lines changed');
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
      expect(section.match(/<circle class="dot step1 off" /g)).toHaveLength(1);
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

    const svgOf = (html) => sectionOf(html).match(/<svg class="scatter"[\s\S]*?<\/svg>/)[0];
    const legendOf = (html) => sectionOf(html).match(/<div class="legend stacked">[\s\S]*?<\/div>/)[0];
    /** A pull request of `rounds` rounds, each `minutes` of checks, 15 minutes apart. */
    const inRounds = (number, rounds, minutes, extra = {}) =>
      recorded(number, 30, {
        mergedAt: at(rounds * 15 + 60),
        commits: Array.from({ length: rounds }, (_, index) => commit(`r${number}-${index}`, index * 15, [check('Test', index * 15 + 2, index * 15 + 2 + minutes)])),
        ...extra,
      });
    /** The stylesheet as the page carries it, without comments. */
    const stylesheetOf = (html) => html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
    const rulesOf = (css) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({ selectors: rule[1].split(',').map((each) => each.trim()), body: rule[2] }));
    const classesIn = (markup) => new Set([...markup.matchAll(/class="([^"]*)"/g)].flatMap((match) => match[1].split(/\s+/).filter(Boolean)));

    describe('each axis number sits at its own gridline', () => {
      it('reads 0, 30, 60, 90 and 120 on both axes, each number at the x or y of its own gridline', () => {
        const svg = svgOf(render({ pulls: [recorded(1, 390)] }));
        const gridXs = [...svg.matchAll(/<line class="grid" x1="([\d.]+)" y1="[\d.]+" x2="\1" y2="[\d.]+"\/>/g)].map((match) => Number(match[1]));
        const gridYs = [...svg.matchAll(/<line class="grid" x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="\1"\/>/g)].map((match) => Number(match[1]));
        const ticks = [...svg.matchAll(/<text class="tick" x="([\d.-]+)" y="([\d.-]+)" text-anchor="(\w+)">(\d+)<\/text>/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]), anchor: match[3], text: match[4] }));
        const across = ticks.filter((tick) => tick.anchor === 'middle');
        const up = ticks.filter((tick) => tick.anchor === 'end');

        expect(across.map((tick) => tick.text)).toEqual(['0', '30', '60', '90', '120']);
        expect(up.map((tick) => tick.text)).toEqual(['0', '30', '60', '90', '120']);
        expect(across.map((tick) => tick.x)).toEqual(gridXs);
        // The baseline sits 4px below the middle of the digits, which is what centres them on the line.
        up.forEach((tick, index) => expect(tick.y - 4).toBeCloseTo(gridYs[index], 1));
        // The numbers up the side stand left of the plot, not on it.
        up.forEach((tick) => expect(tick.x).toBeLessThan(gridXs[0]));
        across.forEach((tick) => expect(tick.y).toBeGreaterThan(Math.max(...gridYs)));
      });
    });

    describe("the strip's clock-axis styling cannot reach the scatter", () => {
      it('has no rule for a class both the strips and the scatter draw, other than one scoped to the scatter', () => {
        const html = render({ pulls: [recorded(1)] });
        const strips = html.split('<h2>Each pull request, start to merge</h2>')[1].split('<footer>')[0];
        const stripClasses = classesIn(strips);
        const scatterClasses = classesIn(svgOf(html));
        // The strip does draw an axis of its own, so a class list that never met the scatter's proves nothing.
        expect([...stripClasses].some((name) => /axis/.test(name))).toBe(true);
        const shared = [...stripClasses].filter((name) => scatterClasses.has(name));

        const reaching = rulesOf(stylesheetOf(html))
          .flatMap((rule) => rule.selectors)
          .filter((selector) => {
            const last = selector.split(/[\s>+~]+/).filter(Boolean).pop();
            return shared.some((name) => new RegExp(`\\.${name}(?![\\w-])`).test(last)) && !selector.includes('.scatter');
          });
        expect(reaching).toEqual([]);
      });
    });

    describe("the named dots' labels are drawn above every dot", () => {
      it('draws every label after the last dot', () => {
        const svg = svgOf(render({ pulls: [recorded(1, 90), recorded(2, 60), recorded(3, 45)] }));
        expect(svg.match(/class="dotlabel"/g)).toHaveLength(3);
        expect(svg.indexOf('class="dotlabel"')).toBeGreaterThan(svg.lastIndexOf('<circle class="dot '));
      });

      it('leaves each pull request one link, its dot, with the labels hidden from a screen reader and the pointer', () => {
        const html = render({ pulls: [recorded(1, 90), recorded(2, 60), recorded(3, 45)] });
        const svg = svgOf(html);
        expect(svg.match(/<a href=/g)).toHaveLength(3);
        expect(svg).toMatch(/<g class="dotlabels" aria-hidden="true">(<text class="dotlabel"[^>]*>[^<]*<\/text>){3}<\/g>/);
        expect(stylesheetOf(html)).toMatch(/\.scatter \.dotlabels \{\s*pointer-events: none;\s*\}/);
      });
    });

    describe("a dot's size is its lines changed, and larger dots are drawn first", () => {
      it('draws the larger dot before a smaller one listed ahead of it', () => {
        const svg = svgOf(render({ pulls: [recorded(1, 30, { additions: 8, deletions: 2 }), recorded(2, 30, { additions: 900, deletions: 100 })] }));
        expect(svg.indexOf('pull/2"')).toBeLessThan(svg.indexOf('pull/1"'));
        const radii = [...svg.matchAll(/<circle class="dot step\d" [^>]*r="([\d.]+)"/g)].map((match) => Number(match[1]));
        expect(radii).toEqual([14, 4 + 10 * Math.sqrt(10 / 1000)]);
      });
    });

    describe("a dot's shade is its CI rounds, blue for one round to red for five or more, readable in both themes", () => {
      // WCAG 2 contrast of two #rrggbb colours.
      // The linear-light red, green and blue of a #rrggbb colour, which both measures below start from.
      const linear = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      const luminance = (hex) => {
        const [r, g, b] = linear(hex);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const contrast = (a, b) => {
        const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (high + 0.05) / (low + 0.05);
      };
      // OKLab (Björn Ottosson) of a #rrggbb colour; the distance between two is ΔE ×100.
      const oklab = (hex) => {
        const [r, g, b] = linear(hex);
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
      };
      const deltaE = (a, b) => 100 * Math.hypot(...oklab(a).map((value, index) => value - oklab(b)[index]));
      const colours = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2]]));
      const darkBlock = (css) => css.match(/:root \{([^}]*)\}/)[1];
      const lightBlock = (css) => css.match(/prefers-color-scheme: light\)\s*\{\s*:root \{([^}]*)\}/)[1];
      const shadesIn = (block) => [1, 2, 3, 4, 5].map((step) => colours(block)[`round-${step}`]);

      it('shades the rounds blue to red with the same five colours in both themes', () => {
        const css = stylesheetOf(render({ pulls: [recorded(1)] }));
        expect(shadesIn(darkBlock(css))).toEqual(['#4399d3', '#8075db', '#b848b2', '#ce2a5f', '#c72801']);
        expect(lightBlock(css)).not.toMatch(/--round-/);
      });

      it('keeps every shade at least 3:1 against both the dark card and the light one', () => {
        const css = stylesheetOf(render({ pulls: [recorded(1)] }));
        const [darkCard, lightCard] = [darkBlock(css), lightBlock(css)].map((block) => colours(block).card);
        expect([darkCard, lightCard]).toEqual([expect.stringMatching(/^#/), expect.stringMatching(/^#/)]);
        const ratios = shadesIn(darkBlock(css)).map((hex) => [hex, contrast(hex, darkCard), contrast(hex, lightCard)]);
        expect(ratios.filter(([, dark, light]) => dark < 3 || light < 3)).toEqual([]);
      });

      it('keeps neighbouring shades at least 8 apart in colour, so adjacent rounds tell apart', () => {
        const shades = shadesIn(darkBlock(stylesheetOf(render({ pulls: [recorded(1)] }))));
        const gaps = shades.slice(1).map((hex, index) => [shades[index], hex, deltaE(shades[index], hex)]);
        expect(gaps.filter(([, , gap]) => gap < 8)).toEqual([]);
      });

      it('shades 1 round blue and 5 or more red on the dot itself', () => {
        const svg = svgOf(render({ pulls: [inRounds(1, 1, 5), inRounds(2, 5, 5), inRounds(3, 6, 5)] }));
        expect([...svg.matchAll(/<circle class="dot (step\d)"/g)].map((match) => match[1]).sort()).toEqual(['step1', 'step5', 'step5']);
      });
    });

    describe('a dot beyond the scale stays hollow on the edge, its ring in its rounds’ shade', () => {
      it('draws a hollow dot with a card fill and a ring in its own step', () => {
        const html = render({ pulls: [recorded(1, 390), inRounds(2, 5, 90)] });
        const svg = svgOf(html);
        expect(svg).toContain('<circle class="dot step1 off"');
        expect(svg).toContain('<circle class="dot step5 off"');
        const css = stylesheetOf(html);
        const ruleFor = (selector) => rulesOf(css).find((rule) => rule.selectors.includes(selector)).body;
        expect(ruleFor('.dot.off')).toMatch(/fill:\s*var\(--card\)/);
        expect(ruleFor('.dot.off')).toMatch(/stroke:\s*var\(--shade/);
        for (const step of [1, 2, 3, 4, 5]) expect(ruleFor(`.step${step}`)).toContain(`--shade: var(--round-${step})`);
      });
    });

    describe("everything that describes a dot names its lines changed and its rounds", () => {
      const sized = [recorded(1, 30, { additions: 30, deletions: 10 }), recorded(2, 30, { additions: 100, deletions: 60 })];

      it('keys the dot size in lines on the window’s scale, and the shade in five swatches', () => {
        const legend = legendOf(render({ pulls: sized }));
        expect(legend).toMatch(/<circle class="keydot" cx="[\d.]+" cy="15" r="9"\/><\/svg><span class="samplelabel">40 lines<\/span>/);
        expect(legend).toMatch(/<circle class="keydot" cx="[\d.]+" cy="15" r="14"\/><\/svg><span class="samplelabel">160 lines<\/span>/);
        expect([...legend.matchAll(/<circle class="keydot step(\d)"[^>]*\/><\/svg><span class="samplelabel">([^<]*)</g)].map((match) => [match[1], match[2]])).toEqual([
          ['1', '1'],
          ['2', '2'],
          ['3', '3'],
          ['4', '4'],
          ['5', '5+'],
        ]);
      });

      it('says under the heading that size is lines changed and shade is rounds', () => {
        const note = sectionOf(render({ pulls: sized })).split('</p>')[0];
        expect(note).toMatch(/^\s*<p class="sectionnote">/);
        expect(note).toMatch(/size is the lines its pull request changed/);
        expect(note).toMatch(/its shade is its CI rounds, blue for one round to red for five or more\./);
      });

      it('adds the lines changed after the rounds on a hover, and a column of them to the table', () => {
        const section = sectionOf(render({ pulls: sized }));
        expect(section).toContain('1 round · 40 lines changed</title>');
        expect(section).toContain('1 round · 160 lines changed</title>');
        expect(section).toContain('<th class="num">Lines changed</th>');
        expect(section).toContain('<td class="num">160</td>');
      });

      it('says under the chart that the three furthest are named where their labels fit', () => {
        expect(sectionOf(render({ pulls: sized }))).toContain('are named where their labels fit.');
      });
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

  describe('evolution: one point per pull request read, positioned by when it merged', () => {
    const sectionOf = (html) => html.split('<h2>Evolution</h2>')[1].split('<h2>')[0];

    it('says there is not enough data rather than drawing a chart of one point', () => {
      expect(sectionOf(render({ pulls: [pull()] }))).toContain('Not enough merged pull requests');
      expect(sectionOf(render({ pulls: [] }))).toContain('Not enough merged pull requests');
    });

    it('offers All, Last 7 days and Last 3 days as tabs, with All selected by default, and no script to drive them', () => {
      const html = render({
        pulls: [
          pull({ number: 1, mergedAt: at(60), commits: [commit('a', 0, [check('Test', 2, 12)])] }),
          pull({ number: 2, mergedAt: at(120), commits: [commit('b', 60, [check('Test', 62, 72)])] }),
        ],
      });
      const section = sectionOf(html);
      expect(section).toContain('<input type="radio" name="evozoom" id="evozoom-all" class="tabradio" checked>');
      expect(section).toContain('<label for="evozoom-all" class="tablabel">All</label>');
      expect(section).toContain('<label for="evozoom-7" class="tablabel">Last 7 days</label>');
      expect(section).toContain('<label for="evozoom-3" class="tablabel">Last 3 days</label>');
      expect(html).not.toMatch(/<script\b/i);
    });

    it("zooms each tab to its own cutoff from when the report was generated, leaving an older pull request out of it", () => {
      const old = pull({
        number: 1,
        mergedAt: at(-10 * 24 * 60),
        createdAt: at(-10 * 24 * 60 - 60),
        commits: [commit('a', -10 * 24 * 60 - 30, [check('Test', -10 * 24 * 60 - 20, -10 * 24 * 60 - 10)])],
      });
      const html = render({
        pulls: [
          old,
          pull({ number: 2, mergedAt: at(60), commits: [commit('b', 0, [check('Test', 2, 12)])] }),
          pull({ number: 3, mergedAt: at(120), commits: [commit('c', 60, [check('Test', 62, 72)])] }),
        ],
      });
      const after = (id) => html.split(`id="evopanel-${id}"`)[1];
      // Both merged recently, so both are inside every tab; the ten-day-old one is only in "All".
      expect(after('all')).toContain('#1 A change\nTests and checks');
      expect(after('7')).not.toContain('#1 A change\nTests and checks');
      expect(after('3')).not.toContain('#1 A change\nTests and checks');
      expect(after('7')).toContain('#2 A change\nTests and checks');
      expect(after('3')).toContain('#2 A change\nTests and checks');
    });

    it('scales every zoom tab to the same maximum, so a pull request draws the same size whichever tab is open', () => {
      const old = pull({
        number: 1,
        mergedAt: at(-10 * 24 * 60 + 210),
        createdAt: at(-10 * 24 * 60 - 60),
        // Held 200 minutes — outside every zoom preset but "All", and big enough to
        // dominate a scale computed only from "All"'s own pull requests.
        commits: [commit('a', -10 * 24 * 60, [check('Test', -10 * 24 * 60 + 2, -10 * 24 * 60 + 202)])],
      });
      // Both recent enough to be in every tab, each on its own held minutes.
      const recentA = pull({ number: 2, mergedAt: at(60), commits: [commit('b', 0, [check('Test', 2, 12)])] });
      const recentB = pull({ number: 3, mergedAt: at(120), commits: [commit('c', 60, [check('Test', 62, 67)])] });
      const html = render({ pulls: [old, recentA, recentB] });
      const heightOf = (id) => {
        const panel = html.split(`id="evopanel-${id}"`)[1];
        return Number(panel.match(/<rect class="evobar checks"[^>]*height="([\d.]+)"><title>#2\b/)[1]);
      };
      // Without a shared scale, "7" would size #2's bar against only #2 and #3 (much
      // taller); "all" sizes it against #1's 200 minutes too (a sliver). They must agree.
      expect(heightOf('7')).toBeCloseTo(heightOf('all'));
    });

    it('shows there is no span of time to plot, rather than collapsing every bar onto one point, where every pull request merged in the same second', () => {
      const html = render({
        pulls: [
          pull({ number: 1, mergedAt: at(60), commits: [commit('a', 0, [check('Test', 2, 12)])] }),
          pull({ number: 2, mergedAt: at(60), commits: [commit('b', 0, [check('Test', 2, 12)])] }),
        ],
      });
      expect(sectionOf(html)).toContain('no span of time to plot');
    });

    it("stacks each pull request's own minutes by kind, local review on tests and checks, and leaves out a kind that held none of it", () => {
      const reviewed = renderBlock([
        { at: at(60), phase: 'start' },
        { at: at(61), phase: 'review-start', kind: 'code-review', level: 'high' },
        { at: at(71), phase: 'review-end', kind: 'code-review', level: 'high' },
        { at: at(72), phase: 'pushed' },
      ]);
      const html = render({
        pulls: [
          pull({ number: 1, mergedAt: at(60), body: withRecord(0), commits: [commit('a', 0, [check('Test', 2, 12)])] }),
          pull({ number: 2, mergedAt: at(120), body: reviewed, commits: [commit('b', 60, [check('Test', 72, 82), check('Lint', 72, 90)])] }),
        ],
      });
      const section = sectionOf(html);
      expect(section).toContain('#1 A change\nTests and checks: 10m 00s');
      expect(section).toContain('#2 A change\nTests and checks: 18m 00s');
      expect(section).toContain('#2 A change\nLocal code review: 10m 00s');
      // Neither pull request marked a security review, and the record has reviews, so it is a lane of zero and not drawn.
      expect(section).not.toContain('Local security review: 0');
      expect(section).not.toMatch(/evobar (code|security)-review/);
      // The local lane sits above the CI one, in its own colour.
      expect(section).toMatch(/<rect class="evobar checks"[^>]*><title>#2[\s\S]*<rect class="evobar local-code-review"[^>]*><title>#2/);
    });

    it('draws no CI code review or security review lane, even where a check is named for one', () => {
      const html = render({
        pulls: [
          pull({ number: 1, mergedAt: at(60), commits: [commit('a', 0, [check('Test', 2, 12)])] }),
          pull({ number: 2, mergedAt: at(120), commits: [commit('b', 60, [check('Test', 62, 72), check('claude-review', 62, 82), check('Security review', 62, 85)])] }),
        ],
      });
      const section = sectionOf(html);
      expect(section).toContain('#2 A change\nTests and checks: 23m 00s');
      expect(section).not.toMatch(/\nCode review|\nSecurity review|evobar code-review|evobar security-review/);
      const legend = section.split('<div class="legend grouped">')[1].split('</div></div>')[0];
      expect(legend).not.toMatch(/>(held by )?(code|security) review/);
    });

    it('says a pull request with no session record has no review lanes, rather than drawing them as zero', () => {
      const html = render({
        pulls: [
          pull({ number: 1, mergedAt: at(60), commits: [commit('a', 0, [check('Test', 2, 12)])] }),
          pull({ number: 2, mergedAt: at(120), body: withRecord(60), commits: [commit('b', 60, [check('Test', 62, 72)])] }),
        ],
      });
      const section = sectionOf(html);
      expect(section).toContain('#1 A change\nTests and checks: 10m 00s\nLocal code review: not recorded\nLocal security review: not recorded');
      // A record that marks no review reads the same: the lanes have nothing to draw and say why.
      expect(section).toContain('#2 A change\nTests and checks: 10m 00s\nLocal code review: not recorded');
    });

    it("sizes a pull request's dot by its own lines changed, on every panel", () => {
      const html = render({
        pulls: [
          pull({ number: 1, mergedAt: at(60), additions: 5, deletions: 0, commits: [commit('a', 0, [check('Test', 2, 12)])] }),
          pull({ number: 2, mergedAt: at(120), additions: 500, deletions: 0, commits: [commit('b', 60, [check('Test', 62, 72)])] }),
        ],
      });
      const section = sectionOf(html);
      expect(section).toContain('#1 A change · 5 lines changed');
      expect(section).toContain('#2 A change · 500 lines changed');
      const radiusOf = (number) => Number(section.match(new RegExp(`<circle class="evodot" cx="[^"]+" cy="[^"]+" r="([\\d.]+)"><title>#${number}`))[1]);
      expect(radiusOf(2)).toBeGreaterThan(radiusOf(1));
    });

    it('reads start to merge, rounds to merge and the share of red rounds from the pull request itself', () => {
      const html = render({
        pulls: [
          pull({ number: 1, mergedAt: at(60), commits: [commit('a', 0, [check('Test', 2, 12)])] }),
          pull({
            number: 2,
            mergedAt: at(300),
            commits: [commit('b', 0, [check('Test', 2, 12, 'failure')]), commit('c', 20, [check('Test', 22, 32)])],
          }),
        ],
      });
      const section = sectionOf(html);
      expect(section).toContain('#1 A change · 1h 00m to merge');
      expect(section).toContain('#1 A change · 1 round');
      expect(section).toContain('#2 A change · 2 rounds');
      // One round of the two failed.
      expect(section).toContain('#2 A change · 50% of its rounds red');
    });

    it('never places a day tick before the scale itself, even where every pull request merged inside one day', () => {
      const html = render({
        pulls: [
          pull({ number: 1, mergedAt: at(60), commits: [commit('a', 0, [check('Test', 2, 12)])] }),
          pull({ number: 2, mergedAt: at(120), commits: [commit('b', 60, [check('Test', 62, 72)])] }),
        ],
      });
      // The day-tick text is the only one centred; the y-axis ticks are end-anchored.
      const xs = [...sectionOf(html).matchAll(/<text class="etick" x="(-?[\d.]+)"[^>]*text-anchor="middle">/g)].map((match) => Number(match[1]));
      expect(xs.length).toBeGreaterThan(0);
      expect(xs.every((x) => x >= 52)).toBe(true);
    });

    it('escapes a pull request title inside the chart, rather than letting it write markup into the page', () => {
      const html = render({
        pulls: [
          pull({ number: 1, mergedAt: at(60), title: '<script>alert(1)</script>', commits: [commit('a', 0, [check('Test', 2, 12)])] }),
          pull({ number: 2, mergedAt: at(120), commits: [commit('b', 60, [check('Test', 62, 72)])] }),
        ],
      });
      expect(sectionOf(html)).not.toContain('<script>alert(1)</script>');
      expect(sectionOf(html)).toContain('&lt;script&gt;');
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

    it('picks and outlines the elements of a zoomed strip with no script, and carries no rule for the list that was under it', () => {
      const html = render({ pulls: [pull({ commits: [commit('a', 0, [job('Test', 2, 2, 12)])] })] });
      expect(pickablesIn(html, 1).length).toBeGreaterThan(0);
      expect(html).not.toMatch(/<script\b|\son(click|change|mouseover|input)=/i);
      expect(cssOf(html)).not.toMatch(/data-round|roundlist/);
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

  describe('the strip and the panel draw a local test run and the browser pass', () => {
    const recorded = (extra = []) =>
      renderBlock([{ at: at(0), phase: 'start' }, ...extra, { at: at(19), phase: 'pushed' }]);
    const testRun = (from, to, ...scopes) => ({ run: 'test', scopes, start: at(from), end: at(to) });
    const browser = (from, to) => [{ at: at(from), phase: 'browser-start' }, { at: at(to), phase: 'browser-end' }];
    const withBody = (body) => pull({ body, mergedAt: at(60), commits: [commit('a', 0, [check('Test', 20, 40)])] });
    const titlesOf = (html) => [...stripOf(html, 1).matchAll(/<span class="seg (?:review|local) ([\w-]+)[^"]*" style="[^"]*" title="([^"]*)"/g)].map((match) => [match[1], match[2]]);
    // The evolution panels need a second pull request to show a trend.
    const later = pull({ number: 2, mergedAt: at(120), commits: [commit('b', 60, [check('Test', 62, 72)])] });
    const panelOf = (html) => html.split('<h2>Evolution</h2>')[1].split('<h2>')[0];

    it('names a test run by its kind, duration and scope on hover, and the browser pass apart from it', () => {
      const html = render({ pulls: [withBody(recorded([testRun(2, 6, '@cockpit/api', 'tools/cycle-time'), ...browser(8, 14)]))] });
      expect(titlesOf(html)).toEqual([
        ['local-test', 'Local test run · 4m 00s · @cockpit/api, tools/cycle-time'],
        ['local-browser', 'Browser pass · 6m 00s'],
      ]);
    });

    const review = (kind, from, to) => [{ at: at(from), phase: 'review-start', kind, level: 'high' }, { at: at(to), phase: 'review-end', kind, level: 'high' }];
    const lanesIn = (html) => [...stripOf(html, 1).matchAll(/<span class="lane ([\w-]+)" style="([^"]*)" title="([^"]*)"/g)].map((match) => ({ cls: match[1], style: match[2], title: match[3] }));

    const rowsOf = (html) => lanesIn(html).map((lane) => [lane.cls, /top:(-?[\d.]+)%/.exec(lane.style)[1]]);

    it('keeps the longest of two overlapping pieces on the line and the other above it, each hovering its own full length', () => {
      const html = render({ pulls: [withBody(recorded([...review('code-review', 2, 10), testRun(8, 12, 'a')]))] });
      expect(lanesIn(html).map((lane) => [lane.cls, lane.title])).toEqual([
        ['local-code-review', 'Local code review · high · 8m 00s'],
        ['local-test', 'Local test run · 4m 00s · a'],
      ]);
      expect(rowsOf(html)).toEqual([['local-code-review', '0'], ['local-test', '-100']]);
      expect(stripOf(html, 1)).not.toMatch(/repeating-linear-gradient|overlap/);
    });

    it('stacks three overlapping pieces off the line, the longest on it, and makes room for them', () => {
      const html = render({ pulls: [withBody(recorded([...review('code-review', 2, 10), testRun(4, 12, 'a'), ...browser(6, 14)]))] });
      // All three run eight minutes, so the fixed order decides: the code review holds the line.
      expect(rowsOf(html)).toEqual([['local-code-review', '0'], ['local-test', '-100'], ['local-browser', '100']]);
      expect(rowOf(html, 1)).toMatch(/<span class="track stacked" style="[^"]*--above:1;--below:1">/);
    });

    it('lets the line show the coding around a piece, where it is not running, rather than leave it blank', () => {
      const html = render({ pulls: [withBody(recorded([...review('code-review', 2, 10), testRun(8, 14, 'a')]))] });
      expect(stripOf(html, 1)).toMatch(/<span class="seg parallel coding"/);
      expect(stripOf(html, 1)).not.toMatch(/<span class="seg parallel"/);
    });

    it('ends each lane where its own work ends within the stretch', () => {
      const html = render({ pulls: [withBody(recorded([...review('code-review', 2, 14), ...review('security-review', 4, 6)]))] });
      const [code, security] = lanesIn(html).map((lane) => ({ left: Number(/left:([\d.]+)%/.exec(lane.style)[1]), width: Number(/width:([\d.]+)%/.exec(lane.style)[1]) }));
      expect(code.left + code.width).toBeCloseTo(100, 1);
      expect(security.left + security.width).toBeCloseTo(((6 - 2) / 12) * 100, 1);
    });

    it('draws a review with nothing alongside it as one row with no lanes', () => {
      const html = render({ pulls: [withBody(recorded(review('code-review', 2, 10)))] });
      expect(lanesIn(html)).toEqual([]);
      expect(rowOf(html, 1)).not.toContain('track stacked');
    });

    it('says on the hover of a review whose end was written with another that it ended together with it', () => {
      const marks = [
        { at: at(2), phase: 'review-start', kind: 'code-review', level: 'high' },
        { at: at(2), phase: 'review-start', kind: 'security-review', level: 'high' },
        { at: at(10), phase: 'review-end', kind: 'code-review', level: 'high' },
        { at: at(10), phase: 'review-end', kind: 'security-review', level: 'high' },
      ];
      const html = render({ pulls: [withBody(recorded(marks))] });
      expect(lanesIn(html).map((lane) => lane.title)).toEqual([
        'Local code review · high · 8m 00s · ended together with the other review, so its own length is not recorded',
        'Local security review · high · 8m 00s · ended together with the other review, so its own length is not recorded',
      ]);
    });

    it('keys the test run and the browser pass as local, at the time they ran', () => {
      const html = render({ pulls: [withBody(recorded())] });
      const legend = html.split('<h2>Each pull request, start to merge</h2>')[1].split('<div class="card">')[0];
      expect(legend).toContain('test run (local, at the time it ran)');
      expect(legend).toContain('browser pass (local, at the time it ran)');
    });

    it("stacks a pull request's test run and browser pass in their own lanes, above CI", () => {
      const html = render({ pulls: [withBody(recorded([testRun(2, 6, 'a'), ...browser(8, 14)])), later] });
      const panel = panelOf(html);
      expect(panel).toContain('#1 A change\nLocal test run: 4m 00s');
      expect(panel).toContain('#1 A change\nBrowser pass: 6m 00s');
      expect(panel).toMatch(/<rect class="evobar checks"[^>]*><title>#1[\s\S]*<rect class="evobar local-test"[^>]*><title>#1[\s\S]*<rect class="evobar local-browser"[^>]*><title>#1/);
    });

    it('says test time is not recorded, rather than zero, for a record with no test runs', () => {
      const html = render({ pulls: [withBody(recorded()), later] });
      const panel = panelOf(html);
      expect(panel).toContain('#1 A change\nTests and checks: 20m 00s\nLocal code review: not recorded\nLocal security review: not recorded\nLocal test run: not recorded\nBrowser pass: not recorded');
      expect(panel).toContain('#2 A change\nTests and checks: 10m 00s\nLocal code review: not recorded');
      expect(panel).not.toMatch(/evobar local-(test|browser)/);
    });

    it('reads a pull request with no session record as not recorded on its strip, with no local slice drawn', () => {
      const html = render({ pulls: [pull({ commits: [commit('a', 0, [check('Test', 20, 40)])] })] });
      expect(rowOf(html, 1)).toContain('>not recorded<');
      expect(stripOf(html, 1)).not.toMatch(/seg (review|local)/);
    });
  });

  describe('a strip is drawn to scale', () => {
    const css = cssOf(render());
    const placement = (html, selector) => {
      const [, left, width] = new RegExp(`${selector}[^>]*style="left:calc\\(var\\(--span\\) \\* ([\\d.]+)[^;]*;width:calc\\(var\\(--span\\) \\* ([\\d.]+)\\)`).exec(stripOf(html, 1));
      return { left: Number(left), width: Number(width) };
    };

    it('places the coding and the first CI Round at their own times and lengths of the scale', () => {
      // Thirty-three minutes before the first push, a round of 21, and six waiting: sixty minutes in all.
      const html = render({ pulls: [pull({ body: withRecord(0), mergedAt: at(60), commits: [commit('a', 0, [check('Test', 33, 54)])] })] });
      expect(placement(html, '<span class="seg coding')).toEqual({ left: 0, width: 0.55 });
      expect(placement(html, '<span class="seg round')).toEqual({ left: 0.55, width: 0.35 });
    });

    it('gives a part no gap and no push on its neighbours, so a part too short to see is drawn over what follows', () => {
      expect(css).toMatch(/\.seg \{[^}]*position: absolute;/);
      expect(css).toMatch(/\.seg \{[^}]*min-width: 3px;/);
      expect(css).not.toMatch(/\.seg \+ \.seg/);
      expect(css).not.toMatch(/\.seg[^{]*\{[^}]*flex: ?\d/);
    });

    it('draws a pull request shorter than the scale from the start of its strip, not stretched across it', () => {
      const html = render({ pulls: [pull({ number: 1, mergedAt: at(60) }), pull({ number: 2, mergedAt: at(30), commits: [commit('b', 0, [check('Test', 2, 12)])] })] });
      expect(placement(html, '<span class="seg round').left).toBeCloseTo(2 / 60, 4);
      const shorter = rowOf(html, 2);
      expect(shorter).toMatch(/seg wait" style="left:calc\(var\(--span\) \* 0\.2/);
      expect(shorter).not.toContain('fill-space');
    });
  });

  describe('a CI Round is named on the strip, in its detail and in the legend', () => {
    const rounds = (...commits) => pull({ mergedAt: at(120), commits });
    const two = rounds(commit('a', 0, [check('Test', 2, 12), check('Lint', 2, 5, 'failure')]), commit('b', 30, [check('Test', 31, 40)]));

    it('carries a long and a short name in each round, and the red mark beside them', () => {
      const [first, second] = stripOf(render({ pulls: [two] }), 1).split('<span class="seg round').slice(1);
      expect(first).toContain('<span class="cilong">CI Round 1</span><span class="cishort">CI 1</span>');
      expect(first).toContain('<i class="mark red" aria-hidden="true">✕</i>');
      expect(second).toContain('<span class="cilong">CI Round 2</span><span class="cishort">CI 2</span>');
      expect(second).not.toContain('mark');
    });

    it('shows the short name from 2.6em wide and the long from 6em, wider for a second digit or a mark, and only the mark below that', () => {
      const css = cssOf(render({ pulls: [two] }));
      expect(css).toContain('.cilong, .cishort { display: none; }');
      expect(css).toContain('@container (min-width: 2.6em) { .seg.round.d1.m0 .cishort { display: inline; } }');
      expect(css).toContain('@container (min-width: 6em) { .seg.round.d1.m0 .cishort { display: none; } .seg.round.d1.m0 .cilong { display: inline; } }');
      expect(css).toContain('@container (min-width: 4.5em) { .seg.round.d1.m1 .cishort { display: inline; } }');
      expect(css).toContain('@container (min-width: 3.2em) { .seg.round.d2.m0 .cishort { display: inline; } }');
      expect(css).toMatch(/\.seg\.round \{[^}]*container-type: inline-size;/);
    });

    it('classes a round by the digits in its number and the marks beside its name, which the widths above are keyed on', () => {
      const [first, second] = stripOf(render({ pulls: [two] }), 1).split('<span class="seg round').slice(1);
      expect(first).toMatch(/^ red d1 m1"/);
      expect(second).toMatch(/^ d1 m0"/);
    });

    it('names the same round in the closed strip and in the zoomed one, each with its own width to choose a name by', () => {
      const row = rowOf(render({ pulls: [two] }), 1);
      const [closed, zoomed] = [stripOf(render({ pulls: [two] }), 1), zoomedOf(render({ pulls: [two] }), 1).split('</label>')[0]];
      // The zoomed chip also carries the radio that picks the round; the closed one is a name and nothing else.
      expect(closed).toContain('<span class="cilong">CI Round 1</span>');
      expect(zoomed).toMatch(/<span class="cilong">CI Round 1<input [^>]*><\/span>/);
      expect(row.match(/class="seg round/g)).toHaveLength(4);
    });

    it('opens a round\'s detail "CI Round N · …", and names the round the same on hover', () => {
      const html = render({ pulls: [two] });
      const details = pickablesIn(html, 1).filter((each) => /^CI Round \d · /.test(each.label));
      expect([...new Set(details.map((each) => readDetail(each.detail).head))]).toEqual(['CI Round 1', 'CI Round 2']);
      expect([...stripOf(html, 1).matchAll(/class="seg round[^"]*" style="[^"]*" title="([^"·]*) ·/g)].map((match) => match[1].trim())).toEqual(['CI Round 1', 'CI Round 2']);
    });

    it('defines a CI Round once in the legend, in one line', () => {
      const html = render({ pulls: [two] });
      const legend = html.split('<h2>Each pull request, start to merge</h2>')[1].split('<div class="card">')[0];
      expect(legend).toContain('<b>CI Round</b>: a push, until the last check on it finishes; a red one failed and was pushed again.');
      expect(html.match(/a push, until the last check on it finishes/g)).toHaveLength(1);
    });
  });

  describe('clicking a strip zooms it, and clicking again closes it', () => {
    const away = pull({ mergedAt: at(250), commits: [commit('a', 0, [check('Test', 2, 12)]), commit('b', 20, [check('Test', 212, 222)])] });
    const html = render({ pulls: [away] });
    const css = cssOf(html);

    it('makes the strip the label of a checkbox, so a click on it toggles the zoomed form', () => {
      const row = rowOf(html, 1);
      expect(row).toMatch(/<input type="checkbox" class="zoomtoggle" id="zoom-1"/);
      expect(row.match(/<label class="striphit[^"]*" for="zoom-1"/g)).toHaveLength(2);
      expect(css).toContain('.zoomtoggle:checked ~ .zoomed { display: block; }');
      expect(css).toContain('.zoomtoggle:checked ~ .whenclosed { display: none; }');
      expect(css).toMatch(/\.zoomed \{ display: none; \}/);
    });

    it('draws a closed strip with no axis, on the shared scale', () => {
      const row = rowOf(html, 1);
      expect(row.split('<div class="zoomed">')[0]).not.toContain('class="clockaxis"');
      expect(row.split('<div class="zoomed">')[0]).toMatch(/--span:calc\(100% - var\(--break\) \* 1\)/);
    });

    it('opens the pull request on a clock-time axis from its start to its merge, above its detail box', () => {
      const zoomed = zoomedOf(html, 1);
      expect(zoomed.indexOf('class="clockaxis"')).toBeGreaterThan(zoomed.indexOf('class="track'));
      expect(zoomed.indexOf('<div class="detailbox">')).toBeGreaterThan(zoomed.indexOf('class="clockaxis"'));
      const labels = [...zoomed.matchAll(/<span class="clocktick (\w+)" style="[^"]*">([^<]*)</g)].map((match) => [match[1], match[2]]);
      expect(labels[0]).toEqual(['start', '11:00']);
      expect(labels[labels.length - 1]).toEqual(['end', '15:10']);
    });

    it('reads the real clock time either side of time away in the zoomed axis', () => {
      const labels = [...zoomedOf(html, 1).matchAll(/<span class="clocktick (\w+)" style="[^"]*">([^<]*)</g)].map((match) => match[2]);
      expect(labels).toContain('11:12');
      expect(labels).toContain('14:32');
      expect(labels.filter((label) => label > '11:12' && label < '14:32')).toEqual([]);
    });

    it('zooms the whole of a pull request that was cut on the shared scale', () => {
      const long = render({ pulls: [pull({ mergedAt: at(60 * 8), commits: [commit('a', 0, [check('Test', 2, 12)]), commit('b', 100, [check('Test', 101, 170)]), commit('c', 300, [check('Test', 301, 420)])] })] });
      expect(stripOf(long, 1)).toContain('clipmark');
      const zoomed = zoomedOf(long, 1);
      expect(zoomed).not.toContain('clipmark');
      expect(zoomed).toContain('CI Round 3');
      expect(zoomed).toMatch(/<span class="clocktick end"[^>]*>19:00</);
    });

    it('reads a pull request no check ran on as it did, with nothing to zoom', () => {
      const html = render({ pulls: [pull({ commits: [commit('a', 0)] })] });
      expect(rowOf(html, 1)).toContain('no check ran on it');
      expect(rowOf(html, 1)).not.toContain('class="clockaxis"');
    });
  });

  describe('every element of a zoomed strip can be picked, and the page carries its detail for the pick', () => {
    /** Coding, a round, fixing, a round and the wait to merge. */
    const stretches = pull({ body: withRecord(0), mergedAt: at(60), commits: [commit('a', 0, [check('Test', 10, 20)]), commit('b', 30, [check('Test', 32, 40)])] });
    const away = pull({ mergedAt: at(250), commits: [commit('a', 0, [check('Test', 2, 12)]), commit('b', 20, [check('Test', 212, 222)])] });
    const local = (...marks) => pull({ body: session(...marks), mergedAt: at(60), commits: [commit('a', 0, [check('Test', 20, 40)])] });
    const slices = local(...reviewMarks('code-review', 5, 15), testRunMark(2, 4, 'a'), ...browserMarks(16, 18));
    const parallel = local(...reviewMarks('code-review', 2, 10), testRunMark(8, 12, 'a'));
    const jobs = pull({ commits: [commit('a', 0, [job('Checks', 0, 0, 5), job('Test', 1, 3, 9)])] });
    const unread = pull({ commits: [commit('a', 0, [check('Test', 2, 12, 'success', { queue: { state: 'not-recorded', why: 'unreadable' } })])] });

    it.each([
      { situation: 'a coding stretch', pulls: [stretches], label: /^Coding before the first push · /, radios: 1, head: 'Coding before the first push' },
      { situation: 'a fixing stretch', pulls: [stretches], label: /^Fixing before the next push · /, radios: 1, head: 'Fixing before the next push' },
      { situation: 'a wait to merge', pulls: [stretches], label: /^Waiting to merge · /, radios: 1, head: 'Waiting to merge' },
      { situation: 'time away', pulls: [away], label: /^Away for 3h 20m · /, radios: 1, head: 'Away for 3h 20m' },
      { situation: 'a local review cut out of the line', pulls: [slices], label: /^Local code review · /, radios: 1, head: 'Local code review' },
      { situation: 'a test run cut out of the line', pulls: [slices], label: /^Local test run · /, radios: 1, head: 'Local test run' },
      { situation: 'a browser pass cut out of the line', pulls: [slices], label: /^Browser pass · /, radios: 1, head: 'Browser pass' },
      { situation: 'a review stacked as a lane of a parallel stretch', pulls: [parallel], label: /^Local code review · /, radios: 1, head: 'Local code review' },
      { situation: 'a test run stacked as a lane of a parallel stretch', pulls: [parallel], label: /^Local test run · /, radios: 1, head: 'Local test run' },
      { situation: 'the coding around the local work of a parallel stretch', pulls: [parallel], label: /^Coding before the first push · .* around the local work$/, radios: 1, head: 'Coding before the first push' },
      { situation: "a round's job lane", pulls: [jobs], label: /^Checks · /, radios: 1, head: 'Checks' },
      { situation: "a job's lead and its lane, which pick the same job", pulls: [jobs], label: /^Test · /, radios: 2, head: 'Test' },
      { situation: "a round's block, its two names and its own background, which pick the same round", pulls: [jobs], label: /^CI Round 1 · /, radios: 3, head: 'CI Round 1' },
      { situation: 'a round whose jobs were not read', pulls: [unread], label: /^CI Round 1 · /, radios: 3, head: 'CI Round 1' },
    ])('picks $situation, with one detail on the page for however many controls pick it', ({ pulls, label, radios, head }) => {
      const html = render({ pulls });
      const found = pickingIn(html, 1, label);
      expect(found).toHaveLength(radios);
      expect(new Set(found.map((each) => each.detailId)).size).toBe(1);
      expect(readDetail(found[0].detail).head).toBe(head);
      // However many radios show it, the page says it once.
      const said = [...zoomedOf(html, 1).matchAll(/<div class="detail" id="[^"]+">([\s\S]*?)<\/div>/g)].map((match) => match[1]);
      expect(said.filter((each) => each === found[0].detail)).toHaveLength(1);
    });

    it('lays a radio over no element of the closed strip, which only zooms', () => {
      const row = rowOf(render({ pulls: [jobs] }), 1);
      expect(row.split('<div class="zoomed">')[0]).not.toContain('type="radio"');
      expect(row.split('<div class="zoomed">')[0]).not.toContain('class="pick"');
    });

    it('offers nothing to pick on a pull request no check ran on', () => {
      const row = rowOf(render({ pulls: [pull({ commits: [commit('a', 0)] })] }), 1);
      expect(row).not.toContain('class="pick"');
      expect(row).not.toContain('class="detailbox"');
    });
  });

  describe('a detail says what the tooltip said, split into a heading and a line', () => {
    const jobs = pull({ commits: [commit('a', 0, [job('Checks', 0, 0, 5), job('Test', 1, 3, 9), job('Lint', 0, 0, 4, 'failure')])] });
    const held = pull({ commits: [commit('a', 0, [job('Test', 2, 2, 12), job('E2E (F3)', 2, 2, 20)])] });
    const local = (...marks) => pull({ body: session(...marks), mergedAt: at(60), commits: [commit('a', 0, [check('Test', 20, 40)])] });

    it.each([
      {
        situation: 'a job, with the round it ran in as context',
        pulls: [jobs],
        label: /^Test · /,
        head: 'Test',
        line: 'started 11:03:00, stopped 11:09:00 · ran 6m 00s · waited 2m 00s for a runner · passed',
        context: 'in CI Round 1 · pushed 15 Sept 2026, 11:00',
      },
      {
        situation: 'a failed job',
        pulls: [jobs],
        label: /^Lint · /,
        head: 'Lint',
        line: 'started 11:00:00, stopped 11:04:00 · ran 4m 00s · waited 0s for a runner · failed',
        context: 'in CI Round 1 · pushed 15 Sept 2026, 11:00',
      },
      {
        situation: 'a local review',
        pulls: [local(...reviewMarks('code-review', 5, 15))],
        label: /^Local code review · /,
        head: 'Local code review',
        line: 'high · 10m 00s',
      },
      {
        situation: 'a test run',
        pulls: [local(testRunMark(2, 6, '@cockpit/api', 'tools/cycle-time'))],
        label: /^Local test run · /,
        head: 'Local test run',
        line: '4m 00s · @cockpit/api, tools/cycle-time',
      },
      {
        situation: 'a browser pass',
        pulls: [local(...browserMarks(8, 14))],
        label: /^Browser pass · /,
        head: 'Browser pass',
        line: '6m 00s',
      },
      {
        situation: 'a first push with no session record to say what came before',
        pulls: [pull()],
        label: /^From the first commit to the first push · /,
        head: 'From the first commit to the first push',
        line: '2m 00s · no session record, so any coding before the first commit is not recorded',
      },
      {
        situation: 'a review that ended together with the other',
        pulls: [
          local(
            { at: at(2), phase: 'review-start', kind: 'code-review', level: 'high' },
            { at: at(2), phase: 'review-start', kind: 'security-review', level: 'high' },
            { at: at(10), phase: 'review-end', kind: 'code-review', level: 'high' },
            { at: at(10), phase: 'review-end', kind: 'security-review', level: 'high' },
          ),
        ],
        label: /^Local code review · /,
        head: 'Local code review',
        line: 'high · 8m 00s · ended together with the other review, so its own length is not recorded',
      },
    ])('says $situation', ({ pulls, label, head, line, context }) => {
      const [found] = pickingIn(render({ pulls }), 1, label);
      expect(readDetail(found.detail)).toEqual({ head, line, context });
    });

    it('opens a round with its line and what held it in order, and every job beneath it', () => {
      const html = render({ pulls: [held] });
      const [round] = pickingIn(html, 1, /^CI Round 1 · /);
      const { head, line } = readDetail(round.detail);
      expect(head).toBe('CI Round 1');
      expect(line).toBe('18m 00s · pushed 15 Sept 2026, 11:02 · held by Test, then E2E (F3)');
      expect(round.detail).toContain(
        '<ul class="joblist"><li>Test · started 11:02:00, stopped 11:12:00 · ran 10m 00s · waited 0s for a runner · passed</li><li>E2E (F3) · started 11:02:00, stopped 11:20:00 · ran 18m 00s · waited 0s for a runner · passed</li></ul>',
      );
    });

    it('names the round and its push time under a job, and not what held the round or for how long', () => {
      const html = render({ pulls: [held] });
      const [test, e2e] = ['Test', 'E2E (F3)'].map((name) => readDetail(pickingIn(html, 1, new RegExp(`^${name.replace(/[()]/g, '\\$&')} · started`))[0].detail));
      for (const { context } of [test, e2e]) {
        expect(context).toBe('in CI Round 1 · pushed 15 Sept 2026, 11:02');
      }
      expect(pickingIn(html, 1, /^Test · started/)[0].detail).not.toContain('held by');
    });

    it('escapes a job name and a test scope in the radio\'s label and in the detail, rather than letting them write markup', () => {
      const html = render({ pulls: [local(testRunMark(2, 6, 'apps/<b>"web"</b>')), pull({ number: 2, url: 'https://github.com/o/r/pull/2', commits: [commit('a', 0, [job('E2E "phone" <i>', 0, 0, 5)])] })] });
      expect(html).not.toContain('<b>"web"</b>');
      expect(html).not.toContain('<i>');
      const [run] = pickingIn(html, 1, /^Local test run · /);
      expect(run.label).toContain('apps/&lt;b&gt;&quot;web&quot;&lt;/b&gt;');
      expect(readDetail(run.detail).line).toBe('4m 00s · apps/&lt;b&gt;&quot;web&quot;&lt;/b&gt;');
      const [lane] = pickingIn(html, 2, /^E2E &quot;phone&quot; &lt;i&gt; · /);
      expect(readDetail(lane.detail).head).toBe('E2E &quot;phone&quot; &lt;i&gt;');
    });

    it('lists the jobs of a round only in that round\'s detail, with when each started and stopped', () => {
      const html = render({ pulls: [pull({ commits: [commit('a', 0, [job('Test', 2, 2, 12)])] })] });
      const [round] = pickingIn(html, 1, /^CI Round 1 · /);
      expect(round.detail).toContain('<ul class="joblist"><li>Test · started 11:02:00, stopped 11:12:00 · ran 10m 00s · waited 0s for a runner · passed</li></ul>');
      const outsideDetails = zoomedOf(html, 1).replace(/<div class="detail" id="[^"]+">[\s\S]*?<\/div>/g, '');
      expect(outsideDetails).not.toContain('joblist');
    });
  });

  describe('until something is picked, the box under the axis holds the summary line and says to click an element', () => {
    const html = render({ pulls: [pull({ mergedAt: at(60), commits: [commit('a', 0, [check('Test', 2, 12, 'failure')]), commit('b', 20, [check('Test', 22, 30)])] })] });
    const zoomed = zoomedOf(html, 1);
    const css = cssOf(html);

    it('holds the summary line and names a phase, a CI job and a local run as what to click', () => {
      const box = zoomed.split('<div class="detailbox">')[1];
      expect(box).toMatch(/^<p class="hint">2 CI Rounds, 1 red &middot; 1h 00m to merge &middot; click a phase, a CI job or a local run on the strip to read it here\.<\/p>/);
      expect(zoomed.indexOf('<div class="detailbox">')).toBeGreaterThan(zoomed.indexOf('class="clockaxis"'));
    });

    it('hides the hint once any radio of the strip is checked, and every detail until its own radio is', () => {
      expect(css).toContain('.strip:has(.pick:checked) .detailbox .hint { display: none; }');
      expect(css).toContain('.detail { display: none; }');
      const picks = pickablesIn(html, 1);
      expect(picks.length).toBeGreaterThan(0);
      // A detail with no rule of its own would never be shown, and one shown by another's radio would be the wrong one.
      expect(picks.filter((each) => each.detail === undefined)).toEqual([]);
      expect(new Set(picks.map((each) => each.detailId)).size).toBe(zoomed.match(/class="detail" id=/g).length);
    });

    it('keeps the notes after the box', () => {
      const box = zoomed.indexOf('<div class="detailbox">');
      expect(box).toBeGreaterThan(-1);
      expect(zoomed.indexOf('<p class="clipnote">No session record')).toBeGreaterThan(box);
    });
  });

  describe('one pull request holds one pick, kept while its zoom is closed', () => {
    const rounded = (number) =>
      pull({ number, url: `https://github.com/o/r/pull/${number}`, mergedAt: at(120), commits: [commit(`a${number}`, 0, [check('Test', 2, 12)]), commit(`b${number}`, 30, [check('Test', 31, 40)])] });
    const html = render({ pulls: [rounded(1), rounded(2)] });

    it('names every radio of one pull request alike, and the radios of two pull requests apart', () => {
      const [first, second] = [1, 2].map((number) => new Set(pickablesIn(html, number).map((each) => each.name)));
      expect([first.size, second.size]).toEqual([1, 1]);
      expect([...first][0]).not.toBe([...second][0]);
    });

    it('gives every radio and every detail an id of its own across the page, so two pull requests with the same rounds never share one', () => {
      const ids = (pattern) => [...html.matchAll(pattern)].map((match) => match[1]);
      for (const unique of [ids(/<input type="radio" class="pick"[^>]* id="([^"]+)"/g), ids(/<div class="detail" id="([^"]+)"/g)]) {
        expect(unique.length).toBeGreaterThan(0);
        expect(new Set(unique).size).toBe(unique.length);
      }
      expect(pickablesIn(html, 1).map((each) => each.detailId).filter((id) => pickablesIn(html, 2).some((other) => other.detailId === id))).toEqual([]);
    });

    it('shows a detail by its radio alone, so the pick stands whether the zoom is open or closed', () => {
      const rules = cssOf(html).split('\n').filter((line) => line.startsWith('.strip:has(:is(#') || line.startsWith('.strip:has(#'));
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(rule).toMatch(/^\.strip:has\((:is\(#[\w-]+(, #[\w-]+)+\)|#[\w-]+):checked\) #[\w-]+ \{ display: block; \}$/);
        expect(rule).not.toContain('zoom');
      }
    });
  });

  describe('the lists under a strip are gone', () => {
    const html = render({ pulls: [pull({ commits: [commit('a', 0, [job('Test', 2, 2, 12)]), commit('b', 20, [job('Test', 22, 22, 30)])] })] });
    const row = rowOf(html, 1);

    it('has no round list, and no job list outside a round\'s detail', () => {
      expect(row).not.toContain('roundlist');
      expect(row.replace(/<div class="detail" id="[^"]+">[\s\S]*?<\/div>/g, '')).not.toContain('joblist');
    });

    it('leaves a closed strip the summary line and the notes, with no collapsed section', () => {
      // Under the closed strip: what follows its screen-reader line, beyond the block a click opens.
      const under = row.slice(row.indexOf('1h 00m to merge, 2 CI Rounds</span>'));
      expect(row).not.toContain('<details');
      expect(row).not.toContain('<summary');
      expect(under).toContain('<p class="clipnote whenclosed">2 CI Rounds &middot; 1h 00m to merge</p>');
      expect(under).toContain('<div class="whenclosed"><p class="clipnote">No session record');
    });
  });

  describe('the zoomed view closes from the axis and the empty rows, and never from an element', () => {
    const html = render({ pulls: [pull({ commits: [commit('a', 0, [job('Test', 2, 2, 12)])] })] });
    const zoomed = zoomedOf(html, 1);

    it('makes the axis a label of the zoom checkbox, and says that it closes', () => {
      // A span in the label, since a label holds phrasing content only; the styles make it a block.
      expect(zoomed).toMatch(/<label class="axishit" for="zoom-1"><span class="clockaxis"[^>]*title="Clock time in Belgian time\. Click to close">/);
      expect(cssOf(html)).toMatch(/\.clockaxis \{ display: block;/);
    });

    it('says with the cursor that the empty rows close the zoom, where an element shows its own pointer', () => {
      expect(cssOf(html)).toMatch(/\.zoomed \.striphit \{ cursor: zoom-out;/);
      expect(cssOf(html)).toMatch(/\.pick \{[^}]*cursor: pointer;/);
    });

    it('keeps the zoomed strip a label of the zoom checkbox, with every radio inside it and laid over its own element', () => {
      const [track] = zoomed.split('<label class="axishit"');
      expect(track).toMatch(/^\s*<label class="striphit" for="zoom-1">/);
      expect(track.match(/<input type="radio" class="pick"/g)).toHaveLength(pickablesIn(html, 1).length);
      // Laid over the element and invisible: a click lands on the radio, which checks it, rather than on the label around it.
      expect(cssOf(html)).toMatch(/\.pick \{[^}]*position: absolute;[^}]*inset: 0;[^}]*opacity: 0;/);
      // The rows of lanes standing above and below the line are inside the label, so a click on an empty one closes the zoom.
      expect(cssOf(html)).toMatch(/\.zoomed \.striphit \{[^}]*display: flow-root;/);
    });
  });

  describe('a click on a job picks the job and not the round around it, a lead included', () => {
    it("lays the round's own radio under the lanes' radios, which a faded lead's own layer would otherwise be put beneath", () => {
      const css = cssOf(render({ pulls: [pull({ commits: [commit('a', 0, [job('Test', 1, 3, 9)])] })] }));
      expect(css).toContain('.seg.round > .pick { z-index: 0; }');
      expect(css).toContain('.lane > .pick { z-index: 2; }');
      expect(css).toMatch(/\.lane\.lead \{[^}]*opacity: 0\.55;/);
    });
  });

  describe('the stacked job lanes of a round read as separate bars', () => {
    it("parts a round's stacked job lanes and leads with a hairline in the page's background along their top edge, drawn on the lane so nothing moves", () => {
      const css = cssOf(render({ pulls: [pull({ commits: [commit('a', 0, [job('Test', 1, 3, 9)])] })] }));
      // Scoped to a round, so a parallel stretch's local lanes do not match; not under .zoomed, so a closed and a zoomed strip draw it alike.
      expect(css).toMatch(/(^|\n)\.seg\.round \.lane\.job, \.seg\.round \.lane\.lead \{ border-top: 1px solid var\(--card\); \}/);
      // A border takes from the lane's own box only while every box on the page is border-box.
      expect(css).toContain('* { box-sizing: border-box; }');
    });
  });

  describe('hover outlines the element under the pointer and nothing around it', () => {
    const css = cssOf(render({ pulls: [pull({ commits: [commit('a', 0, [job('Test', 2, 2, 12)])] })] }));

    it('outlines a hovered element of a zoomed strip', () => {
      expect(css).toContain('.zoomed .seg:hover, .zoomed .lane:hover { outline: 2px solid var(--ink-1);');
    });

    it('un-outlines the round or the parallel stretch around a hovered lane', () => {
      expect(css).toContain('.zoomed .seg.round:hover:has(.lane:hover), .zoomed .seg.parallel:hover:has(.lane:hover) { outline: none; }');
    });

    it('outlines a round\'s name chip when its radio is hovered, and not the round', () => {
      expect(css).toContain('.zoomed .roundlabel:has(.pick:hover) .cilong, .zoomed .roundlabel:has(.pick:hover) .cishort { outline: 2px solid var(--ink-1); }');
      expect(css).toContain('.zoomed .seg.round:has(.roundlabel .pick:hover) { outline: none; }');
    });

    it('outlines the picked element in the accent', () => {
      expect(css).toMatch(/\.zoomed \.seg:has\(> \.pick:checked\), \.zoomed \.lane:has\(> \.pick:checked\) \{ outline: 2px solid var\(--accent\);/);
      // Whichever name the round shows at its width, since the radio checked may be the hidden name's.
      expect(css).toContain('.zoomed .roundlabel:has(.pick:checked) .cilong, .zoomed .roundlabel:has(.pick:checked) .cishort { outline: 2px solid var(--accent); }');
    });
  });

  describe("a round's jobs are drawn where they ran, each its own lane", () => {
    const strip = (checks, overrides = {}) => stripOf(render({ pulls: [pull({ commits: [commit('a', 0, checks)], ...overrides })] }), 1);
    /** Every job lane and lead in a strip, as the browser places it: its share of the round, its row and its hover. */
    const lanesIn = (html) =>
      [...html.matchAll(/<span class="lane (job|lead)([^"]*)" style="left:([\d.]+)%;width:([\d.]+)%;top:(-?\d+)%" title="([^"]*)">/g)].map(([, kind, flags, left, width, top, title]) => ({
        kind,
        flags: flags.trim().split(' ').filter(Boolean),
        left: Number(left),
        width: Number(width),
        top: Number(top),
        title,
      }));
    const jobsOf = (html) => lanesIn(html).filter((lane) => lane.kind === 'job');
    const share = (minutes, whole) => Number(((minutes / whole) * 100).toFixed(3));

    it('draws Checks, Test and four shards as six lanes, each from its own start to its own stop, the shards overlapping', () => {
      const html = strip([
        job('Checks', 0, 1, 4),
        job('Test', 0, 1, 9),
        job('E2E (F3) (1)', 0, 1, 10),
        job('E2E (F3) (2)', 0, 1.5, 11),
        job('E2E (F3) (3)', 0, 2, 12),
        job('E2E (F3) (4)', 0, 2, 13),
      ]);
      // The round runs from the first start, minute 1, to the last stop, minute 13: twelve minutes.
      const lanes = jobsOf(html);
      expect(lanes.map(({ left, width }) => [left, width])).toEqual([
        [0, share(3, 12)],
        [0, share(8, 12)],
        [0, share(9, 12)],
        [share(0.5, 12), share(9.5, 12)],
        [share(1, 12), share(10, 12)],
        [share(1, 12), share(11, 12)],
      ]);
      // Everything overlaps in time, so no two share a row.
      expect(new Set(lanes.map((lane) => lane.top)).size).toBe(6);
      expect(lanes.map((lane) => lane.title.split(' · ').slice(0, 2).join(' · '))).toContain('E2E (F3) (3) · shard 3 of E2E (F3)');
    });

    it('draws the wait for a runner as a lead before the lane, which starts at the job’s own start', () => {
      const html = strip([job('Checks', 0, 0, 5), job('Test', 1, 3, 9)]);
      const [lead] = lanesIn(html).filter((lane) => lane.kind === 'lead');
      const test = jobsOf(html).find((lane) => lane.title.startsWith('Test'));
      expect(lead).toMatchObject({ left: share(1, 9), width: share(2, 9) });
      expect(test).toMatchObject({ left: share(3, 9), width: share(6, 9) });
      expect(test.title).toContain('waited 2m 00s for a runner');
      expect(test.title).toContain('started 11:03:00, stopped 11:09:00');
    });

    it('starts the lane of a job created when another finished where that one ended, in the same row', () => {
      const html = strip([job('Test', 0, 0, 5), job('Publish', 5, 5, 8)]);
      const [test, publish] = jobsOf(html);
      expect(publish.left).toBeCloseTo(test.left + test.width, 3);
      expect(publish.top).toBe(test.top);
    });

    it('draws a round of one job as one lane on the strip’s line, over the whole round', () => {
      const lanes = jobsOf(strip([job('Test', 0, 2, 12)]));
      expect(lanes).toHaveLength(1);
      expect(lanes[0]).toMatchObject({ left: 0, width: 100, top: 0 });
    });

    it('draws no lane for a job that was skipped', () => {
      const lanes = jobsOf(strip([job('Test', 0, 2, 12), job('Publish', 2, 2, 2, 'skipped')]));
      expect(lanes.map((lane) => lane.title.split(' · ')[0])).toEqual(['Test']);
    });

    it('draws a re-run of a job as its own lane after the first, marked as a re-run, and ringed the failed one', () => {
      const lanes = jobsOf(strip([job('Test', 0, 0, 5, 'failure'), job('Test', 6, 6, 12)]));
      expect(lanes).toHaveLength(2);
      expect(lanes[0].flags).toEqual(['failed']);
      expect(lanes[1].flags).toEqual(['rerun']);
      expect(lanes[1].left).toBeGreaterThan(lanes[0].left + lanes[0].width - 0.001);
      expect(lanes[1].title).toContain('re-run (attempt 2)');
    });

    it('draws a round whose job list could not be read as today’s block, and says its lanes are not recorded', () => {
      const html = strip([check('Test', 2, 12, 'success', { queue: { state: 'not-recorded', why: 'unreadable' } }), job('Checks', 0, 2, 5)]);
      expect(lanesIn(html)).toEqual([]);
      expect(html).toContain('class="piece checks"');
      expect(html).toContain('lanes not recorded');
    });
  });

  describe('every date and time the page shows is Belgian time in Belgian format', () => {
    /** A pull request written entirely in ISO UTC times, so a situation can name the moments the way a model file holds them. */
    const moments = ({ created, merged, started = created, stopped = merged, pushed = created, number = 1 }) =>
      pull({
        number,
        createdAt: created,
        mergedAt: merged,
        commits: [
          {
            sha: `c${number}`,
            authoredAt: pushed,
            parents: 1,
            checks: [{ id: 900 + number, name: 'Test', suiteId: 1, status: 'completed', conclusion: 'success', startedAt: started, completedAt: stopped, queue: { state: 'read', createdAt: started, startedAt: started } }],
          },
        ],
      });
    const renderAt = ({ now, since, pulls }) => renderHtml(buildModel({ pulls, now: new Date(now), requestedDays: 14, coveredSince: new Date(since), repo: 'o/r' }));
    const aPull = moments({ created: '2026-10-22T13:00:00Z', merged: '2026-10-22T13:20:00Z' });

    it('reads when it was generated in Belgian time', () => {
      expect(renderAt({ now: '2026-10-22T13:05:00Z', since: '2026-10-08T13:05:00Z', pulls: [aPull] })).toContain('generated <b>22 Oct 2026, 15:05</b>');
    });

    it('reads when a pull request merged, and when a round was pushed, on the Belgian day', () => {
      const late = moments({ created: '2026-10-21T22:00:00Z', merged: '2026-10-21T22:30:00Z' });
      const row = rowOf(renderAt({ now: '2026-10-22T13:05:00Z', since: '2026-10-08T13:05:00Z', pulls: [late] }), 1);
      expect(row).toContain('merged 22 Oct 2026, 00:30');
      expect(row).toContain('pushed 22 Oct 2026, 00:00');
      expect(row).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    });

    it('reads when a job started and stopped to the second in Belgian time', () => {
      const html = renderAt({ now: '2026-10-22T13:30:00Z', since: '2026-10-08T13:30:00Z', pulls: [moments({ created: '2026-10-22T13:00:00Z', merged: '2026-10-22T13:20:00Z', started: '2026-10-22T13:05:09Z', stopped: '2026-10-22T13:15:30Z' })] });
      expect(html).toContain('started 15:05:09, stopped 15:15:30');
      expect(html).not.toContain('13:05:09');
    });

    it('says the period it covers from the Belgian day each end falls on', () => {
      const html = renderAt({ now: '2026-10-21T22:30:00Z', since: '2026-10-08T22:30:00Z', pulls: [aPull] });
      expect(html).toContain('From 9 Oct 2026 to 22 Oct 2026.');
    });
  });

  describe("the evolution chart's day ticks fall on Belgian midnight", () => {
    const sectionOf = (html) => html.split('<h2>Evolution</h2>')[1].split('<h2>')[0];
    const minute = (iso) => (Date.parse(iso) - BASE) / MIN;
    /** A chart over merges at `from` and `to`, and the day ticks it draws: [x, label]. */
    const ticksBetween = (from, to) => {
      const pulls = [from, to].map((merged, index) => pull({ number: index + 1, mergedAt: at(minute(merged)), commits: [commit(`c${index}`, minute(merged) - 30, [check('Test', minute(merged) - 28, minute(merged) - 20)])] }));
      const html = render({ pulls, now: new Date(Date.parse(to) + 60 * MIN), requestedDays: 14 });
      const ticks = [...sectionOf(html).matchAll(/<text class="etick" x="(-?[\d.]+)"[^>]*text-anchor="middle">([^<]*)</g)].map((match) => [Number(match[1]), match[2]]);
      // Every panel draws the same axis, so the chart's ticks are the run up to the first label's second appearance.
      const perPanel = ticks.findIndex(([, label], index) => index > 0 && label === ticks[0][1]);
      const x = (instant) => 52 + ((Date.parse(instant) - Date.parse(from)) / (Date.parse(to) - Date.parse(from))) * (900 - 52 - 12);
      return { ticks: ticks.slice(0, perPanel), x };
    };

    it('puts the tick for 22 Oct at Belgian midnight, 22:00 UTC the evening before', () => {
      const { ticks, x } = ticksBetween('2026-10-21T12:00:00Z', '2026-10-23T12:00:00Z');
      expect(ticks.map(([, label]) => label)).toEqual(['22 Oct', '23 Oct']);
      expect(ticks[0][0]).toBeCloseTo(x('2026-10-21T22:00:00Z'), 0);
      expect(ticks[1][0]).toBeCloseTo(x('2026-10-22T22:00:00Z'), 0);
    });

    it('puts the tick for 26 Oct at 23:00 UTC, 25 hours after the one before, across the change of clock', () => {
      const { ticks, x } = ticksBetween('2026-10-24T12:00:00Z', '2026-10-27T12:00:00Z');
      expect(ticks.map(([, label]) => label)).toEqual(['25 Oct', '26 Oct', '27 Oct']);
      expect(ticks[0][0]).toBeCloseTo(x('2026-10-24T22:00:00Z'), 0);
      expect(ticks[1][0]).toBeCloseTo(x('2026-10-25T23:00:00Z'), 0);
      expect(ticks[2][0]).toBeCloseTo(x('2026-10-26T23:00:00Z'), 0);
      expect((ticks[1][0] - ticks[0][0]) / (ticks[2][0] - ticks[1][0])).toBeCloseTo(25 / 24, 1);
    });
  });

  describe("a zoomed strip's clock ticks are round Belgian times", () => {
    /** The labels on the axis of a pull request whose one round ran from `from` to `to`, in order. */
    const labelsOf = (from, to) => {
      const only = pull({
        createdAt: from,
        mergedAt: to,
        commits: [{ sha: 'a', authoredAt: from, parents: 1, checks: [{ id: 1, name: 'Test', suiteId: 1, status: 'completed', conclusion: 'success', startedAt: from, completedAt: to }] }],
      });
      const html = renderHtml(buildModel({ pulls: [only], now: new Date(to), requestedDays: 14, coveredSince: new Date(Date.parse(to) - 14 * DAY_MS), repo: 'o/r' }));
      return [...zoomedOf(html, 1).matchAll(/<span class="clocktick (\w+)" style="[^"]*">([^<]*)</g)].map((match) => match[2]);
    };

    it('labels the hours of a strip in Belgian time, not Greenwich', () => {
      const labels = labelsOf('2026-10-22T13:05:00Z', '2026-10-22T19:40:00Z');
      expect(labels).toEqual(['15:05', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00', '21:40']);
    });

    it('shows its day beside the time on a tick past Belgian midnight, and not before it', () => {
      const labels = labelsOf('2026-10-22T13:05:00Z', '2026-10-23T13:05:00Z');
      expect(labels).toContain('21:00');
      expect(labels).toContain('23 Oct 00:00');
      expect(labels).toContain('23 Oct 03:00');
      expect(labels.filter((label) => label.startsWith('22 Oct'))).toEqual([]);
    });
  });
});
