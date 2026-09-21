import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BLOCK_END,
  BLOCK_START,
  PHASES,
  applyBlock,
  markPhase,
  parseRecord,
  recordFileName,
  readBlock,
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
