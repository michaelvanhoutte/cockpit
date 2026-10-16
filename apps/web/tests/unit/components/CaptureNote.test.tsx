import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MAX_ATTACHMENT_SIZE } from '@cockpit/shared';
import { CommandRefused, sendCommand, uploadAttachment } from '../../../src/api/client';
import {
  CaptureNote,
  NO_WORKSPACE,
  RECORDING_NOT_TRANSCRIBED,
  RECORDING_WAITING_FOR_WORDS,
  STILL_LISTED,
  pasteKeyFor,
} from '../../../src/components/CaptureNote';
import { dueDateLabel } from '../../../src/dueDate';
import {
  CaptureOutbox,
  OutboxProvider,
  browserOutboxStore,
  inTabLock,
  serverSender,
  type Lock,
  type OutboxStore,
} from '../../../src/captureOutboxSender';
import {
  KeptRecordings,
  KeptRecordingsProvider,
  browserRecordingStore,
  type KeptRecording,
  type RecordingStore,
} from '../../../src/keptRecordings';
import { forgetEverything } from '../../../src/session/forget';
import { DICTATION_BLOCKED, DICTATION_NO_MICROPHONE } from '../../../src/dictation';
import {
  DICTATION_COULD_NOT_TRANSCRIBE,
  DICTATION_KEPT_TO_RETRY,
  DICTATION_TOO_MANY,
  DICTATION_STOPPED_AT_THE_LIMIT,
  type StartRecording,
} from '../../../src/recording';
import { aRecorder, aTranscriber } from '../support/recording';
import { whatArrived, type Arrived } from '../../../src/shares';
import { aShare, aSharedPhoto } from '../support/shares';
import { deviceIsIn } from '../support/timeZone';

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  sendCommand: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
  uploadAttachment: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
}));

/**
 * F1: the page is chips, a box and a list, and every rule here is what it sends
 * and what it then shows. Nothing needs a browser - that a note captured
 * without a workspace really does turn up in every workspace's Inbox is a
 * query, proved against a real store in
 * apps/api/tests/integration/http/panel-items.test.ts, and the walk from the
 * header to the Inbox is tests/e2e/workspace-capture.test.ts.
 *
 * The API client is what is replaced, and IndexedDB is a fake one, so what
 * capturing does is the real outbox sending through the real sender
 * (`captureOutboxSender.tsx`); "reloaded" is the form drawn again over the same
 * stored outbox. When the outbox goes, and what it does with each answer, is
 * tests/unit/captureOutboxSender.test.tsx. Where the outbox cannot be written,
 * capture sends directly through `useCapture`, which is why `useCommand` is
 * replaced as well.
 */
const held = vi.hoisted(() => ({
  mutate: vi.fn(),
  /** The workspaces the account holds, which another tab can delete one of. */
  workspaces: [] as unknown[],
  /** The snapshot each workspace answers with; one left out is a workspace never read, which fails as offline does. */
  snapshots: {} as Record<string, unknown>,
  /** What a capture is refused with, if it is. */
  refuses: null as Error | null,
  /**
   * Held rather than answered on the spot, for a test that needs the request
   * still in flight - `isPending` follows this, and `settle()` answers it
   * with whatever `refuses` says at the time.
   */
  pending: false,
  settle: () => {},
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: held.mutate, isPending: held.pending }),
  /** What a Panel made from File on is sent with: the client, as the real one sends through it. */
  useSendCommand: () => (args: { name: string; payload: unknown }) => sendCommand(args.name as never, args.payload as never),
  refusalFrom: ({ error }: { error: unknown }) =>
    error instanceof CommandRefused ? error.message : error ? 'That did not reach the server. Try again.' : null,
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () => Promise.resolve({ workspaces: held.workspaces }),
  },
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () =>
      held.snapshots[workspaceId] ? Promise.resolve(held.snapshots[workspaceId]) : Promise.reject(new Error('offline')),
  }),
}));


