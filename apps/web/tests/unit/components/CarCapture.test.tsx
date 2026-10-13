import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { sendCommand } from '../../../src/api/client';
import {
  CAR_DARK_KEY,
  CAR_KEPT_IN_WRITE,
  CAR_NO_WORKSPACE,
  CarCapture,
  NO_RECORDING_HERE,
  NO_TRANSCRIBER_HERE,
  WAITING_FOR_WORDS,
} from '../../../src/components/CarCapture';
import type { OutboxEntry } from '../../../src/captureOutbox';
import styles from '../../../src/styles.css?raw';
import {
  CaptureOutbox,
  OutboxProvider,
  browserOutboxStore,
  inTabLock,
  serverSender,
  type OutboxStore,
} from '../../../src/captureOutboxSender';
import { DICTATION_BLOCKED, DICTATION_NO_MICROPHONE } from '../../../src/dictation';
import { KeptRecordings, KeptRecordingsProvider, browserRecordingStore } from '../../../src/keptRecordings';
import type { StartRecording } from '../../../src/recording';
import type { WakeLockApi } from '../../../src/wakeLock';
import { aRecorder, aTranscriber } from '../support/recording';

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  sendCommand: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
  uploadAttachment: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
}));

/**
 * F1: the Car view is one button, a card, a status line and a footer, and every
 * rule here is what it sends and what it then shows. The phone's recorder, the
 * Worker's transcription, the screen wake lock and the phone's vibration are the
 * platform's or another service's, so the view is handed a fake of each; the walk
 * through a real browser to the Inbox is tests/e2e/capture.test.ts. The API
 * client is what is replaced and IndexedDB is a fake one, so what capturing does
 * is the real outbox sending through the real sender, as in CaptureNote.test.tsx,
 * which also owns the outbox's own rules and the recording's own (starting,
 * letting go, the limit) as Write has them.
 */
const held = vi.hoisted(() => ({
  mutate: vi.fn(),
  /** What the workspace's own read waits on: nothing, unless a test holds it. */
  reading: Promise.resolve(),
  /** The account has no workspace left. */
  noWorkspaces: false,
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: held.mutate, isPending: false }),
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () => held.reading.then(() => ({ workspaces: held.noWorkspaces ? [] : [HOME_AND_WORK[0], HOME_AND_WORK[1]] })),
  },
}));

const HOME_AND_WORK = [
  { id: 'ws-home', tenantId: 'tenant', name: 'Home', color: '#3f8f78' },
  { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5' },
];

/** The platform's wake lock: hands out locks the test can inspect and the browser can take back. */
class FakeLock {
  released = false;
  private listeners: (() => void)[] = [];
  release() {
    this.released = true;
    return Promise.resolve();
  }
  addEventListener(_type: 'release', listener: () => void) {
    this.listeners.push(listener);
  }
  /** What the browser does when the page is hidden. */
  takenBack() {
    this.released = true;
    act(() => this.listeners.forEach((listener) => listener()));
  }
}

function aWakeLock(refuses = false) {
  const taken: FakeLock[] = [];
  const api: WakeLockApi = {
    request: vi.fn(() => {
      if (refuses) return Promise.reject(new Error('battery saver'));
      const lock = new FakeLock();
      taken.push(lock);
      return Promise.resolve(lock);
    }),
  };
  return { api: () => api, request: api.request as ReturnType<typeof vi.fn>, taken };
}

function pageIs(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function theCar({
  dictating,
  wakeLock = aWakeLock().api,
  vibrate = vi.fn(),
  store = browserOutboxStore(),
  capturedFor = 40,
  hidden = false,
  online = true,
}: {
  dictating?: {
    record?: StartRecording | null;
    transcribe?: (recording: Blob) => Promise<string>;
    transcriber?: boolean;
    limitSeconds?: number;
    store?: Storage | undefined;
  };
  wakeLock?: () => WakeLockApi | undefined;
  vibrate?: (pattern: number | number[]) => unknown;
  store?: OutboxStore;
  capturedFor?: number;
  /** The page is hidden as the view opens. */
  hidden?: boolean;
  /** False where the browser says it is offline. */
  online?: boolean;
} = {}) {
  localStorage.clear();
  localStorage.setItem('cockpit.last-visited.workspace', 'ws-home');
  pageIs(hidden ? 'hidden' : 'visible');

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The outbox transcribes what the view hands it, with the Worker the view was given.
  const transcribe = dictating?.transcribe;
  const outbox = new CaptureOutbox({
    store,
    sender: transcribe ? { ...serverSender, transcribe: (recording) => transcribe(recording) } : serverSender,
    lock: inTabLock(),
    online: () => online,
    timeoutMs: 500,
  });
  outbox.signedInAs('user-michael');
  const kept = new KeptRecordings({ store: browserRecordingStore(), lock: inTabLock() });
  kept.signedInAs('user-michael');
  const view = render(
    <QueryClientProvider client={client}>
      <OutboxProvider value={outbox}>
        <KeptRecordingsProvider value={kept}>
          <CarCapture
            dictating={dictating ? { transcriber: true, ...dictating } : undefined}
            wakeLock={wakeLock}
            vibrate={vibrate}
            capturedFor={capturedFor}
          />
        </KeptRecordingsProvider>
      </OutboxProvider>
    </QueryClientProvider>,
  );
  // The button is there at once; what it captures into is read behind it.
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  });
  return Object.assign(userEvent.setup(), { unmount: view.unmount, vibrate, kept });
}

