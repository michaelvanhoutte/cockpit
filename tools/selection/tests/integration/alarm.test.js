/**
 * The alarm step against a stand-in for GitHub's issues API that keeps the
 * issues it is given, so a second night reads what the first one wrote. The
 * decision itself is tests/unit/alarm.test.js's; what only this level shows
 * is the requests: their paths, the label, the token, and a refused write
 * being named by its bar without stopping the others.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/alarm-cli.js';
import { listAlarmIssues } from '../../src/issues.js';
import { bothForcedFull, e2eForcedFull, modelOf, quiet } from '../support/model.js';

const dirs = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository's issues, labels and comments, answering the calls the step makes. `refuse` turns a matching write into a 403. */
function aRepository({ hasLabel = false, refuse = () => false } = {}) {
  const state = { issues: [], comments: new Map(), labels: new Set(hasLabel ? ['selection-alarm'] : []), calls: [], tokens: new Set() };
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  const fetchImpl = async (url, { method = 'GET', headers, body } = {}) => {
    const route = new URL(url);
    const payload = body ? JSON.parse(body) : null;
    state.calls.push(`${method} ${route.pathname}`);
    state.tokens.add(headers.authorization);
    if (method !== 'GET' && refuse({ method, path: route.pathname, payload })) return reply(403, { message: 'Resource not accessible by integration' });

    let match;
    if (method === 'GET' && route.pathname === '/repos/o/r/issues') {
      const page = Number(route.searchParams.get('page'));
      return reply(200, page === 1 ? state.issues.filter((issue) => issue.labels.includes(route.searchParams.get('labels'))) : []);
    }
    if (method === 'GET' && (match = route.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/))) {
      return reply(200, route.searchParams.get('page') === '1' ? (state.comments.get(Number(match[1])) ?? []).map((text) => ({ body: text })) : []);
    }
    if (method === 'GET' && route.pathname === '/repos/o/r/labels/selection-alarm') return state.labels.has('selection-alarm') ? reply(200, {}) : reply(404, { message: 'Not Found' });
    if (method === 'POST' && route.pathname === '/repos/o/r/labels') {
      state.labels.add(payload.name);
      return reply(201, {});
    }
    if (method === 'POST' && route.pathname === '/repos/o/r/issues') {
      const issue = { number: 100 + state.issues.length, state: 'open', labels: payload.labels, title: payload.title, body: payload.body };
      state.issues.push(issue);
      return reply(201, { number: issue.number });
    }
    if (method === 'PATCH' && (match = route.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)$/))) {
      Object.assign(state.issues.find((issue) => issue.number === Number(match[1])), payload);
      return reply(200, {});
    }
    if (method === 'POST' && (match = route.pathname.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments$/))) {
      const number = Number(match[1]);
      state.comments.set(number, [...(state.comments.get(number) ?? []), payload.body]);
      return reply(201, {});
    }
    return reply(404, { message: `no route for ${method} ${route.pathname}` });
  };
  return { state, fetchImpl };
}

/** Runs the step the way the workflow does: a model file on disk and a token in the environment. */
async function runStep(pulls, repository, { extra = [], now } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'selection-alarm-'));
  dirs.push(dir);
  const model = path.join(dir, 'model.json');
  writeFileSync(model, JSON.stringify(modelOf(pulls, { now })), 'utf8');
  vi.stubEnv('GITHUB_TOKEN', 'the-workflows-token');
  const stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  const code = await main(['--model', model, '--repo', 'o/r', ...extra], { fetchImpl: repository.fetchImpl });
  vi.unstubAllEnvs();
  return { code, stderr: stderr.join('') };
}

