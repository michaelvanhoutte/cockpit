import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createStore, entries, get, set } from 'idb-keyval';
import { forgetEverything } from '../../../src/session/forget';
import { saveRead } from '../../../src/persistence';
import { aShare, holdAShare, howManyAreHeld } from '../support/shares';
import { aWorkspace, anItem } from '../support/savedReads';
import { changes } from '../../../src/api/changes';
import { sendCommand } from '../../../src/api/client';

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  sendCommand: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
}));

/**
 * F1 over a fake IndexedDB: what the logon page's wipe takes from this device's
 * storage. That nothing of the last person is left in a real browser is
 * tests/e2e/sign-in.test.ts.
 */

const savedReads = createStore('cockpit-saved-reads', 'reads');
const outbox = createStore('cockpit-capture-outbox', 'entries');
const recordings = createStore('cockpit-kept-recordings', 'recordings');

describe('Sign-in', () => {
  describe('signing out removes every saved read and nothing else', () => {
    it('leaves captures waiting to send, kept recordings and held shares', async () => {
      await saveRead({ queryKey: ['snapshot', 'ws-work'], data: aWorkspace(), savedAt: Date.now() });
      await saveRead({ queryKey: ['me'], data: { user: { id: 'user-anna', name: 'Anna', role: 'user' } }, savedAt: Date.now() });
      await set('capture-1', { text: 'Call Ann' }, outbox);
      await set('recording-1', { owner: 'user-anna' }, recordings);
      await holdAShare(aShare());

      await forgetEverything(new QueryClient());

      expect(await entries(savedReads)).toEqual([]);
      expect(await get('capture-1', outbox)).toEqual({ text: 'Call Ann' });
      expect(await get('recording-1', recordings)).toEqual({ owner: 'user-anna' });
      expect(await howManyAreHeld()).toBe(1);
    });
  });

  describe('signing out stops showing a change the server answered but no read has yet covered', () => {
    it('draws the next Workspace as the server sent it', async () => {
      const item = anItem(1, { title: 'Reply to Bart' });
      await changes.enqueue({
        name: 'set_title',
        payload: { commandId: 'c1', issuedAt: '2026-10-20T09:00:00.000Z', workspaceId: 'ws-work', itemId: item.id, title: 'Renamed' },
      });
      expect(sendCommand).toHaveBeenCalled();
      expect(changes.drawnOver(aWorkspace([item])).items[0]!.title).toBe('Renamed');

      await forgetEverything(new QueryClient());

      expect(changes.drawnOver(aWorkspace([item])).items[0]!.title).toBe('Reply to Bart');
    });
  });
});
