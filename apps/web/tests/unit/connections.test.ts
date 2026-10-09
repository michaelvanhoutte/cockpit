import { describe, expect, it } from 'vitest';
import { connectionsSearch } from '../../src/connections';

/**
 * F1, and pure: what the address may carry back from a trip out to connect an
 * account. What the window then says for each is in
 * tests/unit/components/ManageConnections.test.tsx.
 */
describe('Connector management', () => {
  describe('a refusal a connector gave keeps who and why as codes, and nothing else the address says', () => {
    it.each([
      { situation: 'codes', search: { connections: 'refused', by: 'notion', because: 'no-offline' }, keeps: { connections: 'refused', by: 'notion', because: 'no-offline' } },
      { situation: 'words typed into the address', search: { connections: 'refused', by: 'notion', because: 'Call 0800 123 456 now' }, keeps: { connections: 'refused' } },
      { situation: 'a reason on an outcome that was not a refusal', search: { connections: 'connected', by: 'notion', because: 'no-offline' }, keeps: { connections: 'connected' } },
    ])('$situation', ({ search, keeps }) => {
      expect(connectionsSearch(search)).toEqual(keeps);
    });
  });

  describe('coming back from connecting keeps how it went, and nothing else the address says', () => {
    it.each([
      { situation: 'connected to Microsoft Teams', connections: 'connected', keeps: 'connected' },
      { situation: 'connected to Gmail', connections: 'gmail-connected', keeps: 'gmail-connected' },
      { situation: 'connected to Gmail by star', connections: 'gmail-star-connected', keeps: 'gmail-star-connected' },
      { situation: 'refused', connections: 'refused', keeps: 'refused' },
      { situation: 'cancelled on the consent screen', connections: 'cancelled', keeps: 'cancelled' },
      {
        situation: 'refused without the permission to change mail',
        connections: 'gmail-permission-missing',
        keeps: 'gmail-permission-missing',
      },
      {
        situation: 'refused without a refresh token',
        connections: 'gmail-no-refresh-token',
        keeps: 'gmail-no-refresh-token',
      },
      { situation: 'a word typed into the address', connections: 'you-have-been-hacked', keeps: undefined },
    ])('$situation', ({ connections, keeps }) => {
      expect(connectionsSearch({ connections }).connections).toBe(keeps);
    });
  });
});
