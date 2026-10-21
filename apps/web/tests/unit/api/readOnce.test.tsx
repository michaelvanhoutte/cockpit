import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { ACCOUNT_WIDE, type WorkspaceSnapshot } from '@cockpit/shared';
import { snapshotQuery, useSendCommand } from '../../../src/api/queries';
import { useChangeConnection } from '../../../src/api/sourceAccounts';
import { useChangeSentence } from '../../../src/rememberedSentences';
import { fetchSnapshot, sendCommand } from '../../../src/api/client';
import { useServerEvents } from '../../../src/api/useServerEvents';
import { changes } from '../../../src/api/changes';

/**
 * F1: when a tab reads its Workspace again after changing it, with the stream
 * and both ends of the wire replaced. Which read is made, when, and whether one
 * in progress survives is decided by the tab alone; whether a real browser's
 * stream delivers is the F3 walk in tests/e2e/liveness.test.ts.
 *
 * Every read and every answer is a promise left open until the test settles it,
 * so "during a read" and "before the answer" are positions in the test and not
 * races.
 */
vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
  sendCommand: vi.fn(),
}));

const reads = vi.mocked(fetchSnapshot);
const sends = vi.mocked(sendCommand);

type Handler = (event: MessageEvent) => void;

class FakeStream {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static made: FakeStream[] = [];
  readyState: number = FakeStream.CONNECTING;
  #handlers = new Map<string, Handler[]>();

  constructor(readonly url: string) {
    FakeStream.made.push(this);
  }
  addEventListener(type: string, handler: Handler) {
    this.#handlers.set(type, [...(this.#handlers.get(type) ?? []), handler]);
  }
  close() {
    this.readyState = FakeStream.CLOSED;
  }
  announces(change: unknown) {
    for (const handler of this.#handlers.get('change') ?? []) {
      handler({ data: JSON.stringify(change) } as MessageEvent);
    }
  }
}

const WORKSPACE = 'ws-work';
const ITEM = '11111111-1111-7111-8111-000000000001';

/** Times as the account's store stamps them, one second apart. */
const at = (second: number) => `2026-10-21T10:00:${String(second).padStart(2, '0')}.000Z`;

/** What a read answers with: labelled, so a test can tell which read the screen is showing. */
const copy = (label: string, upTo?: string) =>
  ({ workspace: { id: WORKSPACE }, items: [], filings: [], panels: [], generatedAt: label, upTo }) as unknown as WorkspaceSnapshot;

const readsOpen: ((answer: WorkspaceSnapshot) => void)[] = [];
const answersOpen: ((stamp: string | undefined) => void)[] = [];
let sendNow: ReturnType<typeof useSendCommand>;
let sendConnection: ReturnType<typeof useChangeConnection>;
let sendSentence: ReturnType<typeof useChangeSentence>;

function Screen() {
  useServerEvents();
  sendNow = useSendCommand();
  sendConnection = useChangeConnection();
  sendSentence = useChangeSentence();
  const { data } = useQuery(snapshotQuery(WORKSPACE));
  return <p>{data ? `showing ${data.generatedAt}` : 'still loading'}</p>;
}

const stream = () => FakeStream.made.at(-1)!;
const announce = (second: number) =>
  act(() => stream().announces({ type: 'snapshot_invalidated', workspaceId: WORKSPACE, at: at(second) }));

/** The Nth read the tab has started (1-based), waited for. */
const readsMade = () => reads.mock.calls.length;
const answerRead = (label: string, upTo?: string) => act(async () => readsOpen.at(-1)!(copy(label, upTo)));

let priority = 0;
/** A change of the Item, sent now; resolves with the server's answer. */
function change() {
  priority += 1;
  return sendNow({
    name: 'set_priority',
    payload: {
      commandId: `c-${priority}`,
      issuedAt: at(0),
      workspaceId: WORKSPACE,
      itemId: ITEM,
      priority: priority % 2 === 0 ? 'high' : 'low',
    },
  });
}
/** The server answers the oldest change it is holding. */
const answerChange = (stamp: string | undefined) => act(async () => answersOpen.shift()!(stamp));
const settle = () => act(async () => {});

