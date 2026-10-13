import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLOCK_END,
  BLOCK_START,
  PHASES,
  applyBlock,
  markPhase,
  mergeRuns,
  parseRecord,
  recordFileName,
  readBlock,
  readRuns,
  renderBlock,
  serialiseRecord,
} from './session-record.mjs';

const at = (iso) => () => new Date(iso);

describe("a session's phases are written down as they happen", () => {
  it('records a phase with the time it was marked, from the clock', () => {
    const [entry] = markPhase([], ['start'], at('2026-09-21T10:00:00.000Z'));
    assert.deepEqual(entry, { phase: 'start', at: '2026-09-21T10:00:00.000Z' });
  });

  it('reads the real clock when no other is given', () => {
    const before = Date.now();
    const [entry] = markPhase([], ['built']);
    assert.ok(Date.parse(entry.at) >= before && Date.parse(entry.at) <= Date.now());
  });

  it('refuses a time passed in, since the time comes from the clock', () => {
    assert.throws(() => markPhase([], ['start', '2020-01-01T00:00:00Z']), /takes nothing after it/);
    assert.throws(() => markPhase([], ['review-start', 'code-review', 'high', '2020-01-01T00:00:00Z']), /the time comes from the clock/);
  });

  it('keeps both entries, in order, where the same phase is marked twice', () => {
    let entries = markPhase([], ['review-start', 'code-review', 'high'], at('2026-09-21T10:00:00.000Z'));
    entries = markPhase(entries, ['review-start', 'code-review', 'high'], at('2026-09-21T10:30:00.000Z'));
    assert.deepEqual(
      entries.map((entry) => entry.at),
      ['2026-09-21T10:00:00.000Z', '2026-09-21T10:30:00.000Z'],
    );
  });

  it('carries a review’s kind and level on both of its boundaries', () => {
    const entries = markPhase(markPhase([], ['review-start', 'security-review', 'xhigh']), ['review-end', 'security-review', 'xhigh']);
    assert.deepEqual(entries.map(({ phase, kind, level }) => [phase, kind, level]), [
      ['review-start', 'security-review', 'xhigh'],
      ['review-end', 'security-review', 'xhigh'],
    ]);
  });

  it('refuses a phase it does not know, naming the ones it does', () => {
    assert.throws(() => markPhase([], ['shipped']), (error) => PHASES.every((phase) => error.message.includes(phase)) && /shipped/.test(error.message));
    assert.throws(() => markPhase([], []), /No phase given/);
  });

  it('refuses a review with no kind or level, or one it does not know', () => {
    assert.throws(() => markPhase([], ['review-start']), /kind/);
    assert.throws(() => markPhase([], ['review-end', 'code-review']), /level/);
    assert.throws(() => markPhase([], ['review-end', 'code-review', 'ultra']), /level/);
  });

  it('produces no block where nothing has been marked', () => {
    assert.equal(renderBlock([]), null);
  });

  it('round-trips through the file it is kept in', () => {
    const entries = markPhase(markPhase([], ['start'], at('2026-09-21T10:00:00.000Z')), ['pushed'], at('2026-09-21T11:00:00.000Z'));
    assert.deepEqual(parseRecord(serialiseRecord(entries)), entries);
    assert.deepEqual(parseRecord(''), []);
  });
});

describe('each branch keeps its own record', () => {
  it('keeps a second branch in the same worktree apart from the first', () => {
    assert.notEqual(recordFileName('claude/issue-1-aaa'), recordFileName('claude/issue-2-bbb'));
    assert.match(recordFileName('claude/issue-1-aaa'), /^[\w.-]+$/);
  });
});

