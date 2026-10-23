import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { allRequests, categoryOf, parseLog, requestsFromLog, sendUnsent, subagentIdentity, toRow, whereItRan } from './usage-report.mjs';

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
    ['on main with no process skill', request('2026-10-01T09:30:00Z', { branch: 'main' }), [], { category: 'outside-process' }],
    ['between start and scoped', request('2026-10-01T09:30:00Z'), marks, { category: 'scoping-planning' }],
    ['after scoped with no review open', request('2026-10-01T10:30:00Z'), marks, { category: 'building' }],
    ['a branch that never marked anything, outside the process', request('2026-10-01T10:30:00Z'), [], { category: 'outside-process' }],
    ['a request with no branch at all, outside the process', request('2026-10-01T10:30:00Z', { branch: null }), [], { category: 'outside-process' }],
    ['marks that never reached start, outside the process', request('2026-10-01T10:30:00Z', { branch: 'main' }), record(['2026-10-01T01:40:00Z', 'review-end', 'security-review', 'high']), { category: 'outside-process' }],
    ['before start, outside the process', request('2026-10-01T08:30:00Z'), marks, { category: 'outside-process' }],
    [
      'marks all written seconds apart after the request',
      request('2026-10-01T10:30:00Z'),
      record(['2026-10-01T18:00:00Z', 'start'], ['2026-10-01T18:00:01Z', 'scoped'], ['2026-10-01T18:00:02Z', 'built'], ['2026-10-01T18:00:03Z', 'pushed']),
      { category: 'outside-process' },
    ],
    ['the security review subagent before start', request('2026-10-01T08:30:00Z', { securityReview: true }), marks, { category: 'local-security-review' }],
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
    assert.deepEqual(category(request('2026-10-01T08:30:00Z'), [], 'actions'), { category: 'ci-reviews' });
  });

  it('a review window with no end stays a review until a later mark closes it', () => {
    const open = record(['2026-10-01T09:00:00Z', 'start'], ['2026-10-01T10:00:00Z', 'scoped'], ['2026-10-01T11:00:00Z', 'review-start', 'code-review', 'xhigh']);
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

// A session's log with process skills in it, and where its requests land.
const typed = (name, timestamp, args = '') =>
  JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>` } });
const invoked = (skill, timestamp, args = 'SECRET argument text') =>
  JSON.stringify({ type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill, args } }] } });
const invokedTogether = (skills, timestamp) =>
  JSON.stringify({ type: 'assistant', timestamp, message: { content: skills.map((skill) => ({ type: 'tool_use', name: 'Skill', input: { skill } })) } });

/** Each request's category by id, for a session's main log lines and its subagents' logs (each a list of lines), every request made on `branch`. */
const placed = (mainLines, { marks = [], branch = 'claude/build-1', subagents = [], ranWhere = 'local' } = {}) => {
  const read = (lines) => parseLog(lines.join('\n')).map((line) => (line.requestId ? { ...line, gitBranch: branch } : line));
  const logs = [
    { lines: read(mainLines), sessionId: 's1', subagent: false },
    ...subagents.map((lines) => ({ lines: read(lines), sessionId: 's1', subagent: true })),
  ];
  return Object.fromEntries(allRequests(logs).map((req) => [req.requestId, toRow(req, { ranWhere, marksOf: () => marks }).category]));
};

describe('A session is in a process skill from its invocation until another is invoked', () => {
  const t = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00Z`;

  const cases = [
    ['a chat before any invocation is outside the process', [reply('a', t(1))], { a: 'outside-process' }],
    ['a command typed as /scoping is in scoping from that line', [reply('a', t(1)), typed('scoping', t(2)), reply('b', t(3))], { a: 'outside-process', b: 'scoping-planning' }],
    ['engineering-plan invoked as a skill is in it from that line', [reply('a', t(1)), invoked('engineering-plan', t(2)), reply('b', t(3))], { a: 'outside-process', b: 'scoping-planning' }],
    ['a skill that is not a process skill leaves the session where it was', [typed('scoping', t(1)), invoked('github-issue', t(2)), reply('a', t(3))], { a: 'scoping-planning' }],
    ['a plugin-prefixed skill name is matched on its own name', [invoked('cockpit:harness-cost-review', t(1)), reply('a', t(2))], { a: 'process-review' }],
    ['the session-review that follows a /build is after push', [typed('build', t(1)), reply('a', t(2)), invoked('session-review', t(3)), reply('b', t(4))], { a: 'scoping-planning', b: 'after-push' }],
    ['a session-review with no /build before it is process review', [reply('a', t(1)), invoked('session-review', t(2)), reply('b', t(3))], { a: 'outside-process', b: 'process-review' }],
    ['a periodic-review is process review', [typed('periodic-review', t(1)), reply('a', t(2))], { a: 'process-review' }],
    ['a harness-cost-review is process review', [invoked('harness-cost-review', t(1)), reply('a', t(2))], { a: 'process-review' }],
    ['a process skill replaces the one before it', [typed('scoping', t(1)), reply('a', t(2)), invoked('periodic-review', t(3)), reply('b', t(4))], { a: 'scoping-planning', b: 'process-review' }],
    ['two skills invoked in one turn are each in from their own line', [invoked('scoping', t(1)), reply('a', t(2)), invoked('session-review', t(3)), reply('b', t(4))], { a: 'scoping-planning', b: 'process-review' }],
    ['two skills named in one line leave the session in the last', [invokedTogether(['scoping', 'harness-cost-review'], t(1)), reply('a', t(2))], { a: 'process-review' }],
    ['a /build is scoping and planning before its branch marks a start', [typed('build', t(1)), reply('a', t(2))], { a: 'scoping-planning' }],
  ];
  for (const [situation, lines, expected] of cases) {
    it(situation, () => assert.deepEqual(placed(lines, { branch: 'main' }), expected));
  }

  it("a subagent's request is placed by the step its session was in at that time", () => {
    const main = [typed('scoping', t(1)), invoked('periodic-review', t(10))];
    const sub = [reply('early', t(5)), reply('late', t(15)), reply('before', '2026-10-01T09:00:00Z')];
    assert.deepEqual(placed(main, { subagents: [sub], branch: 'main' }), { early: 'scoping-planning', late: 'process-review', before: 'outside-process' });
  });

  it("a skill invoked inside a subagent's own log does not move the session's step", () => {
    const main = [reply('a', t(5))];
    const sub = [typed('scoping', t(1)), invoked('scoping', t(2)), reply('b', t(6))];
    assert.deepEqual(placed(main, { subagents: [sub] }), { a: 'outside-process', b: 'outside-process' });
  });

  it('a skill named in the conversation or in a tool result, but not invoked, does not count', () => {
    const mention = JSON.stringify({ type: 'user', timestamp: t(1), message: { content: 'please run scoping then engineering-plan' } });
    const toolResult = JSON.stringify({ type: 'user', timestamp: t(1), message: { content: [{ type: 'tool_result', content: '<command-name>/scoping</command-name>' }] } });
    const pasted = JSON.stringify({ type: 'user', timestamp: t(1), message: { content: 'the log showed <command-name>/scoping</command-name> earlier' } });
    assert.deepEqual(placed([mention, toolResult, pasted, reply('a', t(2))]), { a: 'outside-process' });
  });
});