/** A phone that can record, a Worker that transcribes when told to, and the Car view over them. */
async function drivingWith(options: Parameters<typeof theCar>[0] = {}) {
  const recorder = aRecorder();
  const transcriber = aTranscriber();
  const user = await theCar({
    ...options,
    dictating: {
      record: recorder.record,
      transcribe: transcriber.transcribe,
      ...options.dictating,
    },
  });
  return { user, recorder, transcriber };
}

const theButton = () => screen.getAllByRole('button')[0]!;
const theStatus = () => screen.getByRole('status');
const card = () => screen.getByLabelText('Recording');

const capturedCalls = () =>
  vi
    .mocked(sendCommand)
    .mock.calls.filter(([name]) => name === 'capture_item')
    .map(([, payload]) => payload as Record<string, unknown>);
const theCapture = async () => {
  await waitFor(() => expect(capturedCalls().length).toBeGreaterThan(0));
  return capturedCalls()[0]!;
};
/** Lets the outbox finish whatever it started, so "nothing was sent" is an answer. */
const settled = async () => {
  await act(async () => {
    for (let i = 0; i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
  });
};

/** The first tap, and the recorder having started: the view as it is part way through a note. */
async function recording(user: ReturnType<typeof userEvent.setup>) {
  await user.click(theButton());
  await waitFor(() => expect(theStatus()).toHaveTextContent('Listening — tap to capture'));
}

/** The whole of a note: tap, tap, and the transcription answering with `words`. */
async function says(
  user: ReturnType<typeof userEvent.setup>,
  transcriber: ReturnType<typeof aTranscriber>,
  words: string,
) {
  await recording(user);
  await user.click(theButton());
  await transcriber.answers(words);
}

describe('Capture', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    held.mutate.mockClear();
    held.reading = Promise.resolve();
    held.noWorkspaces = false;
    vi.mocked(sendCommand).mockReset();
    vi.mocked(sendCommand).mockResolvedValue({ ok: true as const, applied: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    pageIs('visible');
    document.documentElement.removeAttribute('data-car-dark');
    document.documentElement.removeAttribute('data-app-dark');
  });

  describe('the Car view works wherever the browser can record, and says so where it cannot', () => {
    it('draws the button where the browser records, though it has no speech recognition', async () => {
      expect('SpeechRecognition' in globalThis || 'webkitSpeechRecognition' in globalThis).toBe(false);
      await drivingWith();

      expect(theButton()).toHaveAccessibleName('Speak a note');
      expect(theStatus()).toHaveTextContent('Tap to speak');
    });

    it('says it needs a browser that can record, draws no button, and is not flagged dark', async () => {
      await theCar({ dictating: { record: null, store: aStore({ [CAR_DARK_KEY]: 'dark' }) } });

      expect(theStatus()).toHaveTextContent(NO_RECORDING_HERE);
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      expect(document.documentElement.hasAttribute('data-car-dark')).toBe(false);
    });

    it('says Cockpit cannot transcribe where the page is told there is no transcriber', async () => {
      await theCar({ dictating: { record: aRecorder().record, transcriber: false } });

      expect(theStatus()).toHaveTextContent(NO_TRANSCRIBER_HERE);
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });
  });

  describe('the second tap transcribes, then captures what was said at once, to Any workspace', () => {
    it('captures one note with no priority and no due date', async () => {
      const { user, transcriber } = await drivingWith();

      await says(user, transcriber, 'buy oat milk');

      const sent = await theCapture();
      expect(sent).toMatchObject({
        message: 'buy oat milk',
        workspaceId: 'ws-home',
        workspaceDecided: false,
      });
      expect(sent).not.toHaveProperty('typeId');
      expect(sent).not.toHaveProperty('priority');
      expect(sent).not.toHaveProperty('dueDate');
      expect(capturedCalls()).toHaveLength(1);
      expect(transcriber.sent()).toBe(1);
    });

    it('captures nothing when the transcription is empty, and says so before going back to the start', async () => {
      const { user, transcriber } = await drivingWith();

      await says(user, transcriber, '  ');

      await waitFor(() => expect(theStatus()).toHaveTextContent('Nothing heard'));
      await waitFor(() => expect(theStatus()).toHaveTextContent('Tap to speak'));
      await settled();
      expect(capturedCalls()).toHaveLength(0);
    });

    it('captures once when the second tap is pressed twice', async () => {
      const { user, transcriber } = await drivingWith({ capturedFor: 200 });
      await recording(user);

      await user.click(theButton());
      await user.click(theButton());
      await transcriber.answers('call the dentist');
      // A third press once it has finished and shows ✓ is no more a capture than the second.
      await waitFor(() => expect(theStatus()).toHaveTextContent('Captured'));
      await user.click(theButton());

      await theCapture();
      await settled();
      expect(capturedCalls()).toHaveLength(1);
      expect(transcriber.sent()).toBe(1);
    });

    it('stops at the limit and captures what was said as if tapped', async () => {
      const { transcriber } = await drivingWith({ dictating: { limitSeconds: 300 } });
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
      fireEvent.click(theButton());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      });
      expect(theStatus()).toHaveTextContent('Transcribing…');
      await transcriber.answers('a long ramble');
      vi.useRealTimers();

      expect((await theCapture()).message).toBe('a long ramble');
      expect(transcriber.sent()).toBe(1);
    });
  });

  describe('the button and the status line say which state the view is in, and the card shows the time recorded', () => {
    it('is starting, not listening, until the recorder has the microphone', async () => {
      const { user, recorder } = await drivingWith();
      recorder.holdsTheNextAsk();
      expect(theStatus()).toHaveTextContent('Tap to speak');

      await user.click(theButton());
      expect(theStatus()).toHaveTextContent('Starting…');

      await recorder.allows();
      expect(theStatus()).toHaveTextContent('Listening — tap to capture');
      expect(theButton()).toHaveAccessibleName('Capture');
    });

    it('shows a running time on the card while recording, and Transcribing… after the second tap', async () => {
      await drivingWith();
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });

      fireEvent.click(theButton());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(card()).toHaveTextContent('Listening · 0:00');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(card()).toHaveTextContent('Listening · 0:03');

      fireEvent.click(theButton());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(theStatus()).toHaveTextContent('Transcribing…');
      expect(card()).toHaveTextContent('Transcribing…');
      expect(card()).not.toHaveTextContent('Listening');
      expect(theButton()).toHaveAttribute('aria-disabled', 'true');
    });

    it('says Transcribing while the recording is still being kept, with no tick and no vibration', async () => {
      const vibrate = vi.fn();
      const writing: OutboxStore = {
        all: () => Promise.resolve([]),
        put: () => new Promise(() => {}),
        remove: () => Promise.resolve(),
      };
      const { user, transcriber } = await drivingWith({ vibrate, store: writing });

      await recording(user);
      await user.click(theButton());
      await settled();

      expect(theStatus()).toHaveTextContent('Transcribing…');
      expect(transcriber.sent()).toBe(0);
      expect(vibrate).not.toHaveBeenCalled();
    });

    it('shows a tick and vibrates once the note is kept, then goes back to Tap to speak', async () => {
      const vibrate = vi.fn();
      const { user, transcriber } = await drivingWith({ vibrate });

      await says(user, transcriber, 'call the dentist');

      await waitFor(() => expect(theStatus()).toHaveTextContent('Captured'));
      expect(theButton()).toHaveAccessibleName('Captured');
      expect(vibrate).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(theStatus()).toHaveTextContent('Tap to speak'));
      expect(theButton()).toHaveAccessibleName('Speak a note');
    });

    it('lists the notes captured from here at the bottom, newest first', async () => {
      const { user, transcriber } = await drivingWith();
      for (const note of ['first note', 'second note']) {
        await says(user, transcriber, note);
        await waitFor(() => expect(theStatus()).toHaveTextContent('Tap to speak'));
      }

      const rows = screen.getAllByRole('listitem').map((one) => one.textContent);
      expect(rows).toEqual(['second note', 'first note']);
    });
  });

  describe('the Car view captures at once when the words cannot come back, and lists the note as waiting for them', () => {
    it.each([
      { situation: 'no connection', online: false, answer: null },
      {
        situation: 'the transcription fails',
        online: true,
        answer: (transcriber: ReturnType<typeof aTranscriber>) => transcriber.fails(),
      },
      {
        situation: 'the account is held to its limit',
        online: true,
        answer: (transcriber: ReturnType<typeof aTranscriber>) => transcriber.isTurnedAway(),
      },
    ])('$situation', async ({ online, answer }) => {
      const vibrate = vi.fn();
      const { user, transcriber } = await drivingWith({ online, vibrate, capturedFor: 200 });
      await recording(user);
      await user.click(theButton());
      await answer?.(transcriber);

      await waitFor(() => expect(theStatus()).toHaveTextContent('Captured'));
      expect(vibrate).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('list', { name: 'Captured here' })).toHaveTextContent(WAITING_FOR_WORDS);
      const kept = (await browserOutboxStore().all()) as OutboxEntry[];
      expect(kept.map((entry) => [entry.message, entry.recording?.transcribed])).toEqual([['', false]]);
      await settled();
      expect(capturedCalls()).toHaveLength(0);

      // Opened again, as after a reload: still listed as waiting.
      user.unmount();
      await theCar({ dictating: { record: aRecorder().record, transcribe: transcriber.transcribe }, online: false });
      expect(screen.getByRole('list', { name: 'Captured here' })).toHaveTextContent(WAITING_FOR_WORDS);
    });

    it('lists one kept from before the view was opened again by its words once it lands', async () => {
      const { user, transcriber } = await drivingWith({ online: false });
      await recording(user);
      await user.click(theButton());
      await waitFor(() => expect(theStatus()).toHaveTextContent('Captured'));

      user.unmount();
      await theCar({ dictating: { record: aRecorder().record, transcribe: transcriber.transcribe } });
      await transcriber.answers('buy oat milk');

      expect((await theCapture()).message).toBe('buy oat milk');
      await waitFor(() =>
        expect(screen.getByRole('list', { name: 'Captured here' })).toHaveTextContent('buy oat milk'),
      );
    });

    it('keeps the recording when the view is switched away while it is transcribing', async () => {
      const { user, transcriber } = await drivingWith();
      await recording(user);
      await user.click(theButton());

      user.unmount();
      await transcriber.answers('buy oat milk');

      expect((await theCapture()).message).toBe('buy oat milk');
    });

    it('waits for the workspace to be read when the note is spoken before it has been, then captures it', async () => {
      let read: () => void = () => {};
      held.reading = new Promise((resolve) => {
        read = resolve;
      });
      const { user, transcriber } = await drivingWith();
      await recording(user);
      await user.click(theButton());
      await settled();
      expect(theStatus()).toHaveTextContent('Transcribing…');
      expect(transcriber.sent()).toBe(0);

      await act(async () => read());
      await transcriber.answers('buy oat milk');

      expect(await theCapture()).toMatchObject({ message: 'buy oat milk' });
    });

    it('keeps the recording in Write to retry where there is no workspace to capture it into', async () => {
      held.noWorkspaces = true;
      const { user, transcriber } = await drivingWith();
      await recording(user);
      await user.click(theButton());

      await waitFor(() => expect(theStatus()).toHaveTextContent(`${CAR_NO_WORKSPACE} ${CAR_KEPT_IN_WRITE}`));
      expect(user.kept.getShown()).toHaveLength(1);
      expect(transcriber.sent()).toBe(0);
      expect(capturedCalls()).toEqual([]);
    });

    it('transcribes it here and sends it at once where the recording cannot be kept on this device', async () => {
      const refusing: OutboxStore = {
        all: () => Promise.resolve([]),
        put: () => Promise.reject(new Error('private window')),
        remove: () => Promise.resolve(),
      };
      const { user, transcriber } = await drivingWith({ store: refusing });

      await says(user, transcriber, 'buy oat milk');

      await waitFor(() => expect(theStatus()).toHaveTextContent('Captured'));
      expect(held.mutate).toHaveBeenCalledTimes(1);
      expect(held.mutate.mock.calls[0]![0]).toMatchObject({ name: 'capture_item', payload: { message: 'buy oat milk' } });
    });
  });

  describe('when recording fails, the status says why in large text and nothing is captured', () => {
    it.each([
      ['the microphone is blocked', 'NotAllowedError', DICTATION_BLOCKED],
      ['there is no microphone', 'NotFoundError', DICTATION_NO_MICROPHONE],
    ])('says so when %s', async (_situation, refusal, line) => {
      const { user, recorder } = await drivingWith();
      recorder.refusesWith(refusal);

      await user.click(theButton());

      await waitFor(() => expect(theStatus()).toHaveTextContent(line));
      expect(theButton()).toHaveAccessibleName('Speak a note');
      await settled();
      expect(capturedCalls()).toHaveLength(0);
    });

    it('lets go of the microphone and captures nothing when the view is left while recording', async () => {
      const { user, recorder, transcriber } = await drivingWith();
      await recording(user);

      user.unmount();

      expect(recorder.current().cancelled).toBe(true);
      await settled();
      expect(transcriber.sent()).toBe(0);
      expect(capturedCalls()).toHaveLength(0);
    });
  });

  describe('the screen is held on while the Car view is shown and visible, and let go otherwise', () => {
    it('holds it once opened and says so', async () => {
      const { record } = aRecorder();
      const wake = aWakeLock();
      await theCar({ dictating: { record }, wakeLock: wake.api });

      expect(wake.request).toHaveBeenCalledWith('screen');
      expect(screen.getByText(/Screen stays on/)).toBeInTheDocument();
    });

    it('takes it again when the page comes back into view', async () => {
      const { record } = aRecorder();
      const wake = aWakeLock();
      await theCar({ dictating: { record }, wakeLock: wake.api });

      // The browser lets go of it when the page is hidden.
      pageIs('hidden');
      wake.taken[0]!.takenBack();
      pageIs('visible');

      await waitFor(() => expect(wake.request).toHaveBeenCalledTimes(2));
      expect(wake.taken[1]!.released).toBe(false);
    });

    it('does not ask while the page is hidden, and does once it is visible', async () => {
      const { record } = aRecorder();
      const wake = aWakeLock();
      await theCar({ dictating: { record }, wakeLock: wake.api, hidden: true });
      expect(wake.request).not.toHaveBeenCalled();

      pageIs('visible');

      await waitFor(() => expect(wake.request).toHaveBeenCalledTimes(1));
    });

    it('lets go of it on leaving the view', async () => {
      const { record } = aRecorder();
      const wake = aWakeLock();
      const user = await theCar({ dictating: { record }, wakeLock: wake.api });
      await waitFor(() => expect(wake.taken).toHaveLength(1));

      user.unmount();

      expect(wake.taken[0]!.released).toBe(true);
    });

    it.each([
      ['the browser has no wake lock', () => undefined],
      ['the request is refused', aWakeLock(true).api],
    ])('says the screen may lock, and still captures, when %s', async (_situation, wakeLock) => {
      const { user, transcriber } = await drivingWith({ wakeLock });
      await waitFor(() => expect(screen.getByText(/may lock/)).toBeInTheDocument());

      await says(user, transcriber, 'still captured');

      expect((await theCapture()).message).toBe('still captured');
    });
  });

  describe('the dark view is switched from the footer, at any time', () => {
    it.each([
      { situation: 'light', listening: false, status: 'Tap to speak' },
      { situation: 'listening', listening: true, status: 'Listening — tap to capture' },
    ])('$situation, tapped: goes dark and captures nothing', async ({ listening, status }) => {
      const { user } = await drivingWith({ dictating: { store: aStore() } });
      if (listening) await recording(user);

      await user.click(theMoon());

      expect(theMoon()).toHaveAttribute('aria-pressed', 'true');
      expect(theMoon()).toHaveAttribute('title', 'Switch to the light view');
      expect(theStatus()).toHaveTextContent(status);
      await settled();
      expect(capturedCalls()).toHaveLength(0);
    });

    it('goes light again on the next tap', async () => {
      const { record } = aRecorder();
      const user = await theCar({ dictating: { record, store: aStore() } });

      await user.click(theMoon());
      await user.click(theMoon());

      expect(theMoon()).toHaveAttribute('aria-pressed', 'false');
      expect(theMoon()).toHaveAttribute('title', 'Switch to the dark view');
    });

    it('still resets to Tap to speak after Captured while dark', async () => {
      const { user, transcriber } = await drivingWith({ dictating: { store: aStore() }, capturedFor: 200 });
      await says(user, transcriber, 'buy oat milk');
      await waitFor(() => expect(theStatus()).toHaveTextContent('Captured'));

      await user.click(theMoon());

      expect(theMoon()).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(theStatus()).toHaveTextContent('Tap to speak'));
    });
  });

  describe('while the Car view is shown dark the document is flagged, and never otherwise', () => {
    const flagged = () => document.documentElement.hasAttribute('data-car-dark');

    it('flags the document while dark and takes the flag off on switching light', async () => {
      const { record } = aRecorder();
      const user = await theCar({ dictating: { record, store: aStore() } });
      expect(flagged()).toBe(false);

      await user.click(theMoon());
      expect(flagged()).toBe(true);

      await user.click(theMoon());
      expect(flagged()).toBe(false);
    });

    it('takes the flag off on leaving, and puts it back on coming again from what was remembered', async () => {
      const { record } = aRecorder();
      const store = aStore();
      const first = await theCar({ dictating: { record, store } });
      await first.click(theMoon());
      expect(flagged()).toBe(true);

      first.unmount();
      expect(flagged()).toBe(false);

      await theCar({ dictating: { record: aRecorder().record, store } });
      expect(flagged()).toBe(true);
    });

  });

  describe('the Car view is dark when the app is dark or its own switch is on, and light only when both are light', () => {
    const flagged = () => document.documentElement.hasAttribute('data-car-dark');
    const appIs = (look: 'dark' | 'light') =>
      act(() => {
        if (look === 'dark') document.documentElement.setAttribute('data-app-dark', '');
        else document.documentElement.removeAttribute('data-app-dark');
      });

    it.each([
      { situation: 'app dark, Car switch off', app: 'dark', own: 'light', night: true },
      { situation: 'app light, Car switch on', app: 'light', own: 'dark', night: true },
      { situation: 'app light, Car switch off', app: 'light', own: 'light', night: false },
    ] as const)('$situation: night look is $night', async ({ app, own, night }) => {
      await appIs(app);
      await theCar({ dictating: { record: aRecorder().record, store: aStore({ [CAR_DARK_KEY]: own }) } });

      expect(flagged()).toBe(night);
    });

    it('is light again when the app goes from dark to light with the Car switch off', async () => {
      await appIs('dark');
      await theCar({ dictating: { record: aRecorder().record, store: aStore() } });
      expect(flagged()).toBe(true);

      await appIs('light');

      expect(flagged()).toBe(false);
    });
  });

  describe('the Car view switch is hidden while the app is dark, and returns with its own choice once the app is light', () => {
    const appIs = (look: 'dark' | 'light') =>
      act(() => {
        if (look === 'dark') document.documentElement.setAttribute('data-app-dark', '');
        else document.documentElement.removeAttribute('data-app-dark');
      });

    it('shows no switch while the app is dark', async () => {
      await appIs('dark');
      await theCar({ dictating: { record: aRecorder().record, store: aStore() } });

      expect(screen.queryByRole('button', { name: 'Dark view' })).toBeNull();
    });

    it.each([
      { choice: 'dark', pressed: 'true', night: true },
      { choice: 'light', pressed: 'false', night: false },
    ] as const)('shows the switch as it was, with the choice $choice, once the app goes light', async ({ choice, pressed, night }) => {
      await appIs('dark');
      await theCar({ dictating: { record: aRecorder().record, store: aStore({ [CAR_DARK_KEY]: choice }) } });

      await appIs('light');

      expect(theMoon()).toHaveAttribute('aria-pressed', pressed);
      expect(document.documentElement.hasAttribute('data-car-dark')).toBe(night);
    });
  });

  describe('the dark choice is remembered on this device, and the view is light until first switched', () => {
    it('is light with nothing stored, whatever the phone is set to', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('dark'), media: query }));
      const { record } = aRecorder();
      await theCar({ dictating: { record, store: aStore() } });

      expect(theMoon()).toHaveAttribute('aria-pressed', 'false');
      expect(document.documentElement.hasAttribute('data-car-dark')).toBe(false);
    });

    it('is dark when it is opened again after being switched dark', async () => {
      const { record } = aRecorder();
      const store = aStore();
      const first = await theCar({ dictating: { record, store } });
      await first.click(theMoon());
      first.unmount();

      await theCar({ dictating: { record: aRecorder().record, store } });

      expect(theMoon()).toHaveAttribute('aria-pressed', 'true');
    });

    it('is light where something unrecognised is stored', async () => {
      const { record } = aRecorder();
      await theCar({ dictating: { record, store: aStore({ [CAR_DARK_KEY]: 'blue' }) } });

      expect(theMoon()).toHaveAttribute('aria-pressed', 'false');
    });

    it('still switches without an error where storage is unavailable', async () => {
      const { record } = aRecorder();
      const refusing = {
        getItem: () => {
          throw new Error('refused');
        },
        setItem: () => {
          throw new Error('refused');
        },
      } as unknown as Storage;
      const user = await theCar({ dictating: { record, store: refusing } });
      expect(theMoon()).toHaveAttribute('aria-pressed', 'false');

      await user.click(theMoon());

      expect(theMoon()).toHaveAttribute('aria-pressed', 'true');
    });
  });

  describe('text in the dark view reads at 4.5:1 or better on what it is drawn on', () => {
    const night = (name: string) => {
      const found = new RegExp(`--color-night${name}:\\s*(#[0-9a-f]{6})`).exec(styles);
      if (!found) throw new Error(`no --color-night${name} in styles.css`);
      return found[1]!;
    };

    it.each([
      { situation: 'the status line', text: night('-ink'), on: night(''), least: 4.5 },
      { situation: 'the words card', text: night('-ink'), on: night('-card'), least: 4.5 },
      { situation: 'an error in the status line', text: night('-over'), on: night(''), least: 4.5 },
      { situation: 'the footer text', text: night('-ink-soft'), on: night(''), least: 4.5 },
      { situation: 'the Capture heading', text: night('-ink-soft'), on: night(''), least: 4.5 },
      { situation: 'the switch', text: night('-ink-soft'), on: night('-card'), least: 4.5 },
      {
        situation: 'the lit side of the Write | Car switch',
        text: night('-ink'),
        on: lightenedBy10(night('-card')),
        least: 4.5,
      },
      { situation: 'placeholder and provisional words', text: night('-faint'), on: night('-card'), least: 3 },
    ])('$situation reads on its ground', ({ text, on, least }) => {
      expect(contrast(text, on)).toBeGreaterThanOrEqual(least);
    });
  });
});

const theMoon = () => screen.getByRole('button', { name: 'Dark view' });

/** A storage the test holds, with what was stored on this device before the view opens. */
function aStore(initial: Record<string, string> = {}): Storage {
  const held = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
  } as unknown as Storage;
}

const channels = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
/** White at 10% over a colour, which is how the lit side of the switch is drawn. */
const lightenedBy10 = (hex: string) =>
  `#${channels(hex)
    .map((value) => Math.round(255 * 0.1 + value * 0.9).toString(16).padStart(2, '0'))
    .join('')}`;
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((value) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (one: string, other: string) => {
  const [light, dark] = [luminance(one), luminance(other)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
};
