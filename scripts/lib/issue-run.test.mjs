import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NOT_RECORDED, RunRefused, buildRun, partOf, readRunInputs, showTotal, showDuration } from './issue-run.mjs';
import { BLOCK_END, BLOCK_START } from './session-record.mjs';

const record = (...lines) => `body\n\n${BLOCK_START}\n### Session record\n\n${lines.map((l) => `- ${l}`).join('\n')}\n${BLOCK_END}`;

/** A pull request as `gh pr list` returns it. */
const pr = (number, over = {}) => ({
  number,
  headRefName: `branch-${number}`,
  baseRefName: 'main',
  state: 'MERGED',
  createdAt: '2026-10-18T09:00:00Z',
  mergedAt: '2026-10-18T12:00:00Z',
  closedAt: '2026-10-18T12:00:00Z',
  body: '',
  closingIssuesReferences: [],
  ...over,
});

const FULL = record(
  '2026-10-18T10:00:00.000Z start',
  '2026-10-18T10:10:00.000Z scoped',
  '2026-10-18T10:50:00.000Z built',
  '2026-10-18T11:00:00.000Z review-start code-review high',
  '2026-10-18T11:10:00.000Z review-end code-review high:5',
  '2026-10-18T11:10:01.000Z review-outcome code-review high:3/2',
  '2026-10-18T11:30:00.000Z pushed',
  '2026-10-18T11:31:00.000Z ci-start',
  '2026-10-18T11:41:00.000Z ci-end failure',
  '2026-10-18T11:45:00.000Z ci-start',
  '2026-10-18T11:55:00.000Z ci-end success',
);

const cost = (costUSD) => ({ costUSD, unpricedTokens: 0 });

