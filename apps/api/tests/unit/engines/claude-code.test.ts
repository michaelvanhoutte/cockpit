import { describe, expect, it } from 'vitest';
import { isRoutineTriggerUrl, refusalFor, sessionUrlFrom } from '../../../src/engines/claude-code.js';

/**
 * L1: pure, no network - the check `testClaudeCodeConnection` runs before any
 * call is made ("Connect a workspace to Claude Code", issue 569, rule 2).
 * What actually firing a trigger does is proven at integration level, with
 * Claude faked at the network boundary
 * (tests/integration/http/claude-code-connections.test.ts) - not here,
 * network being exactly what L1 may not touch.
 */
describe('Connector management', () => {
  describe('only an address of Anthropic’s routine trigger is ever called', () => {
    it.each([
      'https://api.anthropic.com/v1/claude_code/routines/rt_abc123/fire',
      'https://api.anthropic.com/v1/claude_code/routines/018f0000-0000-7000-8000-000000000001/fire',
    ])('accepts %s', (url) => {
      expect(isRoutineTriggerUrl(url)).toBe(true);
    });

    it.each([
      ['a different host', 'https://evil.example.com/v1/claude_code/routines/rt_abc123/fire'],
      ['plain http', 'http://api.anthropic.com/v1/claude_code/routines/rt_abc123/fire'],
      ['a different path', 'https://api.anthropic.com/v1/routines/rt_abc123/fire'],
      ['a missing routine id', 'https://api.anthropic.com/v1/claude_code/routines//fire'],
      ['an extra path segment', 'https://api.anthropic.com/v1/claude_code/routines/rt_abc123/fire/extra'],
      ['no fire suffix at all', 'https://api.anthropic.com/v1/claude_code/routines/rt_abc123'],
      ['not a url at all', 'not a url'],
      ['empty', ''],
      ['a host that only starts like Anthropic’s', 'https://api.anthropic.com.evil.example/v1/claude_code/routines/rt_abc123/fire'],
    ])('refuses %s', (_situation, url) => {
      expect(isRoutineTriggerUrl(url)).toBe(false);
    });

    it.each([
      { situation: 'its own routine', url: 'http://127.0.0.1:5555/v1/claude_code/routines/trig_local/fire', accepted: true },
      { situation: 'Anthropic’s, once another is named', url: 'https://api.anthropic.com/v1/claude_code/routines/rt/fire', accepted: false },
    ])('takes a stand-in origin’s address for $situation', ({ url, accepted }) => {
      expect(isRoutineTriggerUrl(url, 'http://127.0.0.1:5555')).toBe(accepted);
    });
  });
});

/**
 * L1, for the same reason: how an answer from Claude is read, with no network
 * behind it. That a start then records what these say is
 * tests/integration/http/agent-runs.test.ts's.
 */
describe('Agents', () => {
  describe('a refusal says whether it was the connection Claude refused', () => {
    it.each([
      { situation: 'a revoked token', status: 401, connection: true },
      { situation: 'a routine that is gone', status: 404, connection: true },
      { situation: 'a limit reached', status: 429, connection: true },
      { situation: 'a paused routine', status: 400, connection: true },
      { situation: 'an account without routines', status: 403, connection: true },
      { situation: 'a fault at Claude’s end', status: 500, connection: false },
      { situation: 'Claude overloaded', status: 503, connection: false },
    ])('$situation', ({ status, connection }) => {
      expect(refusalFor(status).connection).toBe(connection);
    });
  });

  describe('an accepted start keeps the session link only where it is one a browser can open', () => {
    it.each([
      { situation: 'Anthropic’s link', body: { claude_code_session_url: 'https://claude.ai/code/session_01' }, link: 'https://claude.ai/code/session_01' },
      { situation: 'no link at all', body: { type: 'routine_fire' }, link: null },
      { situation: 'no body', body: null, link: null },
      { situation: 'a link that is not text', body: { claude_code_session_url: 42 }, link: null },
      { situation: 'a link that is not an address', body: { claude_code_session_url: 'session_01' }, link: null },
      { situation: 'a script instead of an address', body: { claude_code_session_url: 'javascript:alert(1)' }, link: null },
    ])('$situation', ({ body, link }) => {
      expect(sessionUrlFrom(body)).toBe(link);
    });
  });
});
