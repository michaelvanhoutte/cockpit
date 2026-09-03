import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useServerEvents } from '../../../src/api/useServerEvents';
import { diagnoseConnection } from '../../../src/api/loadFailure';

/**
 * F1: reconnection is timing and branching, and both ends are replaced — jsdom
 * has no EventSource at all, and the diagnosis would otherwise reach for the
 * network. What this cannot prove is that a real browser's EventSource, once
 * replaced, actually delivers again; that is the single F3 walk in
 * tests/e2e/liveness.test.ts.
 */
vi.mock('../../../src/api/loadFailure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/loadFailure')>()),
  diagnoseConnection: vi.fn(),
}));

const whyItStopped = vi.mocked(diagnoseConnection);

type Handler = (event: MessageEvent) => void;

/** Enough of EventSource to drive every way one can end. */
class FakeStream {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static made: FakeStream[] = [];

  readyState: number = FakeStream.CONNECTING;
  closed = false;
  #handlers = new Map<string, Handler[]>();

  constructor(readonly url: string) {
    FakeStream.made.push(this);
  }

  addEventListener(type: string, handler: Handler) {
    this.#handlers.set(type, [...(this.#handlers.get(type) ?? []), handler]);
  }

  close() {
    this.closed = true;
    this.readyState = FakeStream.CLOSED;
  }

  #fire(type: string, event: Partial<MessageEvent> = {}) {
    for (const handler of this.#handlers.get(type) ?? []) handler(event as MessageEvent);
  }

  /** The connection is established. */
  comesUp() {
    this.readyState = FakeStream.OPEN;
    this.#fire('open');
  }

  /** Refused outright: the browser gives up and will not try again. */
  refusedForGood() {
    this.readyState = FakeStream.CLOSED;
    this.#fire('error');
  }

  /** Dropped: the browser is already retrying by itself. */
  droppedAndRetrying() {
    this.readyState = FakeStream.CONNECTING;
    this.#fire('error');
  }

  /** Something changed, pushed down the stream. */
  announces(change: unknown) {
    this.#fire('change', { data: JSON.stringify(change) } as Partial<MessageEvent>);
  }
}

function Listening() {
  useServerEvents();
  return null;
}

let client: QueryClient;

function open() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The workspace snapshot, because that is what WorkspacePage renders and what
  // therefore has somewhere to show a failure. The workspace *list* is read by
  // Layout, which takes no error and would swallow it.
  client.setQueryData(['snapshot', 'ws-work'], { items: [] });
  client.setQueryData(['workspaces'], { workspaces: [] });
  // And who is signed in, which is what the app shell watches to decide whether
  // to send the browser to the logon page.
  client.setQueryData(['me'], { user: { id: 'user-michael', name: 'Michael' } });
  render(
    <QueryClientProvider client={client}>
      <Listening />
    </QueryClientProvider>,
  );
}

/** Refuse the newest connection and let the diagnosis settle. */
async function refuseTheConnection() {
  FakeStream.made.at(-1)!.refusedForGood();
  await vi.advanceTimersByTimeAsync(0);
}

const madeSoFar = () => FakeStream.made.length;

beforeEach(() => {
  FakeStream.made = [];
  whyItStopped.mockReset();
  whyItStopped.mockResolvedValue('offline');
  vi.stubGlobal('EventSource', FakeStream);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Offline', () => {
  describe('Cockpit keeps listening for changes after the connection is refused', () => {
    it('makes a new connection once the browser has given up on the old one', async () => {
      open();
      expect(madeSoFar()).toBe(1);

      await refuseTheConnection();
      await vi.advanceTimersByTimeAsync(2_999);
      expect(madeSoFar()).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(madeSoFar()).toBe(2);
    });

    it('waits longer after each refusal, up to a ceiling', async () => {
      open();

      const waits = [3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000];
      for (const [attempt, wait] of waits.entries()) {
        await refuseTheConnection();
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(madeSoFar(), `still waiting ${wait}ms after refusal ${attempt + 1}`).toBe(attempt + 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(madeSoFar(), `reconnected after ${wait}ms`).toBe(attempt + 2);
      }
    });

    it('goes back to the short wait once a connection has come up again', async () => {
      open();
      await refuseTheConnection();
      await vi.advanceTimersByTimeAsync(3_000); // second connection

      FakeStream.made.at(-1)!.comesUp();
      await refuseTheConnection();

      await vi.advanceTimersByTimeAsync(2_999);
      expect(madeSoFar()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(madeSoFar()).toBe(3);
    });

    it('leaves a connection the browser is still retrying by itself alone', async () => {
      open();

      FakeStream.made.at(-1)!.droppedAndRetrying();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(madeSoFar()).toBe(1);
      expect(FakeStream.made[0]!.closed).toBe(false);
    });
  });

  describe('losing the connection says so instead of going quiet', () => {
    const situations = [
      { situation: 'Cockpit itself says this browser is not signed in', why: 'signed-out', reReads: true },
      {
        // A stopped stream reports no status, so nothing here can tell a
        // sign-in that went from a request that vanished. Re-reading is the
        // only way either of them ever gets said out loud, so anything that is
        // not plainly a dead connection has to cause one.
        situation: 'something answers and the stream still stopped',
        why: 'trouble',
        reReads: true,
      },
      { situation: 'nothing can be reached at all', why: 'offline', reReads: false },
    ] as const;

    it.each(situations)('$situation', async ({ why, reReads }) => {
      whyItStopped.mockResolvedValue(why);
      open();

      await refuseTheConnection();

      expect(client.getQueryState(['snapshot', 'ws-work'])?.isInvalidated ?? false).toBe(reReads);
      // Who is signed in as well, because that is what the shell watches: the
      // snapshot puts the reason on screen, this is what sends the browser to
      // the logon page when the answer is that nobody is.
      expect(client.getQueryState(['me'])?.isInvalidated ?? false).toBe(reReads);
    });
  });
});

describe('Workspace management', () => {
  describe('a workspace made or deleted in another tab reaches this one without a reload', () => {
    /**
     * One case, not two. Deleting takes the identical path - a change arrives,
     * the list is re-read - because the event says only "something changed"
     * and nothing here branches on what it was. A second case would be the
     * same data through the same query, and would go red and green with this
     * one for the same reasons.
     */
    it('re-reads the workspaces you have when a change arrives', async () => {
      open();
      const stream = FakeStream.made.at(-1)!;
      stream.comesUp();

      // A workspace announces itself on itself, and this tab has never heard
      // of it - so nothing but re-reading the list can bring it into the tabs.
      stream.announces({ type: 'snapshot_invalidated', workspaceId: 'ws-made-elsewhere' });
      await vi.advanceTimersByTimeAsync(0);

      expect(client.getQueryState(['workspaces'])?.isInvalidated ?? false).toBe(true);
    });
  });
});
