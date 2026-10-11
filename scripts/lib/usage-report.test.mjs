import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { allRequests, categoryOf, parseLog, requestsFromLog, sendUnsent, toRow, whereItRan } from './usage-report.mjs';

const usage = { input_tokens: 3, output_tokens: 5, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 };

const reply = (requestId, timestamp, over = {}) =>
  JSON.stringify({
    type: 'assistant',
    requestId,
    timestamp,
    gitBranch: 'claude/build-1',
    message: { model: 'claude-sonnet-5-5', usage, content: [{ type: 'text', text: 'SECRET words from the conversation' }] },
    ...over,
  });

const main = (text) => requestsFromLog(parseLog(text), { sessionId: 's1', subagent: false });

describe('Each request in a session is reported once', () => {
  it('a reply written as several log lines sharing one request id gives one request', () => {
    const requests = main([reply('req_1', '2026-10-01T10:00:00Z'), reply('req_1', '2026-10-01T10:00:01Z'), reply('req_1', '2026-10-01T10:00:02Z')].join('\n'));
    assert.equal(requests.length, 1);
    assert.deepEqual(
      [requests[0].inputTokens, requests[0].outputTokens, requests[0].cacheCreationTokens, requests[0].cacheReadTokens],
      [3, 5, 7, 11],
    );
  });

  it("a subagent's requests are reported, marked as a subagent's", () => {
    const [request] = requestsFromLog(parseLog(reply('req_9', '2026-10-01T10:00:00Z')), { sessionId: 's1', subagent: true });
    assert.equal(request.subagent, true);
    assert.equal(request.sessionId, 's1');
  });

  it('a resumed session repeating earlier requests gives the same request ids', () => {
    const first = main(reply('req_1', '2026-10-01T10:00:00Z'));
    const resumed = main([reply('req_1', '2026-10-01T10:00:00Z'), reply('req_2', '2026-10-01T10:05:00Z')].join('\n'));
    assert.equal(resumed[0].requestId, first[0].requestId);
    assert.deepEqual(resumed.map((r) => r.requestId), ['req_1', 'req_2']);
  });

  it('a request seen in the main log and again in a subagent log counts once', () => {
    const logs = [
      { lines: parseLog(reply('req_1', '2026-10-01T10:00:00Z')), sessionId: 's1', subagent: false },
      { lines: parseLog(reply('req_1', '2026-10-01T10:00:00Z')), sessionId: 's1', subagent: true },
    ];
    assert.equal(allRequests(logs).length, 1);
  });

  it('an unreadable log line is skipped and the rest still reported', () => {
    const requests = main([reply('req_1', '2026-10-01T10:00:00Z'), '{"type":"assis', 'not json', reply('req_2', '2026-10-01T10:01:00Z')].join('\n'));
    assert.deepEqual(requests.map((r) => r.requestId), ['req_1', 'req_2']);
  });
});

const at = (iso) => Date.parse(iso);
const record = (...marks) => marks.map(([time, phase, kind, level]) => ({ at: time, phase, ...(kind ? { kind, level } : {}) }));
const request = (iso, over = {}) => ({ requestId: 'r', sessionId: 's', at: at(iso), branch: 'claude/build-1', securityReview: false, ...over });
const category = (req, marks, ranWhere = 'local') => categoryOf(req, { ranWhere, marksOf: () => marks });

