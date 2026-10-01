import { describe, expect, it } from 'vitest';
import { isAnsweredByTheAuthorizationServer } from '../../../src/mcp/paths.js';

/**
 * L1: which addresses are an app's, answered in front of the sign-in gate.
 * That a signed-in browser still cannot capture through them is
 * tests/integration/http/connected-apps.test.ts's.
 */
describe('MCP connections', () => {
  describe('only the addresses an app uses are answered in front of the sign-in gate', () => {
    it.each([
      { path: '/mcp', answered: true },
      { path: '/mcp/anything', answered: true },
      { path: '/oauth/token', answered: true },
      { path: '/oauth/register', answered: true },
      { path: '/.well-known/oauth-authorization-server', answered: true },
      { path: '/.well-known/oauth-protected-resource/mcp', answered: true },
      { path: '/mcp-other', answered: false },
      { path: '/oauth/tokens', answered: false },
      { path: '/oauth/authorize', answered: false },
      { path: '/v1/workspaces', answered: false },
    ])('$path', ({ path, answered }) => {
      expect(isAnsweredByTheAuthorizationServer(path)).toBe(answered);
    });
  });
});