let client: QueryClient;

async function openWithCopy() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Screen />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(readsMade()).toBe(1));
  await answerRead('the first read', at(1));
  await screen.findByText('showing the first read');
  stream().readyState = FakeStream.OPEN;
}

beforeEach(() => {
  FakeStream.made = [];
  readsOpen.length = 0;
  answersOpen.length = 0;
  priority = 0;
  reads.mockReset();
  sends.mockReset();
  reads.mockImplementation(
    () =>
      new Promise<WorkspaceSnapshot>((resolve) => {
        readsOpen.push(resolve);
      }),
  );
  sends.mockImplementation(
    (_name, _payload) =>
      new Promise((resolve) => {
        answersOpen.push((stamp) => resolve({ ok: true, applied: true, ...(stamp ? { at: stamp } : {}) }));
      }),
  );
  vi.stubGlobal('EventSource', FakeStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
  changes.forgetAnswered();
});

describe('Live updates', () => {
  describe('a tab reads once for its own changes, never twice', () => {
    it('reads after the answer and skips its own announcement', async () => {
      await openWithCopy();

      const sent = change();
      await waitFor(() => expect(answersOpen).toHaveLength(1));
      await answerChange(at(2));
      await sent;
      await waitFor(() => expect(readsMade()).toBe(2));

      // Its own change is announced while that read is still on its way.
      announce(2);
      await settle();
      expect(readsMade()).toBe(2);

      await answerRead('the read after the change', at(2));
      await screen.findByText('showing the read after the change');
      await settle();
      expect(readsMade()).toBe(2);
    });

    it('reads once more for a change made on another device, announced while it reads', async () => {
      await openWithCopy();
      const sent = change();
      await waitFor(() => expect(answersOpen).toHaveLength(1));
      await answerChange(at(2));
      await sent;
      await waitFor(() => expect(readsMade()).toBe(2));

      // Later than anything this tab stored, so the read on its way cannot have it.
      announce(3);
      await settle();
      expect(readsMade()).toBe(2);
      await answerRead('the read after the change', at(2));

      await waitFor(() => expect(readsMade()).toBe(3));
      await answerRead('the read for the other device', at(3));
      await screen.findByText('showing the read for the other device');
      expect(readsMade()).toBe(3);
    });

    it('reads nothing more when its own announcement started the read the answer found on its way', async () => {
      await openWithCopy();
      const sent = change();
      await waitFor(() => expect(answersOpen).toHaveLength(1));

      // The announcement beats the answer, as a poll landing between the two does.
      announce(2);
      await waitFor(() => expect(readsMade()).toBe(2));
      await answerChange(at(2));
      await sent;
      await settle();
      await answerRead('the read the announcement started', at(2));
      await screen.findByText('showing the read the announcement started');
      await settle();

      expect(readsMade()).toBe(2);
    });

    it('does not mark the copy out of date for the one more read behind its own change', async () => {
      await openWithCopy();
      announce(2);
      await waitFor(() => expect(readsMade()).toBe(2));
      const sent = change();
      await waitFor(() => expect(answersOpen).toHaveLength(1));
      await answerChange(at(3));
      await sent;
      await answerRead('a read that began before the answer', at(2));
      await waitFor(() => expect(readsMade()).toBe(3));

      // A filing made now builds on the copy held, without waiting for the read.
      expect(client.getQueryState(snapshotQuery(WORKSPACE).queryKey)?.isInvalidated).toBe(false);
      await answerRead('the read after the change', at(3));
    });

    it('does not read a Workspace for a connection change', async () => {
      await openWithCopy();

      const sent = sendConnection({
        name: 'set_connection_choice',
        payload: { commandId: 'c-conn', issuedAt: at(0), workspaceId: WORKSPACE },
      } as unknown as Parameters<typeof sendConnection>[0]);
      await waitFor(() => expect(answersOpen).toHaveLength(1));
      await answerChange(at(2));
      await sent;
      await settle();

      expect(readsMade()).toBe(1);
    });

    it('does not read a Workspace for a sentence change', async () => {
      await openWithCopy();

      const sent = sendSentence({
        name: 'remember_sentence',
        // Naming the Workspace, as a sentence kept for one does: it is still no Workspace's change.
        payload: { commandId: 'c-sentence', issuedAt: at(0), workspaceId: WORKSPACE },
      } as unknown as Parameters<typeof sendSentence>[0]);
      await waitFor(() => expect(answersOpen).toHaveLength(1));
      await answerChange(at(2));
      await sent;
      await settle();

      expect(readsMade()).toBe(1);
    });

    it('reads as before when the answer gave no time, as an older server does', async () => {
      await openWithCopy();
      const sent = change();
      await waitFor(() => expect(answersOpen).toHaveLength(1));
      await answerChange(undefined);
      await sent;
      await waitFor(() => expect(readsMade()).toBe(2));
      await answerRead('the read after the change', at(1));
      await screen.findByText('showing the read after the change');

      announce(2);

      await waitFor(() => expect(readsMade()).toBe(3));
    });
  });

  describe('an announcement never cancels a read in progress', () => {
    it('lets the read finish and is shown, and reads once more however many arrive', async () => {
      await openWithCopy();

      announce(2);
      await waitFor(() => expect(readsMade()).toBe(2));
      announce(3);
      announce(4);
      await settle();
      expect(readsMade()).toBe(2);

      // The read in progress is the one that lands, and is what the screen shows.
      await answerRead('the read already on its way', at(2));
      await screen.findByText('showing the read already on its way');

      await waitFor(() => expect(readsMade()).toBe(3));
      await answerRead('the one more read', at(4));
      await screen.findByText('showing the one more read');
      await settle();
      expect(readsMade()).toBe(3);
    });

    it.each([
      { held: 'every copy holds it', second: 1, readsAfter: 1 },
      { held: 'a copy does not hold it yet', second: 2, readsAfter: 2 },
    ])('reads every Workspace for an account-wide announcement only where $held', async ({ second, readsAfter }) => {
      await openWithCopy();

      act(() => stream().announces({ type: 'snapshot_invalidated', workspaceId: ACCOUNT_WIDE, at: at(second) }));
      await settle();

      expect(readsMade()).toBe(readsAfter);
    });

    it('reads nothing more when the read that landed already holds what was announced', async () => {
      await openWithCopy();
      announce(2);
      await waitFor(() => expect(readsMade()).toBe(2));
      announce(3);

      await answerRead('a read that began after both changes', at(3));
      await screen.findByText('showing a read that began after both changes');
      await settle();

      expect(readsMade()).toBe(2);
    });
  });

  describe('a burst of changes is read back once', () => {
    it('reads once, when the last of five is answered', async () => {
      await openWithCopy();

      const sent = [change(), change(), change(), change(), change()];
      for (let n = 1; n <= 5; n++) {
        await waitFor(() => expect(answersOpen).toHaveLength(1));
        await answerChange(at(1 + n));
        // Its announcement arrives while the others are still going out.
        announce(1 + n);
        await settle();
        if (n < 5) expect(readsMade()).toBe(1);
      }
      await Promise.all(sent);

      await waitFor(() => expect(readsMade()).toBe(2));
      await answerRead('the read after the burst', at(6));
      await screen.findByText('showing the read after the burst');
      await settle();
      expect(readsMade()).toBe(2);
    });

    it('still reads when a long burst empties, and reads meanwhile for a change made elsewhere', async () => {
      await openWithCopy();
      const sent = [change(), change(), change()];
      await waitFor(() => expect(answersOpen).toHaveLength(1));
      await answerChange(at(2));
      await waitFor(() => expect(answersOpen).toHaveLength(1));

      // Another device's change, announced with two of this tab's still to go.
      announce(9);
      await waitFor(() => expect(readsMade()).toBe(2));
      await answerRead('the read for the other device', at(9));
      await screen.findByText('showing the read for the other device');

      await answerChange(at(10));
      await waitFor(() => expect(answersOpen).toHaveLength(1));
      await answerChange(at(11));
      await Promise.all(sent);

      await waitFor(() => expect(readsMade()).toBe(3));
      await answerRead('the read after the burst', at(11));
      await screen.findByText('showing the read after the burst');
      expect(readsMade()).toBe(3);
    });
  });
});