describe("A request's category is the phase its session was in when it was made", () => {
  const marks = record(
    ['2026-10-01T09:00:00Z', 'start'],
    ['2026-10-01T10:00:00Z', 'scoped'],
    ['2026-10-01T11:00:00Z', 'built'],
    ['2026-10-01T11:10:00Z', 'review-start', 'code-review', 'high'],
    ['2026-10-01T11:20:00Z', 'review-end', 'code-review', 'high'],
    ['2026-10-01T12:00:00Z', 'pushed'],
  );

  const cases = [
    ['on main', request('2026-10-01T09:30:00Z', { branch: 'main' }), marks, { category: 'scoping-planning' }],
    ['on a branch before scoped', request('2026-10-01T09:30:00Z'), marks, { category: 'scoping-planning' }],
    ['after scoped with no review open', request('2026-10-01T10:30:00Z'), marks, { category: 'building' }],
    ['a branch that never marked anything', request('2026-10-01T10:30:00Z'), [], { category: 'building' }],
    ['between a code review starting and ending', request('2026-10-01T11:15:00Z'), marks, { category: 'local-code-review', reviewLevel: 'high' }],
    ['inside the security review subagent', request('2026-10-01T10:30:00Z', { securityReview: true }), marks, { category: 'local-security-review' }],
    ['after pushed', request('2026-10-01T12:30:00Z'), marks, { category: 'after-push' }],
    ['a review recheck after pushed', request('2026-10-01T12:30:00Z'), [...marks, ...record(['2026-10-01T12:20:00Z', 'review-start', 'code-review', 'low'])], { category: 'after-push' }],
  ];
  for (const [situation, req, theMarks, expected] of cases) {
    it(`${situation}`, () => assert.deepEqual(category(req, theMarks), expected));
  }

  it('in GitHub Actions is a CI review, whatever the marks say', () => {
    assert.deepEqual(category(request('2026-10-01T10:30:00Z'), marks, 'actions'), { category: 'ci-reviews' });
    assert.deepEqual(category(request('2026-10-01T10:30:00Z', { branch: 'main' }), marks, 'actions'), { category: 'ci-reviews' });
  });

  it('a review window with no end stays a review until a later mark closes it', () => {
    const open = record(['2026-10-01T10:00:00Z', 'scoped'], ['2026-10-01T11:00:00Z', 'review-start', 'code-review', 'xhigh']);
    assert.deepEqual(category(request('2026-10-01T11:45:00Z'), open), { category: 'local-code-review', reviewLevel: 'xhigh' });
  });

  it('a branch switched mid-session gives each request its own branch marks', () => {
    const byBranch = { a: record(['2026-10-01T09:00:00Z', 'start'], ['2026-10-01T09:30:00Z', 'scoped']), b: record(['2026-10-01T09:00:00Z', 'start']) };
    const ctx = { ranWhere: 'local', marksOf: (branch) => byBranch[branch] };
    assert.equal(categoryOf(request('2026-10-01T10:00:00Z', { branch: 'a' }), ctx).category, 'building');
    assert.equal(categoryOf(request('2026-10-01T10:00:00Z', { branch: 'b' }), ctx).category, 'scoping-planning');
  });

  it('the security review subagent is recognised by its Skill call, not by a prompt that mentions the review', () => {
    const skillCall = reply('req_s', '2026-10-01T10:30:00Z', {
      message: { model: 'claude-sonnet-5-5', usage, content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'security-review' } }] },
    });
    const [req] = requestsFromLog(parseLog(skillCall), { sessionId: 's1', subagent: true });
    assert.equal(req.securityReview, true);
    const mention = JSON.stringify({ type: 'user', message: { content: 'Do not run /security-review; it is done separately' } });
    const [plain] = requestsFromLog(parseLog([mention, reply('req_t', '2026-10-01T10:30:00Z')].join('\n')), { sessionId: 's1', subagent: true });
    assert.equal(plain.securityReview, false);
    const [inMain] = requestsFromLog(parseLog(skillCall), { sessionId: 's1', subagent: false });
    assert.equal(inMain.securityReview, false);
  });
});

