import { describe, expect, it } from 'vitest';
import { TEAMS_IDENTITY } from '../../src/index.js';

/**
 * L1: Teams declares the addresses of its own messages, so the app can open an
 * Item that carries one in its text without naming Teams ("Open Items captured
 * with a pasted Teams message link in Teams", issue 1738).
 */
describe('Connector management', () => {
  describe('Teams declares its message links', () => {
    it.each(['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'])('%s, for a message path alone', (host) => {
      expect(TEAMS_IDENTITY.messageLinks).toContainEqual({ host, pathStart: '/l/message/' });
    });

    it('and nothing else: a chat or meeting link is not one', () => {
      expect(TEAMS_IDENTITY.messageLinks).toHaveLength(3);
    });
  });
});
