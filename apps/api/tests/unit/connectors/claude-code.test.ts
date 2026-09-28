import { describe, expect, it } from 'vitest';
import { isRoutineTriggerUrl } from '../../../src/connectors/claude-code.js';

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
    ])('refuses %s', (_situation, url) => {
      expect(isRoutineTriggerUrl(url)).toBe(false);
    });
  });
});