describe("Each request lands where the process step and the branch's marks say", () => {
  const t = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00Z`;
  const marks = record(['2026-10-01T10:05:00Z', 'start'], ['2026-10-01T10:20:00Z', 'scoped'], ['2026-10-01T10:40:00Z', 'review-start', 'code-review', 'high']);

  it('a run in Actions during scoping is a CI review', () => {
    assert.deepEqual(placed([typed('scoping', t(1)), reply('a', t(2))], { ranWhere: 'actions' }), { a: 'ci-reviews' });
  });

  it('the security review subagent outside the process is a local security review', () => {
    const sub = [invoked('security-review', t(1)), reply('s', t(2))];
    assert.deepEqual(placed([reply('a', t(1))], { subagents: [sub] }), { a: 'outside-process', s: 'local-security-review' });
  });

  it("inside a /build the step places a request before the branch's start and the marks decide from it on", () => {
    const lines = [typed('build', t(1)), reply('before', t(2)), reply('planning', t(10)), reply('building', t(30)), reply('reviewing', t(45))];
    assert.deepEqual(placed(lines, { marks }), { before: 'scoping-planning', planning: 'scoping-planning', building: 'building', reviewing: 'local-code-review' });
  });

  it('a plain chat on a branch after its start is placed by the marks', () => {
    assert.deepEqual(placed([reply('a', t(30))], { marks }), { a: 'building' });
  });

  it('a /build of a parent issue on a branch with no marks is scoping and planning', () => {
    assert.deepEqual(placed([typed('build', t(1)), reply('a', t(2))], { marks: [] }), { a: 'scoping-planning' });
  });

  it('a session-review after a /build, on its own branch, is after push', () => {
    assert.deepEqual(placed([typed('build', t(1)), invoked('session-review', t(2)), reply('a', t(3))], { branch: 'claude/session-review-1' }), { a: 'after-push' });
  });

  it('work on main is placed by the session like any branch', () => {
    assert.deepEqual(placed([reply('a', t(1)), typed('scoping', t(2)), reply('b', t(3))], { branch: 'main' }), { a: 'outside-process', b: 'scoping-planning' });
  });

  it('a request on a branch that never marked anything, with no process skill, is outside the process', () => {
    assert.deepEqual(placed([reply('a', t(1))], { marks: [], branch: 'claude/some-fix' }), { a: 'outside-process' });
  });
});

describe('Which skill a session invoked never leaves the machine', () => {
  it('a request made during scoping, with arguments, has its usual fields only', () => {
    const lines = [typed('scoping', '2026-10-01T10:00:00Z', 'SECRET argument'), invoked('engineering-plan', '2026-10-01T10:01:00Z', 'SECRET args'), reply('req_1', '2026-10-01T10:02:00Z')];
    const [req] = allRequests([{ lines: parseLog(lines.join('\n')), sessionId: 's1', subagent: false }]);
    const sent = toRow(req, { ranWhere: 'local', marksOf: () => [] });
    assert.equal(sent.category, 'scoping-planning');
    assert.deepEqual(Object.keys(sent).sort(), [
      'branch', 'cacheCreationTokens', 'cacheReadTokens', 'category', 'inputTokens', 'model', 'outputTokens',
      'ranWhere', 'requestId', 'sessionId', 'source', 'speed', 'subagent', 'time',
    ]);
    assert.ok(!/SECRET|engineering/.test(JSON.stringify(sent)));
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

describe("A subagent's request carries its agent's type and id, and nothing else of its metadata", () => {
  const asSubagent = (fileName, metaText) => {
    const identity = subagentIdentity(fileName, metaText);
    const [req] = requestsFromLog(parseLog(reply('req_1', '2026-10-01T10:00:00Z')), { sessionId: 's1', subagent: true, identity });
    return toRow(req, { ranWhere: 'local', marksOf: () => [] });
  };

  it('a subagent with metadata naming its type sends the type and the id', () => {
    const sent = asSubagent('agent-a0089b3f.jsonl', JSON.stringify({ agentType: 'Explore', spawnDepth: 1 }));
    assert.equal(sent.subagentType, 'Explore');
    assert.equal(sent.subagentId, 'a0089b3f');
  });

  it("a subagent with no metadata file sends the id from the log's name and no type", () => {
    const sent = asSubagent('agent-a0089b3f.jsonl', '');
    assert.equal(sent.subagentId, 'a0089b3f');
    assert.ok(!('subagentType' in sent));
  });

  it('metadata with a task description sends no description', () => {
    const sent = asSubagent('agent-a1.jsonl', JSON.stringify({ agentType: 'general-purpose', description: 'SECRET task description' }));
    assert.ok(!JSON.stringify(sent).includes('SECRET'));
    assert.deepEqual(Object.keys(sent).filter((k) => /agent|descr/i.test(k) && k !== 'subagent').sort(), ['subagentId', 'subagentType']);
  });

  it("a main-agent request carries neither, even given an identity", () => {
    const [req] = requestsFromLog(parseLog(reply('req_1', '2026-10-01T10:00:00Z')), { sessionId: 's1', subagent: false, identity: { subagentId: 'x', subagentType: 'Explore' } });
    const sent = toRow(req, { ranWhere: 'local', marksOf: () => [] });
    assert.ok(!('subagentType' in sent) && !('subagentId' in sent));
  });
});

describe('Where a request ran is recorded', () => {
  it('inside GitHub Actions is Actions, inside a cloud session cloud, otherwise local', () => {
    assert.equal(whereItRan({ GITHUB_ACTIONS: 'true', CLAUDE_CODE_REMOTE: 'true' }), 'actions');
    assert.equal(whereItRan({ CLAUDE_CODE_REMOTE: 'true' }), 'cloud');
    assert.equal(whereItRan({}), 'local');
  });
});