describe('the pull request body keeps its record however often it is rewritten', () => {
  const entries = markPhase(
    markPhase(markPhase([], ['start'], at('2026-09-21T10:00:00.000Z')), ['review-start', 'code-review', 'high'], at('2026-09-21T10:40:00.000Z')),
    ['pushed'],
    at('2026-09-21T10:59:00.000Z'),
  );
  const block = renderBlock(entries);

  it('adds the block after the existing text where the body has none', () => {
    const body = applyBlock('## Summary\n\nDid a thing.\n', block);
    assert.ok(body.startsWith('## Summary\n\nDid a thing.\n\n'));
    assert.ok(body.endsWith(`${BLOCK_END}\n`));
    assert.equal(body.split(BLOCK_START).length, 2);
  });

  it('is only the block where the body is empty', () => {
    assert.equal(applyBlock('', block), `${block}\n`);
  });

  it('replaces a block in place and leaves the text around it untouched', () => {
    const before = 'Before.\n\n';
    const after = '\n\n## Walk\n\n1. Open it.\n';
    const stale = applyBlock('', renderBlock(markPhase([], ['start'], at('2026-01-01T00:00:00.000Z')))).trimEnd();
    const body = applyBlock(`${before}${stale}${after}`, block);
    assert.equal(body, `${before}${block}${after}`);
  });

  it('keeps a body’s own line endings around the block it adds', () => {
    const body = applyBlock('Text.\r\n', block);
    assert.ok(!/[^\r]\n/.test(body), 'every newline is a CRLF');
    assert.deepEqual(readBlock(body), entries);
  });

  it('refuses a body with only one of the two markers, saying why', () => {
    assert.throws(() => applyBlock(`text\n${BLOCK_START}\nstale`, block), (error) => error.message.includes(BLOCK_END) && /no telling what to replace/.test(error.message));
    assert.throws(() => applyBlock(`text\n${BLOCK_END}\n`, block), (error) => error.message.includes(BLOCK_START) && /no telling what to replace/.test(error.message));
  });

  it('refuses markers that are doubled or out of order, rather than guessing', () => {
    assert.throws(() => applyBlock(`${block}\n\n${block}`, block), /one of each/);
    assert.throws(() => applyBlock(`${BLOCK_END}\n${BLOCK_START}`, block), /before/);
  });

  it('is unchanged by a second pass', () => {
    const once = applyBlock('## Summary\n\nDid a thing.\n', block);
    assert.equal(applyBlock(once, block), once);
    assert.equal(applyBlock(once.replace('Did a thing.', 'Did it.'), block), once.replace('Did a thing.', 'Did it.'));
  });

  it('leaves a body alone where there is nothing to place, even one that has a block', () => {
    const body = applyBlock('Text.\n', block);
    assert.equal(applyBlock(body, null), body);
    assert.equal(applyBlock('Text.\n', null), 'Text.\n');
  });

  it('reads back what it wrote, and reads nothing from a body with no block', () => {
    assert.deepEqual(readBlock(applyBlock('Text.\n', block)), entries);
    assert.deepEqual(readBlock('Text.\n'), []);
  });
});

const run = (scopes, start, end) => ({ run: 'test', scopes, start: `2026-09-21T${start}.000Z`, end: `2026-09-21T${end}.000Z` });

describe('the browser pass is marked like a review', () => {
  it('keeps browser-start and browser-end, stamped by the clock', () => {
    const entries = markPhase(markPhase([], ['browser-start'], at('2026-09-21T10:00:00.000Z')), ['browser-end'], at('2026-09-21T10:12:00.000Z'));
    assert.deepEqual(entries, [
      { phase: 'browser-start', at: '2026-09-21T10:00:00.000Z' },
      { phase: 'browser-end', at: '2026-09-21T10:12:00.000Z' },
    ]);
    assert.deepEqual(readBlock(applyBlock('', renderBlock(entries))), entries);
  });

  it('refuses a word after either, as a time-shaped word is refused', () => {
    for (const phase of ['browser-start', 'browser-end']) {
      assert.throws(() => markPhase([], [phase, '2020-01-01T00:00:00Z']), /takes nothing after it/);
      assert.throws(() => markPhase([], [phase, 'code-review']), /the time comes from the clock/);
    }
  });
});

