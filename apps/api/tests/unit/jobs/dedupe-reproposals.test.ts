import { describe, expect, it } from 'vitest';
import type { Message } from '@cloudflare/workers-types';
import { dedupeReproposals } from '../../../src/jobs/index.js';

/**
 * Unit level: whether a batch of queue messages collapses several
 * `re-propose-panels` jobs for the same account and Workspace into one is a
 * pure decision over the messages' own bodies - no queue, no store, no model
 * ("Re-propose the rest of the inbox the moment you file one", issue 300,
 * "several at once should fire one refresh, not one per item").
 */

type FakeMessage = Message<unknown> & { acked: boolean };

let nextId = 0;
function messageOf(body: unknown): FakeMessage {
  nextId += 1;
  const message = {
    id: `message-${nextId}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    acked: false,
    ack: () => {
      message.acked = true;
    },
    retry: () => {},
  } as unknown as FakeMessage;
  return message;
}

const rePropose = (accountName: string, workspaceId: string) => ({
  kind: 're-propose-panels',
  accountName,
  workspaceId,
});

describe('Triage', () => {
  describe('several settles queued for the same account and Workspace start one refresh, not one per settle', () => {
    it('keeps the first re-propose-panels message and acknowledges a later duplicate unread', () => {
      const first = messageOf(rePropose('tenant-default', 'ws-1'));
      const second = messageOf(rePropose('tenant-default', 'ws-1'));

      const kept = dedupeReproposals([first, second]);

      expect(kept).toEqual([first]);
      expect(second.acked).toBe(true);
      expect(first.acked).toBe(false);
    });

    it('keeps every message once several are queued for different Workspaces', () => {
      const forWs1 = messageOf(rePropose('tenant-default', 'ws-1'));
      const forWs2 = messageOf(rePropose('tenant-default', 'ws-2'));

      const kept = dedupeReproposals([forWs1, forWs2]);

      expect(kept).toEqual([forWs1, forWs2]);
    });

    it('keeps every message once several are queued for different accounts, even the same Workspace id', () => {
      const forTenantA = messageOf(rePropose('tenant-a', 'ws-1'));
      const forTenantB = messageOf(rePropose('tenant-b', 'ws-1'));

      const kept = dedupeReproposals([forTenantA, forTenantB]);

      expect(kept).toEqual([forTenantA, forTenantB]);
    });

    it('leaves a clean-up-a-note message alone, whatever else is in the batch', () => {
      const cleanUp = messageOf({ kind: 'clean-up-a-note', accountName: 'tenant-default', itemId: 'item-1' });
      const first = messageOf(rePropose('tenant-default', 'ws-1'));
      const second = messageOf(rePropose('tenant-default', 'ws-1'));

      const kept = dedupeReproposals([cleanUp, first, second]);

      expect(kept).toEqual([cleanUp, first]);
    });

    it('leaves a malformed re-propose-panels body alone, for the real parse to refuse', () => {
      const malformed = messageOf({ kind: 're-propose-panels', accountName: 'tenant-default', workspaceId: 42 });
      const another = messageOf({ kind: 're-propose-panels', accountName: 'tenant-default', workspaceId: 42 });

      const kept = dedupeReproposals([malformed, another]);

      expect(kept).toEqual([malformed, another]);
    });
  });
});
