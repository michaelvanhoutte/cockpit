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
      { situation: 'refused', connections: 'refused', keeps: 'refused' },
      { situation: 'a word typed into the address', connections: 'you-have-been-hacked', keeps: undefined },
      // What Gmail's own routes once sent back (issue 944), dropped like any other word.
      { situation: 'a link back from before Gmail moved', connections: 'gmail-connected', keeps: undefined },
    ])('$situation', ({ connections, keeps }) => {
      expect(connectionsSearch({ connections }).connections).toBe(keeps);
    });
  });
});
