import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CommandRefused } from '../../src/api/client';
import { stateOf, type OutboxEntry } from '../../src/captureOutbox';
import {
  CaptureOutbox,
  OutboxProvider,
  browserOutboxStore,
  inTabLock,
  useSendingCaptures,
  type Lock,
  type Sender,
} from '../../src/captureOutboxSender';

/**
 * F1: the outbox against a fake IndexedDB, and a fake of the server at the API
 * client's edge - so "reloaded" is a second outbox opening the same stored
 * entries, and "one Item" is what the fake server ends up holding. The rules
 * deciding which capture goes and what an answer means are L1, in
 * tests/unit/captureOutbox.test.ts; the form is
 * tests/unit/components/CaptureNote.test.tsx; that the server applies a
 * repeated capture once is its own (`commandAlreadyApplied`), and that a file
 * uploaded twice under one attachment id stays one attachment is
 * apps/api/tests/integration/http/attachments.test.ts.
 */

/**
 * The server as far as a capture can tell. It makes an Item for every capture
 * it has not seen *by its command id* - so a capture resent under a new id
 * would really make two.
 */
function aServer() {
  const server = {
    reachable: true,
    online: true,
    /** Applies the next capture, then loses the answer on the way back. */
    losesNextAnswer: false,
    uploadsReachable: true,
    /** The note the server refuses, by what it says, and why. */
    refuseCapture: null as { message: string; because: Error } | null,
    refuseFile: null as string | null,
    items: new Map<string, { itemId: string; message: string; issuedAt: string }>(),
    attachments: new Map<string, { itemId: string; name: string; text: string }>(),
    captureOrder: [] as string[],
    captureCalls: 0,
    inFlight: 0,
    mostAtOnce: 0,
    sender: null as unknown as Sender,
  };
  server.sender = {
    capture: async (payload) => {
      server.captureCalls += 1;
      server.inFlight += 1;
      server.mostAtOnce = Math.max(server.mostAtOnce, server.inFlight);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        if (!server.reachable) throw new TypeError('Failed to fetch');
        if (server.refuseCapture?.message === payload.message) throw server.refuseCapture.because;
        const applied = !server.items.has(payload.commandId);
        if (applied) {
          server.items.set(payload.commandId, {
            itemId: payload.itemId,
            message: payload.message,
            issuedAt: payload.issuedAt,
          });
          server.captureOrder.push(payload.message);
        }
        if (server.losesNextAnswer) {
          server.losesNextAnswer = false;
          throw new TypeError('Failed to fetch');
        }
        return { ok: true, applied };
      } finally {
        server.inFlight -= 1;
      }
    },
    upload: async ({ itemId, attachmentId, file }) => {
      if (!server.reachable || !server.uploadsReachable) throw new TypeError('Failed to fetch');
      if (server.refuseFile === file.name) {
        throw new CommandRefused(415, `"${file.name}" is not a kind of file Cockpit accepts.`);
      }
      server.attachments.set(attachmentId, { itemId, name: file.name, text: await file.text() });
      return { ok: true, applied: true };
    },
  };
  return server;
}

type Server = ReturnType<typeof aServer>;

/** One tab's outbox, over the IndexedDB every tab of this browser shares. */
function aTab(server: Server, { lock = inTabLock(), owner = 'user-ada' as string | null } = {}) {
  const outbox = new CaptureOutbox({
    store: browserOutboxStore(),
    sender: server.sender,
    lock,
    online: () => server.online,
    timeoutMs: 1_000,
  });
  outbox.signedInAs(owner);
  return outbox;
}

/** Lets every pending IndexedDB and send step run, without touching any timer. */
async function settled() {
  for (let i = 0; i < 300; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Ids in the order they were made, as the app's own are. */
let made = 0;
const capture = (message: string, files: File[] = []) => ({
  id: `item-${String((made += 1)).padStart(6, '0')}`,
  message,
  typeId: 'type-task',
  workspaceId: 'ws-work',
  decided: true,
  files: files.map((file) => ({ id: crypto.randomUUID(), file })),
});

const photo = (name = 'photo.png', text = 'photo-bytes') => new File([text], name, { type: 'image/png' });

/** The app's shell, sending for `owner`, with this outbox - which is how a page is opened. */
function anOpenApp(outbox: CaptureOutbox, owner = 'user-ada') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <OutboxProvider value={outbox}>{children}</OutboxProvider>
    </QueryClientProvider>
  );
  const app = renderHook(({ who }) => useSendingCaptures(who), { wrapper, initialProps: { who: owner } });
  return { client, app };
}