const WORK = { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5' };
const HOME = { id: 'ws-home', tenantId: 'tenant', name: 'Home', color: '#3f8f78' };

/** What File on can offer: Work has two Dashboards, a Panel of text and a Filter that are never offered; Home has one Panel. */
const aPanelOf = (id: string, name: string, dashboardId: string, kind: 'items' | 'text' | 'filter' = 'items') => ({
  id,
  name,
  dashboardId,
  kind,
});
const WORK_SNAPSHOT = {
  dashboards: [
    { id: 'd-today', name: 'Today' },
    { id: 'd-later', name: 'Later' },
  ],
  panels: [
    aPanelOf('p-falcon', 'Falcon', 'd-today'),
    aPanelOf('p-notes', 'Notes', 'd-today', 'text'),
    aPanelOf('p-overdue', 'Overdue', 'd-today', 'filter'),
    aPanelOf('p-reading', 'Reading list', 'd-later'),
  ],
};
const HOME_SNAPSHOT = {
  dashboards: [{ id: 'd-house', name: 'House' }],
  panels: [aPanelOf('p-garden', 'Garden', 'd-house')],
};

/**
 * The page, with a workspace already remembered as
 * the one you came from - which is what a capture that names no workspace is
 * recorded against (`lastVisited.ts`).
 */
/**
 * Every outbox a case made. Each keeps a retry timer and the signed-in owner
 * alive after its case ends, and sends into whatever case is running by then:
 * a slower case, such as one waiting on the formatted editor, then saw an
 * earlier case's capture as its own.
 */
const everyOutbox: CaptureOutbox[] = [];
afterEach(() => {
  for (const outbox of everyOutbox.splice(0)) outbox.signedInAs(null);
});

async function thePage({
  cameFrom = 'ws-home',
  startsIn = null,
  heldMutation = false,
  store = browserOutboxStore(),
  dictating,
  arrived,
  onPutOn,
  onCaptured,
  recordingStore = browserRecordingStore(),
  recordingLock = inTabLock(),
  waitingRecordings = [],
  signedInAs = 'user-michael',
}: {
  /** Where recordings not yet transcribed are kept: the fake IndexedDB, unless a case says storage is unavailable. */
  recordingStore?: RecordingStore;
  /** The lock every tab takes, shared by two pages drawn as two tabs. */
  recordingLock?: Lock;
  /** Recordings already kept on this device when the page opens. */
  waitingRecordings?: KeptRecording[];
  /** Who is signed in on the device. */
  signedInAs?: string;
  cameFrom?: string;
  /** The workspace Where starts on, or null for *Any workspace*. */
  startsIn?: string | null;
  /**
   * True for a test that needs a capture still in flight - `busy` (and
   * `held.pending`) stays true until the test calls `held.settle()`, which
   * answers with whatever `held.refuses` says at that moment.
   */
  heldMutation?: boolean;
  /** Where the outbox is kept: the fake IndexedDB, unless a case says storage is unavailable. */
  store?: OutboxStore;
  /** What the browser records with and the Worker transcribes with; no recorder, as in a browser that cannot record. */
  dictating?: {
    record?: StartRecording | null;
    transcribe?: (recording: Blob) => Promise<string>;
    transcriber?: boolean;
    limitSeconds?: number;
  };
  /** What the share sheet handed over, as the page claimed it. */
  arrived?: Arrived | null;
  onPutOn?: () => void;
  onCaptured?: () => void;
} = {}) {
  held.workspaces = [WORK, HOME];
  held.snapshots = { 'ws-work': WORK_SNAPSHOT, 'ws-home': HOME_SNAPSHOT };
  held.refuses = null;
  held.pending = false;
  held.settle = () => {};
  localStorage.clear();
  localStorage.setItem('cockpit.last-visited.workspace', cameFrom);

  // The real mutation calls back: `onSuccess` is what lists what was captured,
  // and `onError` is what puts the note back and says why.
  held.mutate = vi.fn(
    (_args, options?: { onSuccess?: () => void; onError?: (e: Error) => void }) => {
      const answer = () => {
        held.pending = false;
        if (held.refuses) options?.onError?.(held.refuses);
        else options?.onSuccess?.();
      };
      if (heldMutation) {
        held.pending = true;
        held.settle = answer;
      } else {
        answer();
      }
    },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outbox = new CaptureOutbox({
    store,
    sender: serverSender,
    lock: inTabLock(),
    online: () => true,
    timeoutMs: 500,
  });
  outbox.signedInAs('user-michael');
  everyOutbox.push(outbox);
  for (const one of waitingRecordings) await recordingStore.put(one);
  const kept = new KeptRecordings({ store: recordingStore, lock: recordingLock });
  kept.signedInAs(signedInAs);
  const page = render(
    <QueryClientProvider client={client}>
      <OutboxProvider value={outbox}>
        <KeptRecordingsProvider value={kept}>
          <CaptureNote startsIn={startsIn} dictating={dictating} arrived={arrived} onPutOn={onPutOn} onCaptured={onCaptured} />
        </KeptRecordingsProvider>
      </OutboxProvider>
    </QueryClientProvider>,
  );
  // Nothing to choose from until the workspaces arrive.
  await screen.findByRole('button', { name: 'Work' });
  return Object.assign(userEvent.setup(), { client, outbox, kept, unmount: page.unmount, container: page.container });
}

/** Storage that refuses everything: a private window, or a full disk. */
const UNAVAILABLE: OutboxStore = {
  all: () => Promise.reject(new Error('unavailable')),
  put: () => Promise.reject(new Error('unavailable')),
  remove: () => Promise.reject(new Error('unavailable')),
};

/** Recording storage that refuses everything, as `UNAVAILABLE` is for the outbox. */
const RECORDINGS_UNAVAILABLE: RecordingStore = {
  all: () => Promise.reject(new Error('unavailable')),
  has: () => Promise.reject(new Error('unavailable')),
  put: () => Promise.reject(new Error('unavailable')),
  remove: () => Promise.reject(new Error('unavailable')),
};

/** The page drawn again over what the last one kept: a reload. */
async function reloaded(page: { unmount: () => void }, options: Parameters<typeof thePage>[0] = {}) {
  page.unmount();
  return thePage(options);
}

const mic = () => screen.getByRole('button', { name: 'Dictate' });

const box = () => screen.getByLabelText('What is on your mind?');
const chip = (name: string) => screen.getByRole('button', { name });
/** Every capture sent, through the outbox or directly. */
const capturedCalls = () => [
  ...vi
    .mocked(sendCommand)
    .mock.calls.filter(([name]) => name === 'capture_item')
    .map(([name, payload]) => ({ name, payload: payload as Record<string, unknown> })),
  ...held.mutate.mock.calls.map(([args]) => args).filter((args) => args.name === 'capture_item'),
];
/** The first capture sent, once it has been. */
const captured = async () => {
  await waitFor(() => expect(capturedCalls().length).toBeGreaterThan(0));
  return capturedCalls()[0]!;
};
/** Lets the outbox finish whatever it started, so "nothing was sent" is an answer. */
const settled = async () => {
  await act(async () => {
    for (let i = 0; i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
  });
};
const everythingAsked = () => [
  ...vi.mocked(sendCommand).mock.calls.map(([name]) => name),
  ...held.mutate.mock.calls.map(([args]) => args.name),
];
const justCaptured = () => screen.queryAllByRole('listitem');
/** The row of Just captured holding this note. */
const rowOf = (note: string) => {
  const row = justCaptured().find((one) => within(one).queryByText(note));
  if (!row) throw new Error(`no row for "${note}"`);
  return within(row);
};

const aPhoto = () => new File(['bytes'], 'photo.png', { type: 'image/png' });
/** Matches that file by name, since two `File`s compare equal whatever they hold. */
const aPhotoFile = expect.objectContaining({ name: 'photo.png' });
function aFile(name: string, type: string, size?: number): File {
  const file = new File(['bytes'], name, { type });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}
const carrying = (...files: File[]) => ({ dataTransfer: { types: ['Files'], files } });

describe('Capture', () => {
  beforeEach(() => {
    // A browser of its own for every case: nothing kept by the last one.
    globalThis.indexedDB = new IDBFactory();
    held.mutate.mockClear();
    vi.mocked(sendCommand).mockReset();
    vi.mocked(sendCommand).mockResolvedValue({ ok: true as const, applied: true });
    vi.mocked(uploadAttachment).mockReset();
    vi.mocked(uploadAttachment).mockResolvedValue({ ok: true as const, applied: true });
  });

  describe('the capture page writes down a note and where it goes', () => {
    it('captures against the workspace you came from, saying where it belongs is undecided', async () => {
      const user = await thePage();

      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      expect((await captured()).payload.message).toBe('Ask Ada about the backup window');
      // The workspace it was captured from is still recorded: it is an honest
      // fact, and it is what the foreign key needs.
      expect((await captured()).payload.workspaceId).toBe('ws-home');
      expect((await captured()).payload.workspaceDecided).toBe(false);
    });

    it('asks no Type, and captures without one', async () => {
      const user = await thePage();

      expect(screen.queryByRole('group', { name: 'Type' })).toBeNull();
      await user.type(box(), 'Maybe the onboarding is two screens');
      await user.click(chip('Capture'));

      expect((await captured()).payload).not.toHaveProperty('typeId');
    });

    it('captures into a workspace once one is chosen, and says that is where it belongs', async () => {
      const user = await thePage();

      await user.click(chip('Work'));
      await user.type(box(), 'Book the venue deposit');
      await user.click(chip('Capture'));

      expect((await captured()).payload.workspaceId).toBe('ws-work');
      expect((await captured()).payload.workspaceDecided).toBeUndefined();
    });

    it('starts Where on the workspace it was opened in, and captures into it as decided', async () => {
      const user = await thePage({ startsIn: 'ws-work' });

      expect(chip('Work')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('Any workspace')).toHaveAttribute('aria-pressed', 'false');
      await user.type(box(), 'Book the venue deposit');
      await user.click(chip('Capture'));

      expect((await captured()).payload.workspaceId).toBe('ws-work');
      expect((await captured()).payload.workspaceDecided).toBeUndefined();
    });

    it('holds a different workspace, once chosen, for every note captured after it', async () => {
      const user = await thePage({ startsIn: 'ws-work' });

      await user.click(chip('Home'));
      await user.type(box(), 'First for the customer');
      await user.click(chip('Capture'));
      await user.type(box(), 'Second for the customer');
      await user.click(chip('Capture'));

      await waitFor(() => expect(capturedCalls()).toHaveLength(2));
      expect(capturedCalls().map(({ payload }) => payload.workspaceId)).toEqual(['ws-home', 'ws-home']);
    });

    it('falls back to Any workspace when the one chosen is deleted in another tab', async () => {
      const user = await thePage();
      await user.click(chip('Work'));

      // Deleted elsewhere, and this page finds out the way every screen does -
      // the list it is drawn from comes back without it.
      held.workspaces = [HOME];
      await user.client.invalidateQueries({ queryKey: ['workspaces'] });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Work' })).toBeNull());

      // Which is what the row now says, rather than nothing being chosen.
      expect(chip('Any workspace')).toHaveAttribute('aria-pressed', 'true');
      await user.type(box(), 'Where does this go');
      await user.click(chip('Capture'));

      expect((await captured()).payload.workspaceId).toBe('ws-home');
      expect((await captured()).payload.workspaceDecided).toBe(false);
    });

    /**
     * The one *chosen* is the case above; this is the one it is captured
     * **from**, which nobody chose and which the page falls back for in the
     * same way (`workspaceToCaptureFrom`).
     *
     * Reachable while you sit on this page: deleting a workspace that is
     * neither the last nor the screen behind you leaves you here on purpose
     * (components/ManageWorkspaces.tsx), and the list comes back without it.
     * A page holding the deleted one would read a snapshot that is a 404 for
     * good, so the note would go in silence - which is what this whole change
     * exists to stop.
     */
    it('captures against a workspace that is still there when the one it came from is deleted', async () => {
      const user = await thePage({ cameFrom: 'ws-home' });

      held.workspaces = [WORK];
      await user.client.invalidateQueries({ queryKey: ['workspaces'] });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Home' })).toBeNull());

      await user.type(box(), 'Where does this go');
      await user.keyboard('{Control>}{Enter}{/Control}');

      expect((await captured()).payload.workspaceId).toBe('ws-work');
      expect((await captured()).payload.workspaceDecided).toBe(false);
    });

    it('captures nothing at all for an empty note', async () => {
      const user = await thePage();

      await user.click(chip('Capture'));

      await settled();
      expect(capturedCalls()).toEqual([]);
    });

    it('captures on the key under the hand, without reaching for the button', async () => {
      const user = await thePage();

      await user.type(box(), 'Two lines{Shift>}{Enter}{/Shift}and a second');
      await user.keyboard('{Control>}{Enter}{/Control}');

      expect((await captured()).payload.message).toBe('Two lines\nand a second');
    });
  });

  /**
   * "Keep a capture made offline, and send it once a connection gets
   * through" (issue 610). Capture never waits on the network: the box empties
   * once the note is kept on this device, and nothing the server or the
   * connection does afterwards puts it in danger.
   */
  describe('a capture is kept from the moment Capture is pressed until it lands, or until you confirm signing out', () => {
    it('empties the box once the note is kept', async () => {
      const user = await thePage();

      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      await waitFor(() => expect(box()).toHaveValue(''));
    });

    it.each([
      { situation: 'captured with no connection', answer: () => Promise.reject(new TypeError('Failed to fetch')) },
      { situation: 'the send times out', answer: () => new Promise<never>(() => {}) },
      {
        situation: 'a server error',
        answer: () => Promise.reject(new CommandRefused(503, 'capture_item failed: 503')),
      },
    ])('empties the box and reads Waiting to send when $situation', async ({ answer }) => {
      vi.mocked(sendCommand).mockImplementation(answer);
      const user = await thePage();

      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      await waitFor(() => expect(box()).toHaveValue(''));
      await waitFor(() =>
        expect(rowOf('Ask Ada about the backup window').getByText('Waiting to send')).toBeVisible(),
      );
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('is still waiting after the page is reloaded before it sends', async () => {
      vi.mocked(sendCommand).mockRejectedValue(new TypeError('Failed to fetch'));
      const user = await thePage();
      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));
      await screen.findByText('Waiting to send');

      await reloaded(user);

      expect(
        await screen.findByText('Ask Ada about the backup window', {}, { timeout: 2_000 }),
      ).toBeVisible();
      expect(rowOf('Ask Ada about the backup window').getByText('Waiting to send')).toBeVisible();
    });

    /**
     * An expired sign-in sends you to the logon page, which empties the
     * browser of everything the last visit held (`session/forget.ts`) - and a
     * waiting capture is not the visit's, it is the person's.
     */
    it('is still waiting after the sign-in expired and the logon page emptied the browser', async () => {
      vi.mocked(sendCommand).mockRejectedValue(new CommandRefused(401, 'not signed in'));
      const user = await thePage();
      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));
      await screen.findByText('Waiting to send');

      await forgetEverything(user.client);
      await reloaded(user);

      expect(await screen.findByText('Waiting to send', {}, { timeout: 2_000 })).toBeVisible();
      expect(rowOf('Ask Ada about the backup window').getByText('Waiting to send')).toBeVisible();
    });

    it('takes a second capture at once while the first is still sending, and both wait', async () => {
      vi.mocked(sendCommand).mockImplementation(() => new Promise(() => {}));
      const user = await thePage();

      await user.type(box(), 'The first one');
      await user.click(chip('Capture'));
      await waitFor(() => expect(box()).toHaveValue(''));
      await user.type(box(), 'The second one');
      await user.click(chip('Capture'));

      await waitFor(() => expect(box()).toHaveValue(''));
      await waitFor(() => expect(screen.getAllByText('Waiting to send')).toHaveLength(2));
    });

    /** Inferred: a private window, or storage refused, still captures - the old way. */
    it.each([
      { situation: 'the server takes it', refuses: null, box: '', alert: null },
      {
        situation: 'there is no connection',
        refuses: new TypeError('Failed to fetch'),
        box: 'Ask Ada about the backup window',
        alert: 'That did not reach the server. Try again.',
      },
    ])('sends directly where nothing can be kept on this device, and $situation', async ({ refuses, box: left, alert }) => {
      const user = await thePage({ store: UNAVAILABLE });
      held.refuses = refuses;

      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      expect((await captured()).payload.message).toBe('Ask Ada about the backup window');
      await waitFor(() => expect(box()).toHaveValue(left));
      if (alert) expect(screen.getByRole('alert')).toHaveTextContent(alert);
      else expect(await screen.findByText('now')).toBeVisible();
    });
  });

  /**
   * The server refusing a capture is the one thing that stops it, and the
   * row says why rather than the note going quietly: its workspace deleted
   * elsewhere while it waited.
   */
  describe('a waiting capture the server refuses says why and can be put back', () => {
    it.each([
      { situation: 'its workspace was deleted meanwhile', because: 'workspace ws-work not found' },
    ])('reads Not sent with the reason when $situation, and Put back returns the note and its file', async ({ because }) => {
      vi.mocked(sendCommand).mockRejectedValue(new CommandRefused(404, because));
      const user = await thePage();
      await user.click(chip('Work'));
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      expect(await screen.findByText(`Not sent: ${because}`)).toBeVisible();
      expect(uploadAttachment).not.toHaveBeenCalled();
      // Chosen afresh before putting it back, so what comes back is visibly the capture's.
      await user.click(chip('Any workspace'));
      await user.click(rowOf('Ask Ada about the backup window').getByRole('button', { name: 'Put back' }));

      expect(box()).toHaveValue('Ask Ada about the backup window');
      expect(screen.getByText('photo.png')).toBeVisible();
      expect(chip('Work')).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(screen.queryByText('Just captured')).toBeNull());
      expect(user.outbox.getShown()).toEqual([]);
    });

    it('lists a note spoken in the Car view as a recording waiting for its words, until it can be transcribed', async () => {
      // The Worker cannot be reached, so its words stay to be had.
      vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
      const store = browserOutboxStore();
      await store.put({
        v: 2,
        id: '01900000-0000-7000-8000-000000000001',
        owner: 'user-michael',
        commandId: '01900000-0000-7000-8000-000000000002',
        capturedAt: new Date().toISOString(),
        workspaceId: 'ws-home',
        decided: false,
        message: '',
        files: [],
        recording: { type: 'audio/webm', bytes: new ArrayBuffer(5), seconds: 3, transcribed: false },
        landed: false,
        refused: null,
      });

      await thePage({ store });

      const row = await screen.findByText(RECORDING_WAITING_FOR_WORDS);
      expect(row.closest('li')).toHaveTextContent('Waiting to send');
      vi.unstubAllGlobals();
    });

    it('puts back a spoken note refused before its words came back as its recording, kept with Retry', async () => {
      const store = browserOutboxStore();
      await store.put({
        v: 2,
        id: '01900000-0000-7000-8000-000000000001',
        owner: 'user-michael',
        commandId: '01900000-0000-7000-8000-000000000002',
        capturedAt: new Date().toISOString(),
        workspaceId: 'ws-home',
        decided: false,
        message: '',
        files: [],
        recording: { type: 'audio/webm', bytes: new ArrayBuffer(5), seconds: 3, transcribed: false },
        landed: false,
        refused: 'The recording could not be transcribed (415).',
      });
      const user = await thePage({ store });
      await user.type(box(), 'Half a thought');

      await user.click(rowOf(RECORDING_NOT_TRANSCRIBED).getByRole('button', { name: 'Put back' }));

      expect(await screen.findByText('A recording of 0:03, not yet transcribed')).toBeVisible();
      expect(box()).toHaveValue('Half a thought');
      await waitFor(() => expect(user.outbox.getShown()).toEqual([]));
    });

    it('puts a note back once only, even where it cannot then be taken off the list', async () => {
      vi.mocked(sendCommand).mockRejectedValue(new CommandRefused(404, 'workspace ws-home not found'));
      const kept = browserOutboxStore();
      const user = await thePage({
        store: { ...kept, remove: () => Promise.reject(new Error('storage refused')) },
      });
      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));
      const putBack = await screen.findByRole('button', { name: 'Put back' });

      await user.click(putBack);

      expect(box()).toHaveValue('Ask Ada about the backup window');
      expect(await screen.findByRole('alert')).toHaveTextContent(STILL_LISTED);
      // Still listed, and with nothing left to press that would put it back twice.
      expect(rowOf('Ask Ada about the backup window').getByText(/^Not sent:/)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Put back' })).toBeNull();
    });
  });

  describe('with nothing to capture into, capture says so instead of capturing', () => {
    /**
     * The button is disabled through it, so the shortcut is the way in that
     * arrives - and it used to return having done nothing and said nothing,
     * which is "Find out why the capture-into-a-named-workspace walk fails
     * intermittently" (issue 219) itself. Said out loud rather than swallowed.
     *
     * With the last workspace gone there
     * is nowhere to capture *into*, and nothing is being read that could change
     * that - so "try that again" would be a promise nothing can keep. Reached
     * by deleting your last workspace elsewhere, since this client is only told
     * the list changed (`api/useServerEvents.ts`) and nothing sends it anywhere.
     */
    it('says there is nowhere to capture into once the last workspace is gone', async () => {
      const user = await thePage();

      held.workspaces = [];
      await user.client.invalidateQueries({ queryKey: ['workspaces'] });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Work' })).toBeNull());

      await user.type(box(), 'Book the venue deposit');
      await user.keyboard('{Control>}{Enter}{/Control}');

      await settled();
      expect(capturedCalls()).toEqual([]);
      expect(screen.getByRole('alert')).toHaveTextContent(NO_WORKSPACE);
      expect(box()).toHaveValue('Book the venue deposit');
    });
  });

  describe('what you have just captured is listed under the box, newest first', () => {
    it('says nothing at all until something has been captured', async () => {
      await thePage();

      expect(screen.queryByText('Just captured')).toBeNull();
    });

    it('lists the note with where it went and how long ago', async () => {
      const user = await thePage();

      await user.click(chip('Work'));
      await user.type(box(), 'Book the venue deposit');
      await user.click(chip('Capture'));

      const row = await waitFor(() => rowOf('Book the venue deposit'));
      expect(row.getByText('Work')).toBeInTheDocument();
      expect(await row.findByText('now')).toBeInTheDocument();
    });

    it('says a note left for later belongs to no workspace yet', async () => {
      const user = await thePage();

      await user.type(box(), 'Where does this go');
      await user.click(chip('Capture'));

      expect(await waitFor(() => rowOf('Where does this go').getByText('Any workspace'))).toBeInTheDocument();
    });

    it('puts the note just captured above the one before it', async () => {
      const user = await thePage();

      await user.type(box(), 'The first one');
      await user.click(chip('Capture'));
      await waitFor(() => expect(box()).toHaveValue(''));
      await user.type(box(), 'The second one');
      await user.click(chip('Capture'));

      await waitFor(() => expect(justCaptured()).toHaveLength(2));
      const rows = justCaptured();
      expect(within(rows[0]!).getByText('The second one')).toBeInTheDocument();
      expect(within(rows[1]!).getByText('The first one')).toBeInTheDocument();
    });

    it.each([
      { situation: 'landed', answer: () => Promise.resolve({ ok: true as const, applied: true }), reads: 'now' },
      { situation: 'waiting', answer: () => Promise.reject(new TypeError('Failed to fetch')), reads: 'Waiting to send' },
    ])('says how a capture stands once it is $situation', async ({ answer, reads }) => {
      vi.mocked(sendCommand).mockImplementation(answer);
      const user = await thePage();

      await user.type(box(), 'Book the venue deposit');
      await user.click(chip('Capture'));

      expect(await waitFor(() => rowOf('Book the venue deposit').getByText(reads))).toBeVisible();
    });

    it.each([
      { situation: 'landed', answer: () => Promise.resolve({ ok: true as const, applied: true }), reads: 'now' },
      { situation: 'waiting', answer: () => Promise.reject(new TypeError('Failed to fetch')), reads: 'Waiting to send' },
    ])('shows the words of a note written with bold once it is $situation', async ({ answer, reads }) => {
      vi.mocked(sendCommand).mockImplementation(answer);
      const user = await thePage();

      await user.type(box(), '**Ask Jan** about the audit');
      await user.click(chip('Capture'));

      const row = await waitFor(() => rowOf('Ask Jan about the audit'));
      expect(await waitFor(() => row.getByText(reads))).toBeVisible();
    });

    it('lists only what is waiting or refused after a reload, the landed ones dropping off', async () => {
      vi.mocked(sendCommand).mockImplementation((_name, payload) =>
        (payload as { message: string }).message === 'Landed'
          ? Promise.resolve({ ok: true as const, applied: true })
          : (payload as { message: string }).message === 'Refused'
            ? Promise.reject(new CommandRefused(404, 'workspace ws-home not found'))
            : Promise.reject(new TypeError('Failed to fetch')),
      );
      const user = await thePage();
      for (const note of ['Landed', 'Refused', 'Waiting']) {
        await user.type(box(), note);
        await user.click(chip('Capture'));
        await waitFor(() => expect(box()).toHaveValue(''));
      }
      await waitFor(() => expect(justCaptured()).toHaveLength(3));

      await reloaded(user);

      await waitFor(() => expect(justCaptured()).toHaveLength(2));
      expect(rowOf('Waiting').getByText('Waiting to send')).toBeVisible();
      expect(rowOf('Refused').getByText('Not sent: workspace ws-home not found')).toBeVisible();
      expect(screen.queryByText('Landed')).toBeNull();
    });
  });

  /**
   * "Drop files and paste images while capturing a message", issue 557. There
   * is no Item yet to attach to, so a file dropped or pasted waits as a chip
   * in the box until Capture makes one; what actually lands in R2 is proved
   * through the real interface in apps/api/tests/integration/http/attachments.test.ts.
   */
  describe('a file dropped or pasted anywhere on the form queues as an attachment, never as text', () => {
    it.each([
      { situation: 'the message box', target: () => box() },
      { situation: 'empty space on the form', target: () => chip('Any workspace') },
    ])('queues one dropped on $situation, highlighting the form while it is dragged over', async ({ target }) => {
      await thePage();

      fireEvent.dragOver(target(), carrying(aPhoto()));
      expect(box().closest('form')).toHaveClass('ring-accent');
      fireEvent.drop(target(), carrying(aPhoto()));

      expect(box().closest('form')).not.toHaveClass('ring-accent');
      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(uploadAttachment).not.toHaveBeenCalled();
    });

    it('queues several files dropped at once, all of them', async () => {
      await thePage();

      fireEvent.drop(box(), carrying(aPhoto(), aFile('doc.pdf', 'application/pdf')));

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(screen.getByText('doc.pdf')).toBeVisible();
    });

    it('queues a file pasted with the cursor in the message box, and writes nothing into it', async () => {
      const user = await thePage();
      await user.type(box(), 'Ask Ada');

      fireEvent.paste(box(), { clipboardData: { files: [aPhoto()], types: ['Files'], getData: () => '' } });

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(box()).toHaveValue('Ask Ada');
    });

    it('queues a file pasted with the cursor on no field', async () => {
      await thePage();

      fireEvent.paste(chip('Capture'), {
        clipboardData: { files: [aPhoto()], types: ['Files'], getData: () => '' },
      });

      expect(await screen.findByText('photo.png')).toBeVisible();
    });

    it('lets a queued chip be removed before Capture is pressed', async () => {
      const user = await thePage();
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');

      await user.click(screen.getByRole('button', { name: 'Remove photo.png' }));

      expect(screen.queryByText('photo.png')).toBeNull();
    });
  });

  /**
   * Found after shipping: the form gave no sign that dropping or pasting a
   * file was possible at all. Mirrors the Item form's own Attachments box -
   * a "Drag a file here, or" hint and an Add button, both shown whether or
   * not anything is queued yet.
   */
  describe('an Add button and a drag hint say a file can be attached, before anyone has tried', () => {
    it('always shows the drag hint and the Add button, even with nothing queued', async () => {
      await thePage();

      expect(screen.getByText('Drag a file here, or')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Add' })).toBeVisible();
    });

    it('replaces the drag hint with the chip once something is queued', async () => {
      await thePage();

      fireEvent.drop(box(), carrying(aPhoto()));

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(screen.queryByText('Drag a file here, or')).toBeNull();
    });

    it('queues a file chosen through the picker the same way a dropped one queues', async () => {
      const user = await thePage();

      await user.upload(screen.getByLabelText('Files to attach'), aPhoto());

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(uploadAttachment).not.toHaveBeenCalled();
    });

    it('queues several files chosen at once, all of them', async () => {
      const user = await thePage();

      await user.upload(screen.getByLabelText('Files to attach'), [
        aPhoto(),
        aFile('doc.pdf', 'application/pdf'),
      ]);

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(screen.getByText('doc.pdf')).toBeVisible();
    });

    it('refuses a disallowed file chosen through the picker, the same as a dropped one', async () => {
      const user = await thePage();

      await user.upload(screen.getByLabelText('Files to attach'), aFile('notes.txt', 'text/plain'));

      expect(screen.getByRole('alert')).toHaveTextContent('"notes.txt" is not a kind of file Cockpit accepts.');
      expect(screen.queryByText('notes.txt')).toBeNull();
    });
  });

  describe('a queued file is checked against the allowlist and the 25MB cap before it queues', () => {
    it('refuses an oversized file by name, and does not queue it', async () => {
      await thePage();

      fireEvent.drop(box(), carrying(aFile('huge.png', 'image/png', MAX_ATTACHMENT_SIZE + 1)));

      expect(screen.getByRole('alert')).toHaveTextContent('"huge.png" is over the 25 MB limit.');
      expect(screen.queryByText('huge.png')).toBeNull();
    });

    it('refuses a disallowed type by name, and does not queue it', async () => {
      await thePage();

      fireEvent.drop(box(), carrying(aFile('notes.txt', 'text/plain')));

      expect(screen.getByRole('alert')).toHaveTextContent('"notes.txt" is not a kind of file Cockpit accepts.');
      expect(screen.queryByText('notes.txt')).toBeNull();
    });

    it('queues the valid files in a multi-file drop even where one is refused', async () => {
      await thePage();

      fireEvent.drop(box(), carrying(aFile('notes.txt', 'text/plain'), aPhoto()));

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(screen.getByRole('alert')).toHaveTextContent('"notes.txt" is not a kind of file Cockpit accepts.');
    });
  });

  describe('queued files upload to the item only once Capture has made it', () => {
    it('clears the chip queue once Capture is pressed, before any upload resolves', async () => {
      vi.mocked(uploadAttachment).mockImplementation(() => new Promise(() => {}));
      const user = await thePage();
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'Ask Ada about the backup window');

      await user.click(chip('Capture'));

      await waitFor(() => expect(screen.queryByText('photo.png')).toBeNull());
    });

    it('sends each queued file as an attachment against the item Capture just made', async () => {
      const user = await thePage();
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'Ask Ada about the backup window');

      await user.click(chip('Capture'));

      const { payload } = await captured();
      await waitFor(() =>
        expect(uploadAttachment).toHaveBeenCalledWith(
          expect.objectContaining({ itemId: payload.itemId, workspaceId: 'ws-home', file: aPhotoFile }),
        ),
      );
    });

    it('attaches each note’s files to its own item when a second is captured while the first is still uploading', async () => {
      let resolveFirst: (value: { ok: true; applied: true }) => void = () => {};
      vi.mocked(uploadAttachment).mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve)),
      );
      const user = await thePage();

      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'First note');
      await user.click(chip('Capture'));
      await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));

      fireEvent.drop(box(), carrying(aFile('second.pdf', 'application/pdf')));
      await screen.findByText('second.pdf');
      await user.type(box(), 'Second note');
      await user.click(chip('Capture'));
      // Made at once, though the first is still out.
      await waitFor(() => expect(box()).toHaveValue(''));

      await act(async () => resolveFirst({ ok: true, applied: true }));
      await waitFor(() =>
        expect(uploadAttachment).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            itemId: capturedCalls()[1]!.payload.itemId,
            file: expect.objectContaining({ name: 'second.pdf' }),
          }),
        ),
      );
    });
  });

  describe('a refused file is named as not sent, without undoing the capture', () => {
    it('names every refused file, still attaches the others, and leaves the item captured', async () => {
      vi.mocked(uploadAttachment).mockImplementation((args) =>
        args.file.name === 'photo.png'
          ? Promise.resolve({ ok: true as const, applied: true })
          : Promise.reject(new CommandRefused(415, `"${args.file.name}" could not be attached.`)),
      );
      const user = await thePage();
      fireEvent.drop(
        box(),
        carrying(aPhoto(), aFile('one.pdf', 'application/pdf'), aFile('two.pdf', 'application/pdf')),
      );
      await screen.findByText('one.pdf');
      await user.type(box(), 'Ask Ada about the backup window');

      await user.click(chip('Capture'));

      await captured();
      const notSent = await screen.findByText(/^Not sent:/);
      expect(notSent).toHaveTextContent('"one.pdf" could not be attached.');
      expect(notSent).toHaveTextContent('"two.pdf" could not be attached.');
      expect(uploadAttachment).toHaveBeenCalledTimes(3);
      expect(capturedCalls()).toHaveLength(1);
    });

    it('puts back only the refused file, the note having landed', async () => {
      vi.mocked(uploadAttachment).mockRejectedValue(new CommandRefused(415, '"doc.pdf" could not be attached.'));
      const user = await thePage();
      fireEvent.drop(box(), carrying(aFile('doc.pdf', 'application/pdf')));
      await screen.findByText('doc.pdf');
      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      await user.click(await screen.findByRole('button', { name: 'Put back' }));

      expect(box()).toHaveValue('');
      expect(await screen.findByText('doc.pdf')).toBeVisible();
    });
  });

  /**
   * "Set a priority and a due date while capturing" (issue 611). The clock is
   * a Wednesday, the last day of September, so *Tmrw* crosses into October.
   */
  describe('one click sets a priority or a due date, and pressing the lit one again clears it', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 8, 30, 12) });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const pressed = (name: string) => chip(name).getAttribute('aria-pressed') === 'true';
    const aDate = (day: string) =>
      fireEvent.change(screen.getByLabelText('Due date'), { target: { value: day } });
    const captureANote = async (user: Awaited<ReturnType<typeof thePage>>) => {
      await user.type(box(), 'Send the invoice');
      await user.click(chip('Capture'));
    };

    it('lights one priority at a time and captures it', async () => {
      const user = await thePage();

      await user.click(chip('High priority'));
      expect([pressed('Low priority'), pressed('Normal priority'), pressed('High priority')]).toEqual([
        false,
        false,
        true,
      ]);
      await user.click(chip('Low priority'));
      expect([pressed('Low priority'), pressed('High priority')]).toEqual([true, false]);
      await captureANote(user);

      expect((await captured()).payload.priority).toBe('low');
    });

    it('clears a priority pressed while lit, and captures none', async () => {
      const user = await thePage();

      await user.click(chip('High priority'));
      await user.click(chip('High priority'));

      expect(pressed('High priority')).toBe(false);
      await captureANote(user);
      expect((await captured()).payload).not.toHaveProperty('priority');
    });

    it('lights one due shortcut at a time, sending the day it names', async () => {
      const user = await thePage();

      await user.click(chip('Tmrw'));
      expect(pressed('Tmrw')).toBe(true);
      await user.click(chip('Today'));
      expect([pressed('Today'), pressed('Tmrw')]).toEqual([true, false]);
      await user.click(chip('Tmrw'));
      await captureANote(user);

      expect((await captured()).payload.dueDate).toBe('2026-10-01');
    });

    it('offers exactly Today, Tmrw and +7d, in that order', async () => {
      await thePage();

      const offered = within(screen.getByRole('group', { name: 'Due' }))
        .getAllByRole('button', { name: /^(Today|Tmrw|Fri|\+7d)$/ })
        .map((button) => button.textContent);

      expect(offered).toEqual(['Today', 'Tmrw', '+7d']);
    });

    it('clears a due shortcut pressed while lit, and captures no due date', async () => {
      const user = await thePage();

      await user.click(chip('Tmrw'));
      await user.click(chip('Tmrw'));

      expect(pressed('Tmrw')).toBe(false);
      await captureANote(user);
      expect((await captured()).payload).not.toHaveProperty('dueDate');
    });

    it('shows a picked day that is no shortcut on the date button with a ✕, and the ✕ clears it', async () => {
      const user = await thePage();

      // The coming Friday, which *Fri* used to light.
      aDate('2026-10-02');

      expect(chip(`Due ${dueDateLabel('2026-10-02')}`)).toBeVisible();
      expect([pressed('Today'), pressed('Tmrw'), pressed('+7d')]).toEqual([false, false, false]);
      await user.click(chip('Clear the due date'));
      expect(chip('Pick a due date')).toBeVisible();
      await captureANote(user);
      expect((await captured()).payload).not.toHaveProperty('dueDate');
    });

    it('lights the shortcut a picked day happens to be', async () => {
      await thePage();

      aDate('2026-10-07');

      expect(pressed('+7d')).toBe(true);
    });

    it('lights Tmrw when tomorrow is picked in the date picker', async () => {
      await thePage();

      aDate('2026-10-01');

      expect(pressed('Tmrw')).toBe(true);
    });
  });

  /**
   * "Read a due date you say when you capture, on your own calendar" (issue
   * 1077): what Capture sends says which calendar it was made on, kept or sent
   * at once. That a kept one keeps the zone it was captured in is the outbox's
   * (tests/unit/captureOutboxSender.test.tsx).
   */
  describe('a capture says which time zone it was made in', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([
      { situation: 'kept to send', store: undefined },
      { situation: 'sent at once where nothing can be kept', store: UNAVAILABLE },
    ])('$situation', async ({ store }) => {
      deviceIsIn('Europe/Brussels');
      const user = await thePage(store ? { store } : {});

      await user.type(box(), 'Send the invoice friday');
      await user.click(chip('Capture'));

      expect((await captured()).payload).toMatchObject({ timeZone: 'Europe/Brussels' });
    });
  });
  describe('priority and due date start empty for each note, and a refused capture keeps them', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 8, 30, 12) });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('resets both once a capture lands, while Where keeps its choice', async () => {
      const user = await thePage();
      await user.click(chip('Work'));
      await user.click(chip('High priority'));
      await user.click(chip('Today'));

      await user.type(box(), 'Send the invoice');
      await user.click(chip('Capture'));

      expect((await captured()).payload).toMatchObject({ priority: 'high', dueDate: '2026-09-30' });
      await waitFor(() => expect(chip('High priority')).toHaveAttribute('aria-pressed', 'false'));
      expect(chip('Today')).toHaveAttribute('aria-pressed', 'false');
      expect(chip('Work')).toHaveAttribute('aria-pressed', 'true');
    });

    it('keeps the note, the priority and the due date when a direct capture is refused', async () => {
      const user = await thePage({ store: UNAVAILABLE });
      held.refuses = new CommandRefused(404, 'That workspace is gone.');
      await user.click(chip('Normal priority'));
      await user.click(chip('+7d'));

      await user.type(box(), 'Send the invoice');
      await user.click(chip('Capture'));

      await screen.findByRole('alert');
      expect(box()).toHaveValue('Send the invoice');
      expect(chip('Normal priority')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('+7d')).toHaveAttribute('aria-pressed', 'true');
    });

    it('sends them with a capture the outbox kept, and Put back returns them with the note', async () => {
      vi.mocked(sendCommand).mockRejectedValue(new CommandRefused(404, 'workspace ws-home not found'));
      const user = await thePage();
      await user.click(chip('Low priority'));
      await user.click(chip('Tmrw'));
      await user.type(box(), 'Send the invoice');
      await user.click(chip('Capture'));

      expect((await captured()).payload).toMatchObject({ priority: 'low', dueDate: '2026-10-01' });
      await screen.findByText(/^Not sent:/);
      expect(chip('Low priority')).toHaveAttribute('aria-pressed', 'false');
      await user.click(rowOf('Send the invoice').getByRole('button', { name: 'Put back' }));

      expect(box()).toHaveValue('Send the invoice');
      expect(chip('Low priority')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('Tmrw')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  /**
   * "File a note on Panels from Capture, skipping the Inbox" (issue 1101). The
   * search is over snapshots the page already holds, so each rule here is what
   * is offered and what is then sent; that a filed capture really lands on its
   * Panel is the walk in tests/e2e/capture.test.ts, and the filing itself is
   * apps/api/tests/integration/http/capture-on-panels.test.ts.
   */
  describe('File on searches the right Panels and files the note on those chosen', () => {
    /** Opens the line's search, which is fetched on first focus, and answers it. */
    async function searching(user: Awaited<ReturnType<typeof thePage>>) {
      await user.click(screen.getByRole('textbox', { name: 'Find a Panel to file on' }));
      return screen.findByRole('searchbox', { name: 'Find a Panel to file on' });
    }
    const offered = () =>
      within(screen.getByRole('list', { name: 'Panels to file on' }))
        .queryAllByRole('button')
        .map((button) => button.textContent);

    it.each([
      {
        situation: 'a Workspace is chosen',
        choose: 'Work',
        expected: ['FalconToday', 'Reading listLater'],
      },
      {
        situation: 'Any workspace is chosen, each Panel naming its Workspace',
        choose: 'Any workspace',
        expected: ['FalconWork ▸ Today', 'Reading listWork ▸ Later', 'GardenHome ▸ House'],
      },
    ])('offers the Panels of Items in scope when $situation, and never a Filter or a Panel of text', async ({ choose, expected }) => {
      const user = await thePage();
      await user.click(chip(choose));

      await searching(user);

      await waitFor(() => expect(offered()).toEqual(expected));
    });

    it('settles the Workspace on the first Panel picked under Any workspace, and narrows the search to it', async () => {
      const user = await thePage();
      await searching(user);
      await waitFor(() => expect(offered()).toContain('GardenHome ▸ House'));

      await user.click(within(screen.getByRole('list', { name: 'Panels to file on' })).getByRole('button', { name: /Garden/ }));

      expect(chip('Home')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('Any workspace')).toHaveAttribute('aria-pressed', 'false');
      await waitFor(() => expect(offered()).toEqual([]));
      expect(screen.getByRole('button', { name: 'Do not file on Garden' })).toBeVisible();
    });

    it('adds the top match as a chip on Enter with text typed, and several may be added', async () => {
      const user = await thePage();
      await user.click(chip('Work'));
      const search = await searching(user);
      await waitFor(() => expect(offered().length).toBeGreaterThan(0));

      await user.type(search, 'la{Enter}');
      await user.type(search, 'falc{Enter}');

      expect(screen.getByRole('button', { name: 'Do not file on Reading list' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Do not file on Falcon' })).toBeVisible();
      // Enter added a Panel and did not capture anything.
      expect(everythingAsked()).toEqual([]);
    });

    it('adds nothing on Enter with nothing typed', async () => {
      const user = await thePage();
      await user.click(chip('Work'));
      const search = await searching(user);
      await waitFor(() => expect(offered().length).toBeGreaterThan(0));

      await user.type(search, '{Enter}');

      expect(screen.queryByRole('button', { name: /Do not file on/ })).toBeNull();
    });

    it('says which Workspace is left out when it has not been read and there is no connection', async () => {
      const user = await thePage();
      held.snapshots = { 'ws-work': WORK_SNAPSHOT };
      await searching(user);

      expect(await screen.findByText('Not read yet, so left out: Home.')).toBeVisible();
      await waitFor(() => expect(offered()).toEqual(['FalconWork ▸ Today', 'Reading listWork ▸ Later']));
    });

    it.each([
      { situation: 'one Panel', picks: ['Falcon'], expected: ['p-falcon'] },
      { situation: 'two Panels', picks: ['Falcon', 'Reading list'], expected: ['p-falcon', 'p-reading'] },
      { situation: 'none', picks: [] as string[], expected: undefined },
    ])('sends a capture filed on $situation', async ({ picks, expected }) => {
      const user = await thePage();
      await user.click(chip('Work'));
      if (picks.length > 0) {
        await searching(user);
        for (const name of picks) {
          await user.click(within(await screen.findByRole('list', { name: 'Panels to file on' })).getByRole('button', { name: new RegExp(name) }));
        }
      }
      await user.type(box(), 'Send the invoice');
      await user.click(chip('Capture'));

      const { payload } = await captured();
      expect(payload.panelIds).toEqual(expected);
      // Empty again for the next note.
      await waitFor(() => expect(screen.queryByRole('button', { name: /^Do not file on/ })).toBeNull());
    });

    it('takes a Panel off the capture with its ✕, and drops the Panels of a Workspace left for another', async () => {
      const user = await thePage();
      await user.click(chip('Work'));
      await searching(user);
      await user.click(within(await screen.findByRole('list', { name: 'Panels to file on' })).getByRole('button', { name: /Falcon/ }));
      await user.click(screen.getByRole('button', { name: 'Do not file on Falcon' }));
      expect(screen.queryByRole('button', { name: 'Do not file on Falcon' })).toBeNull();

      await user.click(within(screen.getByRole('list', { name: 'Panels to file on' })).getByRole('button', { name: /Reading list/ }));
      await user.click(chip('Home'));

      expect(screen.queryByRole('button', { name: /^Do not file on/ })).toBeNull();
    });

    it('keeps the Panels with a capture that cannot be sent yet, and sends them with it once connected', async () => {
      vi.mocked(sendCommand).mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const user = await thePage();
      await user.click(chip('Work'));
      await searching(user);
      await user.click(within(await screen.findByRole('list', { name: 'Panels to file on' })).getByRole('button', { name: /Falcon/ }));
      await user.type(box(), 'Send the invoice');
      await user.click(chip('Capture'));
      await waitFor(() => expect(capturedCalls().length).toBe(1));
      await screen.findByText('Waiting to send');

      await act(async () => {
        await user.outbox.send();
      });

      const sent = capturedCalls();
      expect(sent.map((call) => call.payload.panelIds)).toEqual([['p-falcon'], ['p-falcon']]);
      expect(sent[1]!.payload.commandId).toBe(sent[0]!.payload.commandId);
    });

    describe('+ New panel makes a Panel that does not exist yet, and files the note on it', () => {
      const typeInto = async (user: Awaited<ReturnType<typeof thePage>>, text: string) => {
        const search = await searching(user);
        await user.type(search, text);
        return search;
      };
      const madePanels = () =>
        vi
          .mocked(sendCommand)
          .mock.calls.filter(([name]) => name === 'add_panel')
          .map(([, payload]) => payload as Record<string, unknown>);

      it.each([
        {
          situation: 'a plain name',
          typed: 'Invoices',
          choose: 'Work',
          made: { workspaceId: 'ws-work', dashboardId: 'd-today', name: 'Invoices' },
        },
        {
          situation: 'Dashboard ▸ Name',
          typed: 'Later ▸ Invoices',
          choose: 'Work',
          made: { workspaceId: 'ws-work', dashboardId: 'd-later', name: 'Invoices' },
        },
        {
          situation: 'Workspace ▸ Dashboard ▸ Name under Any workspace',
          typed: 'Home ▸ House ▸ Invoices',
          choose: 'Any workspace',
          made: { workspaceId: 'ws-home', dashboardId: 'd-house', name: 'Invoices' },
        },
      ])('makes a Panel from $situation, adds it as a chip and files the capture on it', async ({ typed, choose, made }) => {
        const user = await thePage();
        await user.click(chip(choose));
        await typeInto(user, typed);

        await user.click(await screen.findByRole('button', { name: /^\+ New panel “Invoices”/ }));

        expect(await screen.findByRole('button', { name: 'Do not file on Invoices' })).toBeVisible();
        expect(madePanels()).toEqual([expect.objectContaining({ ...made, kind: 'items' })]);
        // The Workspace it was made in is where the capture now goes.
        expect(chip(made.workspaceId === 'ws-home' ? 'Home' : 'Work')).toHaveAttribute('aria-pressed', 'true');
        await user.type(box(), 'Send the invoice');
        await user.click(chip('Capture'));
        const { payload } = await captured();
        expect(payload.panelIds).toEqual([madePanels()[0]!.panelId]);
      });

      it('asks for the whole path, and makes nothing, where a plain name has no Dashboard to go on', async () => {
        const user = await thePage();
        await typeInto(user, 'Invoices');

        const option = await screen.findByRole('button', { name: /^\+ New panel: / });

        expect(option).toBeDisabled();
        expect(option).toHaveTextContent('Say where: Workspace ▸ Dashboard ▸ Name.');
        expect(madePanels()).toEqual([]);
      });

      it('says the name is refused under the field, keeps what was typed and adds no chip', async () => {
        vi.mocked(sendCommand).mockRejectedValueOnce(new CommandRefused(409, 'A panel called Invoices is already on Today'));
        const user = await thePage();
        await user.click(chip('Work'));
        const search = await typeInto(user, 'Invoices');

        await user.click(await screen.findByRole('button', { name: /^\+ New panel “Invoices”/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent('A panel called Invoices is already on Today');
        expect(search).toHaveValue('Invoices');
        expect(screen.queryByRole('button', { name: /^Do not file on/ })).toBeNull();
      });

      it('is shown unavailable, and says it needs a connection, while offline', async () => {
        const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        try {
          const user = await thePage();
          await user.click(chip('Work'));
          await typeInto(user, 'Invoices');

          const option = await screen.findByRole('button', { name: /^\+ New panel “Invoices”/ });

          expect(option).toBeDisabled();
          expect(option).toHaveTextContent('Needs a connection to make a Panel.');
          await user.click(option);
          expect(madePanels()).toEqual([]);
        } finally {
          online.mockRestore();
        }
      });
    });

    it('returns the Panels to the box with a refused capture it puts back', async () => {
      vi.mocked(sendCommand).mockRejectedValue(new CommandRefused(404, 'workspace ws-work not found'));
      const user = await thePage();
      await user.click(chip('Work'));
      await searching(user);
      await user.click(within(await screen.findByRole('list', { name: 'Panels to file on' })).getByRole('button', { name: /Falcon/ }));
      await user.type(box(), 'Send the invoice');
      await user.click(chip('Capture'));
      await screen.findByText(/^Not sent:/);
      expect(screen.queryByRole('button', { name: 'Do not file on Falcon' })).toBeNull();

      await user.click(rowOf('Send the invoice').getByRole('button', { name: 'Put back' }));

      expect(screen.getByRole('button', { name: 'Do not file on Falcon' })).toBeVisible();
    });
  });

  /**
   * Dictation records and Whisper transcribes ("Dictate in Write with Whisper",
   * issue 1041). The recorder and the transcription are the two things replaced:
   * what is proved here is the view's own states, where the words land, and what
   * Capture does while they are on their way. That the Worker really turns a
   * recording into words is tests/integration/http/dictation.test.ts and the
   * contract tier; that a browser really records is the walk in
   * tests/e2e/capture.test.ts.
   */
  describe('dictation is offered only where the browser can record and the page has a transcriber', () => {
    afterEach(() => vi.useRealTimers());

    it.each([
      { situation: 'the browser records and the page has a transcriber', recorder: true, transcriber: true, drawn: true },
      { situation: 'the browser cannot record', recorder: false, transcriber: true, drawn: false },
      { situation: 'the page is told there is no transcriber', recorder: true, transcriber: false, drawn: false },
    ])('draws the mic only when $situation', async ({ recorder, transcriber, drawn }) => {
      await thePage({
        dictating: { record: recorder ? aRecorder().record : null, transcriber },
      });

      expect(screen.queryByRole('button', { name: 'Dictate' }) !== null).toBe(drawn);
      // Whisper hears the language, so there is nothing to choose, drawn or not.
      expect(screen.queryByRole('button', { name: /^Dictation language/ })).toBeNull();
      // The strip is otherwise as it was.
      expect(chip('Normal priority')).toBeInTheDocument();
      expect(chip('Pick a due date')).toBeInTheDocument();
    });
  });

  const dictate = () => {
    const recorder = aRecorder();
    const transcriber = aTranscriber();
    return {
      recorder,
      transcriber,
      dictating: { record: recorder.record, transcribe: transcriber.transcribe, transcriber: true },
    };
  };

  describe('tapping the mic records, tapping it again transcribes, and the words land at the end of the note', () => {
    afterEach(() => vi.useRealTimers());

    it('pulses with a running timer while recording, then says it is transcribing until the words are in', async () => {
      const { dictating, transcriber } = dictate();
      await thePage({ dictating });
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });

      fireEvent.click(mic());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mic()).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('Listening · 0:00')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByText('Listening · 0:03')).toBeInTheDocument();

      fireEvent.click(mic());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Transcribing…')).toBeInTheDocument();
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
      expect(mic()).toBeDisabled();
      expect(screen.queryByText(/^Listening/)).toBeNull();

      await transcriber.answers('buy oat milk');
      expect(box()).toHaveValue('buy oat milk');
      expect(screen.queryByText('Transcribing…')).toBeNull();
      expect(mic()).toBeEnabled();
    });

    it('is not recording until the microphone has been given, and a tap meanwhile lets it go', async () => {
      const { dictating, recorder, transcriber } = dictate();
      recorder.holdsTheNextAsk();
      const user = await thePage({ dictating });

      await user.click(mic());
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
      await user.click(mic());
      await recorder.allows();

      expect(recorder.current().cancelled).toBe(true);
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
      expect(transcriber.sent()).toBe(0);
    });

    it.each([
      { situation: 'an empty note', typed: '', said: 'buy oat milk', expected: 'buy oat milk' },
      { situation: 'typed text, after a space', typed: 'Remember to', said: 'buy oat milk', expected: 'Remember to buy oat milk' },
      { situation: 'a note that already ends in a space, with no second one', typed: 'Remember to ', said: 'buy oat milk', expected: 'Remember to buy oat milk' },
      { situation: 'a note ending in a new line', typed: 'Shopping:\n', said: 'buy oat milk', expected: 'Shopping:\nbuy oat milk' },
    ])('adds the words to $situation', async ({ typed, said, expected }) => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      if (typed) fireEvent.change(box(), { target: { value: typed } });
      await user.click(mic());
      await user.click(mic());

      await transcriber.answers(said);

      expect(box()).toHaveValue(expected);
    });

    it('keeps what is typed while the words are on their way, and puts the words after it', async () => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.click(mic());
      await user.click(mic());

      await user.type(box(), 'Remember to');
      await transcriber.answers('buy oat milk');

      expect(box()).toHaveValue('Remember to buy oat milk');
    });

    it('adds nothing, and says nothing is wrong, when there was no speech to write down', async () => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.type(box(), 'Remember');
      await user.click(mic());
      await user.click(mic());

      await transcriber.answers('');

      expect(box()).toHaveValue('Remember');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('leaves the words editable, and captures the note as edited', async () => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.click(mic());
      await user.click(mic());
      await transcriber.answers('send the invoice to Ada');

      await user.clear(box());
      await user.type(box(), 'Send the invoice to Bea');
      await user.click(chip('Capture'));

      expect((await captured()).payload.message).toBe('Send the invoice to Bea');
    });

    it('captures nothing when it is dictated and the form is closed without pressing Capture', async () => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.click(mic());
      await user.click(mic());
      await transcriber.answers('this is never captured');

      user.unmount();
      await settled();

      expect(everythingAsked()).not.toContain('capture_item');
    });

    it('lets go of the microphone when the form is closed while recording', async () => {
      const { dictating, recorder, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.click(mic());

      user.unmount();

      expect(recorder.current().cancelled).toBe(true);
      expect(transcriber.sent()).toBe(0);
    });

    it('stops itself at the limit, transcribes what was said, and says it stopped there', async () => {
      const { dictating, recorder, transcriber } = dictate();
      await thePage({ dictating });
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
      fireEvent.click(mic());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      });

      expect(recorder.current().stopped).toBe(true);
      expect(screen.getByText('Transcribing…')).toBeInTheDocument();
      await transcriber.answers('a long ramble');
      expect(box()).toHaveValue('a long ramble');
      expect(screen.getByRole('status')).toHaveTextContent(DICTATION_STOPPED_AT_THE_LIMIT);
      expect(transcriber.sent()).toBe(1);
    });
  });

  describe('a dictation that cannot finish says why in one line under the strip, and the mic goes back to off', () => {
    it.each([
      { situation: 'the microphone is blocked', refuses: 'NotAllowedError', line: DICTATION_BLOCKED },
      { situation: 'there is no microphone', refuses: 'NotFoundError', line: DICTATION_NO_MICROPHONE },
    ])('says so when $situation', async ({ refuses, line }) => {
      const { dictating, recorder } = dictate();
      recorder.refusesWith(refuses);
      const user = await thePage({ dictating });

      await user.click(mic());

      expect(await screen.findByRole('alert')).toHaveTextContent(line);
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
    });

    it.each([
      { situation: 'the recording is kept to retry', recordingStore: undefined, line: DICTATION_KEPT_TO_RETRY },
      {
        situation: 'the device cannot keep it, so it has to be said again',
        recordingStore: RECORDINGS_UNAVAILABLE,
        line: DICTATION_COULD_NOT_TRANSCRIBE,
      },
    ])('says it could not transcribe, and keeps the note, when $situation', async ({ recordingStore, line }) => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating, ...(recordingStore ? { recordingStore } : {}) });
      await user.type(box(), 'Remember');
      await user.click(mic());
      await user.click(mic());

      await transcriber.fails();

      expect(screen.getByRole('alert')).toHaveTextContent(line);
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
      expect(mic()).toBeEnabled();
      expect(box()).toHaveValue('Remember');
    });

    it('says too many were sent in a minute when the account is held to its limit, and keeps the note', async () => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.type(box(), 'Remember');
      await user.click(mic());
      await user.click(mic());

      await transcriber.isTurnedAway();

      expect(screen.getByRole('alert')).toHaveTextContent(DICTATION_TOO_MANY);
      expect(box()).toHaveValue('Remember');
    });

    it('clears the line once the next recording starts', async () => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.click(mic());
      await user.click(mic());
      await transcriber.fails();
      expect(screen.getByRole('alert')).toBeInTheDocument();

      await user.click(mic());

      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('Capture pressed mid-dictation waits for the words still on their way and captures them', () => {
    it.each([
      { situation: 'recording', transcribing: false },
      { situation: 'transcribing', transcribing: true },
    ])('ends with the words when it is pressed while $situation', async ({ transcribing }) => {
      const { dictating, recorder, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.type(box(), 'Remember to');
      await user.click(mic());
      if (transcribing) await user.click(mic());

      await user.click(chip('Capture'));
      // Nothing is sent before the words are in: they are what is being waited on.
      await settled();
      expect(everythingAsked()).not.toContain('capture_item');
      expect(recorder.current().stopped).toBe(true);

      await transcriber.answers('buy oat milk');

      expect((await captured()).payload.message).toBe('Remember to buy oat milk');
      expect(transcriber.sent()).toBe(1);
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
    });

    it('captures once however often it is pressed while waiting', async () => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.click(mic());

      await user.click(chip('Capture'));
      await user.click(chip('Capture'));
      await transcriber.answers('buy oat milk');
      await settled();

      expect(capturedCalls()).toHaveLength(1);
    });

    it('captures nothing when the words could not be had, and says why, keeping what is in the note', async () => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.type(box(), 'Remember to');
      await user.click(mic());
      await user.click(chip('Capture'));

      await transcriber.fails();
      await settled();

      expect(everythingAsked()).not.toContain('capture_item');
      expect(screen.getByRole('alert')).toHaveTextContent(DICTATION_KEPT_TO_RETRY);
      expect(box()).toHaveValue('Remember to');
    });
  });

  /**
   * "Keep a recording Write could not transcribe, with Retry" (issue 1044). The
   * recordings are kept in the fake IndexedDB the outbox uses, by the real
   * keeper (`keptRecordings.tsx`); a reload is the form drawn again over it.
   */
  const waitingRows = () =>
    screen.queryByRole('group', { name: 'Not yet transcribed' })?.querySelectorAll(':scope > div') ?? [];
  const retries = () => screen.queryAllByRole('button', { name: 'Retry' });
  const keptOnTheDevice = async () => (await browserRecordingStore().all()).length;
  function aKeptRecording(seconds: number, recordedAt: string, owner = 'user-michael'): KeptRecording {
    return {
      v: 1,
      id: `recording-${recordedAt}`,
      owner,
      recordedAt,
      seconds,
      type: 'audio/webm',
      bytes: new TextEncoder().encode('audio').buffer as ArrayBuffer,
    };
  }
  /** Dictated, stopped, and its words did not come back. */
  const dictatedAndFailed = async () => {
    const { dictating, transcriber } = dictate();
    const user = await thePage({ dictating });
    await user.click(mic());
    await user.click(mic());
    await transcriber.fails();
    return { user, dictating, transcriber };
  };

  describe('a recording that could not be transcribed waits on the device with Retry', () => {
    it('says so, offers Retry, and keeps the recording when the transcription fails', async () => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.click(mic());
      await user.click(mic());
      await waitFor(() => expect(transcriber.sent()).toBe(1));
      // Kept before it was sent, and not offered while it is still on its way.
      expect(await keptOnTheDevice()).toBe(1);
      await settled();
      expect(retries()).toHaveLength(0);

      await transcriber.fails();

      expect(screen.getByRole('alert')).toHaveTextContent(DICTATION_KEPT_TO_RETRY);
      expect(await screen.findByRole('button', { name: 'Retry' })).toBeEnabled();
      expect(await keptOnTheDevice()).toBe(1);
    });

    it('offers Retry for it once Capture is opened again', async () => {
      const { user } = await dictatedAndFailed();

      await reloaded(user);

      expect(await screen.findByRole('button', { name: 'Retry' })).toBeEnabled();
    });

    it('offers no Retry with nothing waiting', async () => {
      await thePage({ dictating: dictate().dictating });
      await settled();

      expect(retries()).toHaveLength(0);
      expect(screen.queryByRole('group', { name: 'Not yet transcribed' })).toBeNull();
    });

    it('offers each of three waiting, oldest first', async () => {
      await thePage({
        dictating: dictate().dictating,
        waitingRecordings: [
          aKeptRecording(30, '2026-10-12T09:00:00.000Z'),
          aKeptRecording(10, '2026-10-12T07:00:00.000Z'),
          aKeptRecording(20, '2026-10-12T08:00:00.000Z'),
        ],
      });

      await waitFor(() => expect(retries()).toHaveLength(3));
      expect([...waitingRows()].map((row) => row.textContent)).toEqual([
        expect.stringContaining('0:10'),
        expect.stringContaining('0:20'),
        expect.stringContaining('0:30'),
      ]);
    });
  });

  describe('a waiting recording is deleted only once its words are in the note', () => {
    it('puts the words in the note and deletes the recording when Retry succeeds', async () => {
      const { user, transcriber } = await dictatedAndFailed();
      await user.type(box(), 'Remember to');

      await user.click(await screen.findByRole('button', { name: 'Retry' }));
      expect(transcriber.sent()).toBe(2);
      await transcriber.answers('buy oat milk');

      expect(box()).toHaveValue('Remember to buy oat milk');
      await waitFor(() => expect(retries()).toHaveLength(0));
      expect(await keptOnTheDevice()).toBe(0);
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps it and still offers Retry when Retry fails again, saying so', async () => {
      const { user, transcriber } = await dictatedAndFailed();
      await user.click(await screen.findByRole('button', { name: 'Retry' }));
      expect(screen.queryByRole('alert')).toBeNull();

      await transcriber.fails();

      expect(screen.getByRole('alert')).toHaveTextContent(DICTATION_KEPT_TO_RETRY);
      expect(await screen.findByRole('button', { name: 'Retry' })).toBeEnabled();
      expect(await keptOnTheDevice()).toBe(1);
    });

    it.each([
      { situation: 'while it is first being transcribed', retried: false },
      { situation: 'while it is being retried', retried: true },
    ])('keeps it when the form is closed $situation and the words arrive after', async ({ retried }) => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.click(mic());
      await user.click(mic());
      if (retried) {
        await transcriber.fails();
        await user.click(await screen.findByRole('button', { name: 'Retry' }));
      } else {
        await waitFor(() => expect(transcriber.sent()).toBe(1));
      }

      user.unmount();
      await transcriber.answers('buy oat milk');
      await settled();

      expect(await keptOnTheDevice()).toBe(1);
      // And it is there to retry, in Write again or on the next visit.
      await thePage({ dictating: dictate().dictating });
      expect(await screen.findByRole('button', { name: 'Retry' })).toBeEnabled();
    });

    it('lands the words once when it is retried in two tabs, the second finding it gone', async () => {
      held.workspaces = [WORK, HOME];
      localStorage.setItem('cockpit.last-visited.workspace', 'ws-home');
      const recording = aKeptRecording(12, '2026-10-12T07:00:00.000Z');
      const store = browserRecordingStore();
      await store.put(recording);
      // One lock across both, as Web Locks is across a browser's tabs.
      const lock = inTabLock();
      const tab = (name: string) => {
        const transcriber = aTranscriber();
        const kept = new KeptRecordings({ store: browserRecordingStore(), lock });
        kept.signedInAs('user-michael');
        const outbox = new CaptureOutbox({ store: browserOutboxStore(), sender: serverSender, lock: inTabLock(), online: () => true });
        everyOutbox.push(outbox);
        outbox.signedInAs('user-michael');
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const tree = (
          <section aria-label={name}>
            <QueryClientProvider client={client}>
              <OutboxProvider value={outbox}>
                <KeptRecordingsProvider value={kept}>
                  <CaptureNote
                    startsIn={null}
                    dictating={{ record: aRecorder().record, transcribe: transcriber.transcribe, transcriber: true }}
                  />
                </KeptRecordingsProvider>
              </OutboxProvider>
            </QueryClientProvider>
          </section>
        );
        return { transcriber, tree, kept };
      };
      const first = tab('first tab');
      const second = tab('second tab');
      render(
        <>
          {first.tree}
          {second.tree}
        </>,
      );
      const inTab = (name: string) => within(screen.getByRole('region', { name }));
      const user = userEvent.setup();
      await waitFor(() => expect(retries()).toHaveLength(2));

      await user.click(inTab('first tab').getByRole('button', { name: 'Retry' }));
      await user.click(inTab('second tab').getByRole('button', { name: 'Retry' }));
      await first.transcriber.answers('buy oat milk');
      await second.transcriber.answers('buy oat milk');
      await settled();

      // Both asked, which costs a call; the words are in one note only.
      expect(first.transcriber.sent() + second.transcriber.sent()).toBe(2);
      expect(inTab('first tab').getByLabelText('What is on your mind?')).toHaveValue('buy oat milk');
      expect(inTab('second tab').getByLabelText('What is on your mind?')).toHaveValue('');
      expect(await keptOnTheDevice()).toBe(0);
      await first.kept.refresh();
      await second.kept.refresh();
      await waitFor(() => expect(retries()).toHaveLength(0));
    });
  });

  describe('a waiting recording belongs to whoever recorded it', () => {
    it.each([
      { situation: 'another person signs in on the device', signedInAs: 'user-bob', offered: false },
      { situation: 'the person who recorded it signs back in', signedInAs: 'user-michael', offered: true },
    ])('is offered only to them: $situation', async ({ signedInAs, offered }) => {
      await thePage({
        dictating: dictate().dictating,
        waitingRecordings: [aKeptRecording(12, '2026-10-12T07:00:00.000Z', 'user-michael')],
        signedInAs,
      });
      await settled();

      expect(retries()).toHaveLength(offered ? 1 : 0);
      // Kept either way: nobody else's sign-in deletes it.
      expect(await keptOnTheDevice()).toBe(1);
    });
  });

  describe('a recording cut off mid-way keeps what was recorded, to transcribe', () => {
    it.each([
      {
        situation: 'the page is hidden, as when the phone is locked',
        cutOff: async () => {
          Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
          await act(async () => document.dispatchEvent(new Event('visibilitychange')));
        },
      },
      {
        situation: 'the recorder stops by itself',
        cutOff: (recorder: ReturnType<typeof aRecorder>) => recorder.current().endsByItself(),
      },
    ])('when $situation', async ({ cutOff }) => {
      const { dictating, recorder, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.click(mic());
      expect(mic()).toHaveAttribute('aria-pressed', 'true');

      try {
        await cutOff(recorder);

        expect(recorder.current().stopped).toBe(true);
        await waitFor(() => expect(transcriber.sent()).toBe(1));
        expect(await keptOnTheDevice()).toBe(1);
        await transcriber.fails();
        expect(await screen.findByRole('button', { name: 'Retry' })).toBeEnabled();
      } finally {
        Reflect.deleteProperty(document, 'visibilityState');
      }
    });
  });

  /**
   * The note can be written formatted, by an Aa in the strip (issue 758). What
   * the editor is for is `RichDescription`'s own tests; what is proved here is
   * what Capture does around it: when it opens, what it keeps across a switch,
   * and that the form's own paths - the shortcut, files, dictation - still hold
   * with it showing. The editor's file failing to arrive is
   * CaptureNoteFormatFailed.test.tsx, which needs its own module registry.
   */
  describe('the note can be switched to formatted, and starts plain', () => {
    const aa = () => screen.getByRole('button', { name: 'Format the note' });
    const toolbar = () => screen.queryByRole('toolbar', { name: 'Formatting' });
    const formattedNote = async () => {
      await screen.findByRole('toolbar', { name: 'Formatting' });
      return screen.getByRole('textbox', { name: 'What is on your mind?' });
    };
    /** Typed straight into the plain box, newlines and all, which `type` would take for key presses. */
    const wrote = (text: string) => fireEvent.change(box(), { target: { value: text } });
    const pressCtrlEnter = (user: ReturnType<typeof userEvent.setup>) =>
      user.keyboard('{Control>}{Enter}{/Control}');

    it('opens plain, with Aa unlit and no editor drawn', async () => {
      await thePage();

      expect(box().tagName).toBe('TEXTAREA');
      expect(aa()).toHaveAttribute('aria-pressed', 'false');
      expect(toolbar()).toBeNull();
    });

    it('shows the editor once Aa is pressed, lit, and opens plain again after the form closes', async () => {
      const user = await thePage();

      await user.click(aa());
      const editor = await formattedNote();
      expect(editor.tagName).not.toBe('TEXTAREA');
      expect(aa()).toHaveAttribute('aria-pressed', 'true');

      await reloaded(user);
      expect(box().tagName).toBe('TEXTAREA');
      expect(toolbar()).toBeNull();
    });

    it('carries the words into the editor, and back to the plain box exactly as they were stored', async () => {
      const user = await thePage();
      // Not what the editor would print: `- ` it re-prints as `* `.
      wrote('Shopping\n\n- milk\n- bread');

      await user.click(aa());
      expect(await formattedNote()).toHaveTextContent('milk');
      await user.click(aa());

      expect(box()).toHaveValue('Shopping\n\n- milk\n- bread');
    });

    it('shows what the editor made as Markdown once something was done in it', async () => {
      const user = await thePage();
      wrote('Ask Ada');
      await user.click(aa());
      await formattedNote();

      await user.click(screen.getByRole('button', { name: 'bullet list' }));
      await user.click(aa());

      expect(box()).toHaveValue('* Ask Ada\n');
    });

    it("captures the editor's Markdown on the shortcut, empties the note and stays formatted", async () => {
      const user = await thePage();
      wrote('Ask Ada');
      await user.click(aa());
      await formattedNote();
      await user.click(screen.getByRole('button', { name: 'bullet list' }));

      await pressCtrlEnter(user);

      expect((await captured()).payload.message).toBe('* Ask Ada');
      await waitFor(() =>
        expect(screen.getByRole('textbox', { name: 'What is on your mind?' })).toHaveTextContent(/^$/),
      );
      expect(toolbar()).not.toBeNull();
      expect(aa()).toHaveAttribute('aria-pressed', 'true');
    });

    it('refuses an empty formatted note as it refuses an empty plain one', async () => {
      const user = await thePage();
      await user.click(aa());
      const editor = await formattedNote();

      await user.click(editor);
      await pressCtrlEnter(user);
      await settled();

      expect(everythingAsked()).not.toContain('capture_item');
    });

    it('queues a file pasted on the formatted note as a chip and writes nothing into it', async () => {
      const user = await thePage();
      await user.click(aa());
      const editor = await formattedNote();

      fireEvent.paste(editor, { clipboardData: { files: [aPhoto()], types: ['Files'], getData: () => '' } });

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(editor).toHaveTextContent(/^$/);
    });

    it('queues a file copied with its HTML and does not also put the picture into the note', async () => {
      const user = await thePage();
      await user.click(aa());
      const editor = await formattedNote();

      fireEvent.paste(editor, {
        clipboardData: {
          files: [aPhoto()],
          types: ['text/html', 'Files'],
          getData: (type: string) => (type === 'text/html' ? '<img src="https://example.test/photo.png">' : ''),
        },
      });

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(editor.querySelector('img')).toBeNull();
    });

    it('puts the words dictated into the editor', async () => {
      const { dictating, transcriber } = dictate();
      const user = await thePage({ dictating });
      await user.click(aa());
      await formattedNote();
      await user.click(mic());
      await user.click(mic());

      await transcriber.answers('Send the invoice.');

      await waitFor(() =>
        expect(screen.getByRole('textbox', { name: 'What is on your mind?' })).toHaveTextContent(/^Send the invoice\.$/),
      );
    });
  });

  describe('the attachment line names paste with this keyboard\'s key', () => {
    it.each([
      ['a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', '⌘V'],
      ['an iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', '⌘V'],
      ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', 'Ctrl V'],
      ['Linux', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0', 'Ctrl V'],
    ])('on %s it says %s', (_keyboard, userAgent, key) => {
      expect(pasteKeyFor(userAgent)).toBe(key);
    });
  });

  /**
   * "Share photos, files and links into Cockpit from Android's share sheet",
   * issue 789. The page claims what the share sheet handed over and gives it to
   * the form (tests/unit/pages/CapturePage.test.tsx); what is held becomes
   * `arrived` through `whatArrived`, as here.
   */
  describe('the Capture page puts what was shared on the note', () => {
    it('queues a shared photo as a chip, with Where on Any workspace', async () => {
      await thePage({ arrived: whatArrived([aShare({ files: [aSharedPhoto()] })]) });

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(chip('Any workspace')).toHaveAttribute('aria-pressed', 'true');
      expect(uploadAttachment).not.toHaveBeenCalled();
    });

    it('puts a shared text and link in the note, text first', async () => {
      await thePage({
        arrived: whatArrived([aShare({ text: 'Worth a read', url: 'https://example.com/a' })]),
      });

      expect(await waitFor(() => box())).toHaveValue('Worth a read\nhttps://example.com/a');
    });

    it('puts two shares on the one note, with the files of both', async () => {
      await thePage({
        arrived: whatArrived([
          aShare({ id: 'a', text: 'first', files: [aSharedPhoto('one.png')] }),
          aShare({ id: 'b', receivedAt: '2026-10-06T09:00:00.000Z', text: 'second', files: [aSharedPhoto('two.png')] }),
        ]),
      });

      expect(await screen.findByText('one.png')).toBeVisible();
      expect(screen.getByText('two.png')).toBeVisible();
      expect(box()).toHaveValue('first\n\nsecond');
    });

    it('does not say a capture was made here for one that lands which was not', async () => {
      const onCaptured = vi.fn();
      const page = await thePage({ onCaptured });

      await page.outbox.add({ id: 'earlier', message: 'Made before', workspaceId: 'ws-work', decided: false, files: [] });
      await waitFor(() => expect(sendCommand).toHaveBeenCalled());

      expect(onCaptured).not.toHaveBeenCalled();
    });

    it('refuses a shared file held without its bytes for being over the limit, by name', async () => {
      const huge = { name: 'huge.png', type: 'image/png', size: MAX_ATTACHMENT_SIZE + 1, bytes: null };
      await thePage({ arrived: whatArrived([aShare({ files: [huge] })]) });

      expect(await screen.findByRole('alert')).toHaveTextContent('"huge.png" is over the 25 MB limit.');
      expect(screen.queryByText('huge.png')).toBeNull();
    });

    it('says it has put what was shared on the note, once', async () => {
      const onPutOn = vi.fn();

      await thePage({ arrived: whatArrived([aShare({ text: 'Worth a read' })]), onPutOn });

      await waitFor(() => expect(box()).toHaveValue('Worth a read'));
      expect(onPutOn).toHaveBeenCalledTimes(1);
    });

    it('says a capture has been made here, for the page to stop saying a share was lost', async () => {
      const onCaptured = vi.fn();
      const user = await thePage({ onCaptured });

      await user.type(box(), 'Ask Ada');
      await user.click(screen.getByRole('button', { name: 'Capture' }));

      await waitFor(() => expect(onCaptured).toHaveBeenCalled());
    });

    it('refuses a shared file the Attachment rules refuse as it refuses a dropped one, and queues the rest', async () => {
      const notes = { ...aSharedPhoto('notes.txt'), type: 'text/plain' };
      await thePage({ arrived: whatArrived([aShare({ files: [notes, aSharedPhoto()] })]) });

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(screen.getByRole('alert')).toHaveTextContent('"notes.txt" is not a kind of file Cockpit accepts.');
      expect(screen.queryByText('notes.txt')).toBeNull();
    });
  });
});
