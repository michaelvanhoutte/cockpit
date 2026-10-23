import { describe, expect, it } from 'vitest';
import { isAnAddressOfTheReadsOfPanels, oauthDoorOf } from '../../../src/auth/mcp-paths.js';

/**
 * L1: which addresses are an app's, answered in front of the sign-in gate, and
 * by which door of the OAuth library. That a signed-in browser still cannot
 * capture through them is tests/integration/http/connected-apps.test.ts's.
 */
describe('MCP connections', () => {
  describe('only the addresses an app uses are answered in front of the sign-in gate, each by its own door', () => {
    it.each([
      { path: '/mcp', door: 'mcp' },
      { path: '/mcp/anything', door: 'mcp' },
      { path: '/.well-known/oauth-protected-resource/mcp', door: 'mcp' },
      { path: '/apps', door: 'apps' },
      { path: '/apps/v1/panels', door: 'apps' },
      { path: '/apps/v1/panels/the-panel', door: 'apps' },
      { path: '/.well-known/oauth-protected-resource/apps', door: 'apps' },
      { path: '/oauth/token', door: 'authorization-server' },
      { path: '/oauth/register', door: 'authorization-server' },
      { path: '/.well-known/oauth-authorization-server', door: 'authorization-server' },
      { path: '/mcp-other', door: null },
      { path: '/apps-other', door: null },
      { path: '/oauth/tokens', door: null },
      { path: '/oauth/authorize', door: null },
      { path: '/v1/workspaces', door: null },
    ])('$path', ({ path, door }) => {
      expect(oauthDoorOf(path)).toBe(door);
    });
  });

  describe('only the two reads of Panels are the reads, and every other address under /apps is no read', () => {
    it.each([
      { path: '/apps/v1/panels', read: true },
      { path: '/apps/v1/panels/018f0000-0000-7000-8000-000000000001', read: true },
      { path: '/apps', read: false },
      { path: '/apps/v1/panelsandmore', read: false },
      { path: '/apps/v2/panels', read: false },
      { path: '/apps/v1', read: false },
      { path: '/mcp', read: false },
    ])('$path', ({ path, read }) => {
      expect(isAnAddressOfTheReadsOfPanels(path)).toBe(read);
    });
  });
});