describe('Test selection report', () => {
  describe('the nightly job files, updates and comments on alarm issues', () => {
    it('the first night files one issue per crossed bar, labelled, creating the label when the repository has none', async () => {
      const repository = aRepository();
      const { code } = await runStep(bothForcedFull(), repository);
      expect(code).toBe(0);
      expect(repository.state.labels.has('selection-alarm')).toBe(true);
      expect(repository.state.issues.map((issue) => [issue.labels, issue.title])).toEqual([
        [['selection-alarm'], 'Selection: E2E forced to run every spec on 100% of pull requests'],
        [['selection-alarm'], 'Selection: Test forced to run everything on 50% of pull requests'],
      ]);
    });

    it('the label is not made again where the repository has it', async () => {
      const repository = aRepository({ hasLabel: true });
      await runStep(e2eForcedFull(), repository);
      expect(repository.state.calls).not.toContain('POST /repos/o/r/labels');
      expect(repository.state.issues).toHaveLength(1);
    });

    it('uses the workflow’s own token for every call', async () => {
      const repository = aRepository();
      await runStep(e2eForcedFull(), repository);
      expect([...repository.state.tokens]).toEqual(['Bearer the-workflows-token']);
    });

    it('running the job again the same night edits the issue it filed and files no second one', async () => {
      const repository = aRepository();
      await runStep(e2eForcedFull(), repository);
      const [filed] = repository.state.issues;
      const { code } = await runStep(e2eForcedFull(), repository);
      expect(code).toBe(0);
      expect(repository.state.issues).toHaveLength(1);
      expect(repository.state.issues[0].body).toBe(filed.body);
      expect(repository.state.calls.filter((call) => call === 'PATCH /repos/o/r/issues/100')).toHaveLength(1);
    });

    it('a bar back within is commented on once across two nights, and the issue is left open', async () => {
      const repository = aRepository();
      await runStep(e2eForcedFull(), repository);
      await runStep(quiet(), repository, { now: new Date('2026-02-16T04:17:00Z') });
      await runStep(quiet(), repository, { now: new Date('2026-02-17T04:17:00Z') });
      expect(repository.state.issues[0].state).toBe('open');
      expect(repository.state.comments.get(100)).toHaveLength(1);
    });

    it('a bar that crosses after its alarm was closed by a person gets a new issue linking it', async () => {
      const repository = aRepository();
      await runStep(e2eForcedFull(), repository);
      repository.state.issues[0].state = 'closed';
      await runStep(e2eForcedFull(), repository);
      expect(repository.state.issues.map((issue) => issue.state)).toEqual(['closed', 'open']);
      expect(repository.state.issues[1].body).toContain('**Follows** #100, closed');
    });

    it('a write GitHub refuses fails the step naming the bar, after the other bars were still tried', async () => {
      const repository = aRepository({ refuse: ({ method, path: route, payload }) => method === 'POST' && route === '/repos/o/r/issues' && payload.title.startsWith('Selection: E2E') });
      const { code, stderr } = await runStep(bothForcedFull(), repository);
      expect(code).toBe(1);
      expect(stderr).toContain('alarm for e2e-forced-full failed');
      expect(stderr).toContain('403');
      expect(repository.state.issues.map((issue) => issue.title)).toEqual(['Selection: Test forced to run everything on 50% of pull requests']);
    });

    it('--dry-run says what it would do and changes nothing', async () => {
      const repository = aRepository();
      const { code, stderr } = await runStep(e2eForcedFull(), repository, { extra: ['--dry-run'] });
      expect(code).toBe(0);
      expect(stderr).toContain('file   [e2e-forced-full] Selection: E2E forced to run every spec on 100% of pull requests');
      expect(repository.state.issues).toEqual([]);
      expect(repository.state.calls.every((call) => call.startsWith('GET '))).toBe(true);
    });

    it('a night with no bar crossed and no alarm open touches nothing', async () => {
      const repository = aRepository();
      const { code, stderr } = await runStep(quiet(), repository);
      expect(code).toBe(0);
      expect(stderr).toContain('no alarm to file, edit or comment on');
      expect(repository.state.calls.every((call) => call.startsWith('GET '))).toBe(true);
    });

    it('pull requests that carry the label are not alarms', async () => {
      const repository = aRepository();
      repository.state.issues.push({ number: 1, state: 'open', labels: ['selection-alarm'], title: 'A pull request', body: '', pull_request: {} });
      expect(await listAlarmIssues({ repo: 'o/r', fetchImpl: repository.fetchImpl })).toEqual([]);
    });
  });
});