describe('local test runs are one interval where they overlap', () => {
  const cases = [
    {
      situation: "a workspace run's packages in parallel",
      runs: [run(['@cockpit/api'], '10:00:00', '10:03:00'), run(['@cockpit/web'], '10:00:05', '10:01:00'), run(['@cockpit/shared'], '10:00:10', '10:00:30')],
      expected: [run(['@cockpit/api', '@cockpit/shared', '@cockpit/web'], '10:00:00', '10:03:00')],
    },
    {
      situation: 'two runs one after the other, not touching',
      runs: [run(['@cockpit/api'], '10:00:00', '10:01:00'), run(['@cockpit/web'], '10:05:00', '10:06:00')],
      expected: [run(['@cockpit/api'], '10:00:00', '10:01:00'), run(['@cockpit/web'], '10:05:00', '10:06:00')],
    },
    {
      situation: 'the same suite run twice in a row',
      runs: [run(['@cockpit/api'], '10:05:00', '10:06:00'), run(['@cockpit/api'], '10:00:00', '10:01:00')],
      expected: [run(['@cockpit/api'], '10:00:00', '10:01:00'), run(['@cockpit/api'], '10:05:00', '10:06:00')],
    },
  ];
  for (const { situation, runs, expected } of cases) {
    it(situation, () => assert.deepEqual(mergeRuns(runs), expected));
  }
});

describe('the block keeps to its budget without dropping a run', () => {
  const runs = Array.from({ length: 40 }, (_, i) => run([`@cockpit/package-${i % 4}`], `10:${String(i).padStart(2, '0')}:00`, `10:${String(i).padStart(2, '0')}:30`));
  const marks = markPhase([], ['start'], at('2026-09-21T09:00:00.000Z'));

  it('carries every run as recorded where it is under budget', () => {
    const block = renderBlock([...marks, ...runs]);
    assert.ok(block.length < 16_000);
    assert.equal(readRuns(applyBlock('', block)).length, 40);
    assert.deepEqual(readRuns(applyBlock('', block)).map(({ start, end }) => [start, end]), runs.map(({ start, end }) => [start, end]));
  });

  it('merges the runs closest together until it is under, keeping the earliest start and the latest end', () => {
    const budget = 1_200;
    const full = renderBlock([...marks, ...runs]);
    assert.ok(full.length > budget);
    const block = renderBlock([...marks, ...runs], budget);
    assert.ok(block.length <= budget);
    const kept = readRuns(applyBlock('', block));
    assert.ok(kept.length >= 1 && kept.length < 40);
    assert.equal(kept[0].start, runs[0].start);
    assert.equal(kept.at(-1).end, runs.at(-1).end);
    assert.deepEqual([...new Set(kept.flatMap((r) => r.scopes))].sort(), ['@cockpit/package-0', '@cockpit/package-1', '@cockpit/package-2', '@cockpit/package-3']);
  });

  it('merges the pair with the smallest gap first', () => {
    const near = [run(['a'], '10:00:00', '10:00:10'), run(['b'], '10:10:00', '10:10:10'), run(['c'], '10:10:20', '10:10:30')];
    const block = renderBlock(near, renderBlock(near).length - 1);
    assert.deepEqual(readRuns(block).map(({ scopes }) => scopes), [['a'], ['b', 'c']]);
  });

  it('reads no block from an empty record, as today', () => {
    assert.equal(renderBlock([]), null);
  });
});