const messages = (server: Server) => [...server.items.values()].map((item) => item.message);

beforeEach(() => {
  // A browser of its own for every case: nothing stored by the last one.
  globalThis.indexedDB = new IDBFactory();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Offline', () => {
  describe('a waiting capture goes out as soon as it can, oldest first, with the time it was captured', () => {
    it.each([
      {
        situation: 'the connection comes back',
        trigger: async () => window.dispatchEvent(new Event('online')),
      },
      {
        situation: 'the tab comes back into view',
        trigger: async () => {
          Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        },
      },
      {
        situation: 'another request of the app’s succeeds',
        trigger: async (client: QueryClient) => {
          await client.fetchQuery({ queryKey: ['workspaces'], queryFn: () => Promise.resolve([]) });
        },
      },
    ])('is sent when $situation', async ({ trigger }) => {
      const server = aServer();
      server.reachable = false;
      const outbox = aTab(server, { owner: null });
      const { client } = anOpenApp(outbox);
      await outbox.add(capture('Ring the plumber'));
      await settled();
      expect(messages(server)).toEqual([]);

      server.reachable = true;
      await act(async () => {
        await trigger(client);
        await settled();
      });

      expect(messages(server)).toEqual(['Ring the plumber']);
    });

    it('is sent when the app is opened with one waiting', async () => {
      const server = aServer();
      server.reachable = false;
      await aTab(server).add(capture('Ring the plumber'));
      await settled();

      server.reachable = true;
      anOpenApp(aTab(server, { owner: null }));
      await act(settled);

      expect(messages(server)).toEqual(['Ring the plumber']);
    });

    it('takes the older waiting ones with it when a new capture is made', async () => {
      const server = aServer();
      server.reachable = false;
      const outbox = aTab(server);
      await outbox.add(capture('First'));
      await outbox.add(capture('Second'));
      await settled();

      server.reachable = true;
      await outbox.add(capture('Third'));
      await settled();

      expect(server.captureOrder).toEqual(['First', 'Second', 'Third']);
    });

    it('with no event at all, is sent on the backoff: 30s, then a minute', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const server = aServer();
      server.reachable = false;
      const outbox = aTab(server);
      await outbox.add(capture('Ring the plumber'));
      await settled();

      // The first wait: still unreachable when it ends, so the next is longer.
      const attempted = server.captureCalls;
      await vi.advanceTimersByTimeAsync(29_000);
      await settled();
      expect(server.captureCalls).toBe(attempted);
      await vi.advanceTimersByTimeAsync(1_000);
      await settled();
      expect(server.captureCalls).toBe(attempted + 1);
      server.reachable = true;
      await vi.advanceTimersByTimeAsync(59_000);
      await settled();
      expect(messages(server)).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      await settled();
      expect(messages(server)).toEqual(['Ring the plumber']);
    });

    it('makes no attempt while the browser says it is offline', async () => {
      const server = aServer();
      server.online = false;
      const outbox = aTab(server);

      await outbox.add(capture('Ring the plumber'));
      await outbox.send();
      await settled();

      expect(server.captureCalls).toBe(0);
      expect(outbox.getShown()).toHaveLength(1);
    });

    it('goes in the order they were captured, three waiting', async () => {
      const server = aServer();
      server.reachable = false;
      const outbox = aTab(server);
      for (const message of ['One', 'Two', 'Three']) await outbox.add(capture(message));
      await settled();

      server.reachable = true;
      await outbox.send();
      await settled();

      expect(server.captureOrder).toEqual(['One', 'Two', 'Three']);
      expect(outbox.getShown()).toEqual([]);
    });

    it('carries the time it was captured, sent an hour late', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-01T08:00:00.000Z'));
      const server = aServer();
      server.reachable = false;
      const outbox = aTab(server);
      await outbox.add(capture('Ring the plumber'));
      await settled();

      vi.setSystemTime(new Date('2026-10-01T09:00:00.000Z'));
      server.reachable = true;
      await outbox.send();
      await settled();

      expect([...server.items.values()][0]?.issuedAt).toBe('2026-10-01T08:00:00.000Z');
    });
  });

  describe('a capture becomes one Item however many times it is sent', () => {
    it('is removed once a resend is told it was already applied, after the first answer was lost', async () => {
      const server = aServer();
      server.losesNextAnswer = true;
      const outbox = aTab(server);
      await settled();
      await outbox.add(capture('Ring the plumber'));
      await settled();
      expect(outbox.getShown()).toHaveLength(1);

      await outbox.send();
      await settled();

      expect(messages(server)).toEqual(['Ring the plumber']);
      expect(server.captureCalls).toBe(2);
      expect(outbox.getShown()).toEqual([]);
    });

    it('is sent by one tab at a time when two are open and both try', async () => {
      const server = aServer();
      server.reachable = false;
      // What Web Locks gives every tab of a browser: one lock between them.
      const acrossTabs: Lock = inTabLock();
      const first = aTab(server, { lock: acrossTabs });
      const second = aTab(server, { lock: acrossTabs });
      await first.add(capture('Ring the plumber'));
      await settled();

      server.reachable = true;
      server.captureCalls = 0;
      await Promise.all([first.send(), second.send()]);
      await settled();

      expect(messages(server)).toEqual(['Ring the plumber']);
      expect(server.captureCalls).toBe(1);
      expect(server.mostAtOnce).toBe(1);
    });
  });

  describe('files captured with a note wait with it, and attach once it lands', () => {
    it('keeps both files of a note captured offline across a reload, and attaches them once it lands', async () => {
      const server = aServer();
      server.reachable = false;
      await aTab(server).add(capture('Receipts', [photo('one.png', 'first'), photo('two.png', 'second')]));
      await settled();

      const reopened = aTab(server);
      await reopened.refresh();
      expect(reopened.getShown()[0]?.files.map((file) => file.name)).toEqual(['one.png', 'two.png']);

      server.reachable = true;
      await reopened.send();
      await settled();

      const attached = [...server.attachments.values()];
      expect(attached.map(({ name, text }) => [name, text])).toEqual([
        ['one.png', 'first'],
        ['two.png', 'second'],
      ]);
      const [item] = [...server.items.values()];
      expect(attached.every((one) => one.itemId === item?.itemId)).toBe(true);
    });

    it('keeps a file waiting when its upload fails on the network, without making the note again', async () => {
      const server = aServer();
      server.uploadsReachable = false;
      const outbox = aTab(server);
      await outbox.add(capture('Receipts', [photo()]));
      await settled();

      const [waiting] = outbox.getShown();
      expect(waiting?.landed).toBe(true);
      expect(stateOf(waiting!)).toEqual({ waiting: true });

      server.uploadsReachable = true;
      await outbox.send();
      await settled();

      expect(server.captureCalls).toBe(1);
      expect([...server.attachments.values()].map((one) => one.name)).toEqual(['photo.png']);
      expect(outbox.getShown()).toEqual([]);
    });

    it('names a refused file as not sent, while the note and the other files stand', async () => {
      const server = aServer();
      server.refuseFile = 'bad.png';
      const outbox = aTab(server);
      await outbox.add(capture('Receipts', [photo('bad.png'), photo('good.png')]));
      await settled();

      expect(messages(server)).toEqual(['Receipts']);
      expect([...server.attachments.values()].map((one) => one.name)).toEqual(['good.png']);
      const [entry] = outbox.getShown();
      expect(stateOf(entry!)).toEqual({
        waiting: false,
        notSent: '"bad.png" is not a kind of file Cockpit accepts.',
      });
    });
  });

  describe('a refused capture does not hold back the ones behind it', () => {
    it('still sends the later ones', async () => {
      const server = aServer();
      server.reachable = false;
      const outbox = aTab(server);
      await outbox.add(capture('Into a deleted workspace'));
      await outbox.add(capture('Fine'));
      await settled();

      server.reachable = true;
      server.refuseCapture = {
        message: 'Into a deleted workspace',
        because: new CommandRefused(404, 'workspace ws-work not found'),
      };
      await outbox.send();
      await settled();

      expect(messages(server)).toEqual(['Fine']);
      expect(outbox.getShown().map((entry: OutboxEntry) => [entry.message, stateOf(entry)])).toEqual([
        ['Into a deleted workspace', { waiting: false, notSent: 'workspace ws-work not found' }],
      ]);
    });
  });

  describe('waiting captures belong to whoever captured them', () => {
    it('is neither sent nor shown while somebody else is signed in, and is sent once its owner is back', async () => {
      const server = aServer();
      server.reachable = false;
      const outbox = aTab(server, { owner: null });
      const { app } = anOpenApp(outbox, 'user-ada');
      await outbox.add(capture('Ring the plumber'));
      await settled();

      server.reachable = true;
      act(() => app.rerender({ who: 'user-bob' }));
      await settled();
      expect(messages(server)).toEqual([]);
      expect(outbox.getShown()).toEqual([]);
      expect(outbox.hasWaiting()).toBe(false);

      act(() => app.rerender({ who: 'user-ada' }));
      await settled();
      expect(messages(server)).toEqual(['Ring the plumber']);
    });
  });
});