const row = (id) => ({ requestId: id });
const sentWith = (outcomes) => {
  const posted = [];
  return {
    posted,
    post: async (batch) => {
      posted.push(batch.map((r) => r.requestId));
      const outcome = outcomes.shift() ?? true;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
};

describe('Only what was not sent is sent, and a failed send is made up next turn', () => {
  it('the first turn sends every request so far', async () => {
    const { post, posted } = sentWith([]);
    const { sent } = await sendUnsent({ key: 'k', rows: [row('a'), row('b')], sentIds: [], post });
    assert.deepEqual(posted, [['a', 'b']]);
    assert.deepEqual([...sent].sort(), ['a', 'b']);
  });

  it('a later turn sends only the new requests', async () => {
    const { post, posted } = sentWith([]);
    await sendUnsent({ key: 'k', rows: [row('a'), row('b'), row('c')], sentIds: ['a', 'b'], post });
    assert.deepEqual(posted, [['c']]);
  });

  it('a failed send is sent again with the new requests next turn', async () => {
    const first = sentWith([false]);
    const { sent } = await sendUnsent({ key: 'k', rows: [row('a')], sentIds: [], post: first.post });
    assert.deepEqual([...sent], []);
    const second = sentWith([]);
    await sendUnsent({ key: 'k', rows: [row('a'), row('b')], sentIds: [...sent], post: second.post });
    assert.deepEqual(second.posted, [['a', 'b']]);
  });

  it('a send that succeeded but whose record was lost goes again, which the monitor ignores by request id', async () => {
    const { post, posted } = sentWith([]);
    await sendUnsent({ key: 'k', rows: [row('a')], sentIds: [], post });
    assert.deepEqual(posted, [['a']]);
  });

  it('more than one write holds is split, and a failure keeps the batches before it', async () => {
    const rows = Array.from({ length: 450 }, (_, i) => row(`r${i}`));
    const { post, posted } = sentWith([true, false]);
    const { sent } = await sendUnsent({ key: 'k', rows, sentIds: [], post });
    assert.deepEqual(posted.map((b) => b.length), [200, 200]);
    assert.equal(sent.size, 200);
  });
});

describe('One row the monitor refuses does not hold back the rest', () => {
  it('a refused batch is sent row by row, and the row still refused counts as sent', async () => {
    const { post, posted } = sentWith(['rejected', true, 'rejected', true]);
    const { sent } = await sendUnsent({ key: 'k', rows: [row('a'), row('b'), row('c')], sentIds: [], post });
    assert.deepEqual(posted, [['a', 'b', 'c'], ['a'], ['b'], ['c']]);
    assert.deepEqual([...sent].sort(), ['a', 'b', 'c']);
  });

  it('a failure while sending rows singly keeps the rest unsent', async () => {
    const { post } = sentWith(['rejected', true, false]);
    const { sent } = await sendUnsent({ key: 'k', rows: [row('a'), row('b'), row('c')], sentIds: [], post });
    assert.deepEqual([...sent], ['a']);
  });
});

describe('The hook never delays or breaks the session', () => {
  it('sends nothing without a write key', async () => {
    const { post, posted } = sentWith([]);
    const { sent } = await sendUnsent({ key: '', rows: [row('a')], sentIds: [], post });
    assert.deepEqual(posted, []);
    assert.equal(sent.size, 0);
  });

  it('an unreachable or too slow monitor ends quietly with the requests kept as unsent', async () => {
    for (const failure of [new TypeError('fetch failed'), new DOMException('timed out', 'TimeoutError')]) {
      const { post } = sentWith([failure]);
      const { sent } = await sendUnsent({ key: 'k', rows: [row('a')], sentIds: ['z'], post });
      assert.deepEqual([...sent], ['z']);
    }
  });
});

describe('Nothing from the conversation leaves the machine', () => {
  it('a row carries ids, times, branch, category, model and counts only', () => {
    const [req] = main(reply('req_1', '2026-10-01T10:00:00Z'));
    const sent = toRow(req, { ranWhere: 'local', marksOf: () => [] });
    assert.deepEqual(Object.keys(sent).sort(), [
      'branch', 'cacheCreationTokens', 'cacheReadTokens', 'category', 'inputTokens', 'model', 'outputTokens',
      'ranWhere', 'requestId', 'sessionId', 'source', 'speed', 'subagent', 'time',
    ]);
    assert.ok(!JSON.stringify(sent).includes('SECRET'));
  });
});

describe('Where a request ran is recorded', () => {
  it('inside GitHub Actions is Actions, inside a cloud session cloud, otherwise local', () => {
    assert.equal(whereItRan({ GITHUB_ACTIONS: 'true', CLAUDE_CODE_REMOTE: 'true' }), 'actions');
    assert.equal(whereItRan({ CLAUDE_CODE_REMOTE: 'true' }), 'cloud');
    assert.equal(whereItRan({}), 'local');
  });
});