describe('bodies already written read as they do', () => {
  const reviews = markPhase(markPhase(markPhase([], ['start'], at('2026-09-21T10:00:00.000Z')), ['review-start', 'code-review', 'high'], at('2026-09-21T10:20:00.000Z')), ['review-end', 'code-review', 'high'], at('2026-09-21T10:30:00.000Z'));

  it('reads the same marks from a block with test runs in it as from one without', () => {
    const withRuns = renderBlock([...reviews, run(['@cockpit/api'], '10:05:00', '10:08:00'), run(['E2E'], '10:22:00', '10:25:00')]);
    assert.deepEqual(readBlock(applyBlock('Text.\n', withRuns)), reviews);
    assert.deepEqual(readBlock(applyBlock('Text.\n', renderBlock(reviews))), reviews);
    assert.equal(readRuns(applyBlock('Text.\n', withRuns)).length, 2);
  });

  it('reads a body written before test runs existed unchanged', () => {
    const old = `Text.\n\n${BLOCK_START}\n### Session record\n\n- 2026-09-21T10:00:00.000Z start\n- 2026-09-21T10:20:00.000Z review-start code-review high\n${BLOCK_END}\n`;
    assert.deepEqual(readBlock(old), [
      { at: '2026-09-21T10:00:00.000Z', phase: 'start' },
      { at: '2026-09-21T10:20:00.000Z', phase: 'review-start', kind: 'code-review', level: 'high' },
    ]);
    assert.deepEqual(readRuns(old), []);
    assert.equal(applyBlock(old, renderBlock(readBlock(old))), old);
  });

  it('names a line it cannot read and skips it, keeping the rest', () => {
    const text = `${serialiseRecord(reviews.slice(0, 1))}{"phase":"built","at":"2026-09\n${serialiseRecord([run(['@cockpit/api'], '10:00:00', '10:01:00')])}{"run":"test","scopes":[],"start":"x","end":"y"}\n${serialiseRecord(reviews.slice(1, 2))}`;
    const unreadable = [];
    const entries = parseRecord(text, (line) => unreadable.push(line));
    assert.equal(entries.length, 3);
    assert.equal(unreadable.length, 2);
    assert.ok(unreadable[0].startsWith('{"phase":"built"'));
    assert.ok(renderBlock(entries) !== null);
  });
});

describe('a review’s end can carry how many findings it reported', () => {
  const end = (...words) => markPhase([], ['review-end', ...words], at('2026-09-21T10:30:00.000Z'))[0];

  it('records the count given after the level', () => {
    assert.deepEqual(end('code-review', 'high', '3'), { phase: 'review-end', kind: 'code-review', level: 'high', count: 3, at: '2026-09-21T10:30:00.000Z' });
    assert.equal(end('code-review', 'high', '0').count, 0);
  });

  it('records a review end without a count as before, its count unknown', () => {
    assert.equal('count' in end('code-review', 'high'), false);
  });

  it('refuses a count that is not a whole number of 0 or more', () => {
    for (const bad of ['-1', '1.5', 'three', '03', '']) assert.throws(() => end('code-review', 'high', bad), /whole number/, bad);
    assert.throws(() => end('code-review', 'high', '3', '4'), /takes only a kind and a level and a finding count/);
    assert.throws(() => markPhase([], ['review-start', 'code-review', 'high', '3']), /takes only a kind and a level/);
  });

  it('keeps the count on the block’s line and reads it back', () => {
    const entries = [end('code-review', 'high', '3'), end('security-review', 'high')];
    const block = renderBlock(entries);
    assert.match(block, /review-end code-review high:3\n/);
    assert.match(block, /review-end security-review high\n/);
    assert.deepEqual(readBlock(applyBlock('', block)), entries);
  });

  it('leaves a reader that knows four words a line seeing the same phase, kind and level word', () => {
    const block = renderBlock([end('code-review', 'high', '3')]);
    const found = /^- (\S+) (\S+)(?: (\S+) (\S+))?$/.exec(block.split(/\r?\n/).find((l) => l.includes('review-end')));
    assert.deepEqual([found[2], found[3], found[4].split(':')[0]], ['review-end', 'code-review', 'high']);
  });
});