describe('A run for an issue', () => {
  describe('B1: a row per pull request of the children and of the issue itself', () => {
    it('gives a parent with two merged children and a final pull request three rows and a total', () => {
      const run = buildRun({
        issue: { number: 10, title: 'Parent' },
        subIssues: [12, 11],
        pullRequests: [
          pr(101, { closingIssuesReferences: [{ number: 11 }], baseRefName: 'feature/x' }),
          pr(102, { body: 'Part of #12', baseRefName: 'feature/x' }),
          pr(103, { body: 'Part of #10' }),
        ],
        costByBranch: new Map(),
      });
      assert.deepEqual(run.rows.map((row) => [row.issue, row.pullRequest.number]), [[11, 101], [12, 102], [10, 103]]);
      assert.equal(run.total.costUSD.missingRows, 3);
    });

    it('gives a plain issue closed by one pull request one row', () => {
      const run = buildRun({
        issue: { number: 20, title: 'Plain' },
        subIssues: [],
        pullRequests: [pr(201, { closingIssuesReferences: [{ number: 20 }] }), pr(202, { closingIssuesReferences: [{ number: 99 }] })],
        costByBranch: new Map([['branch-201', cost(1.5)]]),
      });
      assert.equal(run.rows.length, 1);
      assert.deepEqual(run.total.costUSD, { value: 1.5, missingRows: 0 });
    });

    it('finds a child whose pull request names it only by Part of', () => {
      assert.equal(partOf('Closes nothing.\n\nPart of #1258 and more'), 1258);
      const run = buildRun({ issue: { number: 10, title: '' }, subIssues: [11], pullRequests: [pr(5, { body: 'Part of #11' })], costByBranch: new Map() });
      assert.equal(run.rows[0].pullRequest.number, 5);
    });

    it('names a child with no pull request yet and gives it no figures', () => {
      const run = buildRun({ issue: { number: 10, title: '' }, subIssues: [11], pullRequests: [], costByBranch: new Map() });
      assert.equal(run.rows.length, 1);
      assert.equal(run.rows[0].issue, 11);
      assert.equal(run.rows[0].pullRequest, null);
      assert.equal(run.rows[0].figures.costUSD, null);
      assert.equal(run.rows[0].codingMs, null);
    });
  });

  describe('B2: each row carries the times, reviews, CI and cost of its pull request', () => {
    const rowOf = (body, costs = new Map()) =>
      buildRun({ issue: { number: 1, title: '' }, subIssues: [], pullRequests: [pr(7, { closingIssuesReferences: [{ number: 1 }], body })], costByBranch: costs }).rows[0];

    it('gives a review its time and its reported, fixed and declined', () => {
      const row = rowOf(FULL, new Map([['branch-7', cost(2.25)]]));
      assert.equal(row.startedAt, '2026-10-18T10:00:00.000Z');
      assert.equal(row.endedAt, '2026-10-18T12:00:00Z');
      assert.deepEqual(row.reviews.map(({ kind, level, ms, reported, fixed, declined }) => ({ kind, level, ms, reported, fixed, declined })), [
        { kind: 'code-review', level: 'high', ms: 10 * 60000, reported: 5, fixed: 3, declined: 2 },
      ]);
      assert.equal(row.codingMs, (80 - 10) * 60000);
      assert.equal(row.figures.costUSD, 2.25);
    });

    it('keeps two rounds of one review apart, each with its own counts', () => {
      const body = record(
        '2026-10-18T10:00:00.000Z start',
        '2026-10-18T10:10:00.000Z review-start code-review high',
        '2026-10-18T10:20:00.000Z review-end code-review high:4',
        '2026-10-18T10:20:01.000Z review-outcome code-review high:1/3',
        '2026-10-18T10:40:00.000Z review-start code-review medium',
        '2026-10-18T10:45:00.000Z review-end code-review medium:2',
        '2026-10-18T10:45:01.000Z review-outcome code-review medium:2/0',
      );
      const { reviews, figures } = rowOf(body);
      assert.deepEqual(reviews.map((r) => [r.level, r.reported, r.fixed, r.declined]), [['high', 4, 1, 3], ['medium', 2, 2, 0]]);
      assert.deepEqual([figures.reported, figures.fixed, figures.declined], [6, 3, 3]);
    });

    it('reads a review with no outcome mark as time and reported, with fixed and declined not recorded', () => {
      const body = record('2026-10-18T10:10:00.000Z review-start code-review high', '2026-10-18T10:20:00.000Z review-end code-review high:4');
      const { reviews, figures } = rowOf(body);
      assert.deepEqual([reviews[0].ms, reviews[0].reported, reviews[0].fixed, reviews[0].declined], [10 * 60000, 4, null, null]);
      assert.deepEqual([figures.reported, figures.fixed, figures.declined], [4, null, null]);
    });

    it('gives each CI wait its time and outcome', () => {
      assert.deepEqual(rowOf(FULL).ci, [{ ms: 10 * 60000, outcome: 'failure' }, { ms: 10 * 60000, outcome: 'success' }]);
    });

    it('reads a CI start with no end as a wait with no end recorded', () => {
      const body = record('2026-10-18T10:00:00.000Z ci-start', '2026-10-18T10:10:00.000Z ci-start', '2026-10-18T10:20:00.000Z ci-end success');
      const row = rowOf(body);
      assert.deepEqual(row.ci, [{ ms: null, outcome: null }, { ms: 10 * 60000, outcome: 'success' }]);
      assert.equal(row.figures.ciMs, null);
    });

    it('reads a pull request with no session record as not recorded, never zero', () => {
      const row = rowOf('no record here');
      assert.equal(row.reviews, null);
      assert.equal(row.ci, null);
      assert.equal(row.codingMs, null);
      assert.equal(row.startedAt, null);
      assert.equal(row.figures.costUSD, null);
    });
  });

  describe('B3: the total adds up what every row recorded and says where a row left something out', () => {
    const two = (secondBody) =>
      buildRun({
        issue: { number: 10, title: '' },
        subIssues: [11, 12],
        pullRequests: [pr(1, { body: `Part of #11\n${FULL}` }), pr(2, { body: `Part of #12\n${secondBody}` })],
        costByBranch: new Map([['branch-1', cost(1)], ['branch-2', cost(2)]]),
      });

    it('sums each figure when every row is complete', () => {
      const { total } = two(FULL);
      assert.deepEqual(total.fixed, { value: 6, missingRows: 0 });
      assert.deepEqual(total.reported, { value: 10, missingRows: 0 });
      assert.deepEqual(total.costUSD, { value: 3, missingRows: 0 });
    });

    it('marks the total as missing a row, not short, when one row has no fixed recorded', () => {
      const withoutOutcome = FULL.replace(/- \S+ review-outcome.*\n/, '');
      const { total } = two(withoutOutcome);
      assert.deepEqual(total.fixed, { value: 3, missingRows: 1 });
      assert.equal(showTotal(total.fixed, String), `3 (missing 1 row: ${NOT_RECORDED})`);
      assert.equal(showTotal(total.reported, String), '10');
    });

    it('shows no duration as not recorded', () => {
      assert.equal(showDuration(null), NOT_RECORDED);
      assert.equal(showDuration(65 * 60000), '1h5m');
    });
  });

  describe('B4: an issue the command cannot read is refused in words', () => {
    const ok = { readIssue: (n) => ({ number: n, title: 't' }), readSubIssues: () => [], listPullRequests: () => [] };

    it('refuses a number with no issue, naming it', () => {
      assert.throws(() => readRunInputs(999, { ...ok, readIssue: () => null }), (error) => error instanceof RunRefused && /no issue #999/.test(error.message));
    });

    it('refuses when gh fails reading sub-issues, saying so', () => {
      const failing = { ...ok, readSubIssues: () => { throw new Error('gh: exit 1'); } };
      assert.throws(() => readRunInputs(5, failing), (error) => error instanceof RunRefused && /could not read the sub-issues of #5/.test(error.message));
    });

    it('hands back what it read when all of it is readable', () => {
      assert.deepEqual(readRunInputs(5, ok), { issue: { number: 5, title: 't' }, subIssues: [], pullRequests: [] });
    });
  });
});
