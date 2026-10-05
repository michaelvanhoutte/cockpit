import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Item, ItemType } from '@cockpit/shared';
import { sendCommand } from '../../../src/api/client';
import { CAR_DARK_KEY, CarCapture, NO_SPEECH_HERE } from '../../../src/components/CarCapture';
import styles from '../../../src/styles.css?raw';
import {
  CaptureOutbox,
  OutboxProvider,
  browserOutboxStore,
  inTabLock,
  serverSender,
  type OutboxStore,
} from '../../../src/captureOutboxSender';
import {
  DICTATION_BLOCKED,
  DICTATION_NO_MICROPHONE,
  DICTATION_OFFLINE,
  readDictationLanguage,
  type EngineFactory,
} from '../../../src/dictation';
import type { WakeLockApi } from '../../../src/wakeLock';
import { anEngine } from '../support/speech';

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  sendCommand: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
  uploadAttachment: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
}));

/**
 * F1: the Car view is one button, a card, a status line and a footer, and every
 * rule here is what it sends and what it then shows. The speech engine, the
 * screen wake lock and the phone's vibration are the platform's, so the view is
 * handed a fake of each; the walk through a real browser to the Inbox is
 * tests/e2e/capture.test.ts. The API client is what is replaced and IndexedDB
 * is a fake one, so what capturing does is the real outbox sending through the
 * real sender, as in CaptureNote.test.tsx, which also owns the outbox's own
 * rules and the engine's restarts through pauses.
 */
const held = vi.hoisted(() => ({
  types: [] as unknown[],
  items: [] as unknown[],
  mutate: vi.fn(),
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: held.mutate, isPending: false }),
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () => Promise.resolve({ workspaces: [HOME_AND_WORK[0], HOME_AND_WORK[1]] }),
  },
  itemTypesQuery: { queryKey: ['itemTypes'], queryFn: () => new Promise(() => {}) },
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.resolve({ items: held.items, itemTypes: held.types }),
  }),
}));

const HOME_AND_WORK = [
  { id: 'ws-home', tenantId: 'tenant', name: 'Home', color: '#3f8f78' },
  { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5' },
];

const aType = (name: string, at: number) =>
  ({
    id: `11111111-1111-7111-8111-${String(at).padStart(12, '0')}`,
    tenantId: 'tenant',
    name,
    color: '#6f62b5',
    position: at,
    createdAt: '2026-09-01T08:00:00.000Z',
  }) as ItemType;
const ACTION = aType('Action', 0);
const THOUGHT = aType('Thought', 1);

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
  items = [] as Item[],
  dictating,
  wakeLock = aWakeLock().api,
  vibrate = vi.fn(),
  language,
  store = browserOutboxStore(),
  capturedFor = 40,
  finishWithin = 40,
  hidden = false,
}: {
  items?: Item[];
  dictating?: { engine?: EngineFactory | null; store?: Storage | undefined };
  wakeLock?: () => WakeLockApi | undefined;
  vibrate?: (pattern: number | number[]) => unknown;
  /** The language stored on this device before the view opens. */
  language?: string;
  store?: OutboxStore;
  capturedFor?: number;
  finishWithin?: number;
  /** The page is hidden as the view opens. */
  hidden?: boolean;
} = {}) {
  held.types = [ACTION, THOUGHT];
  held.items = items;
  localStorage.clear();
  localStorage.setItem('cockpit.last-visited.workspace', 'ws-home');
  if (language) localStorage.setItem('cockpit.dictation-language', language);
  pageIs(hidden ? 'hidden' : 'visible');

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outbox = new CaptureOutbox({
    store,
    sender: serverSender,
    lock: inTabLock(),
    online: () => true,
    timeoutMs: 500,
  });
  outbox.signedInAs('user-michael');
  const view = render(
    <QueryClientProvider client={client}>
      <OutboxProvider value={outbox}>
        <CarCapture
          dictating={dictating}
          wakeLock={wakeLock}
          vibrate={vibrate}
          capturedFor={capturedFor}
          finishWithin={finishWithin}
        />
      </OutboxProvider>
    </QueryClientProvider>,
  );
  // The button is there at once; what it captures into is read behind it.
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  });
  return Object.assign(userEvent.setup(), { unmount: view.unmount, vibrate });
}

const theButton = () => {
  const found = screen
    .getAllByRole('button')
    .find((one) => !(one.getAttribute('aria-label') ?? '').startsWith('Dictation language'));
  if (!found) throw new Error('no round button');
  return found;
};
const theTag = () => screen.getByRole('button', { name: /^Dictation language/ });
const theStatus = () => screen.getByRole('status');
const card = () => screen.getByLabelText('What was heard');

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

/** A tap to start, the engine starting, and a phrase heard: the view as it is part way through a note. */
async function listeningTo(
  user: ReturnType<typeof userEvent.setup>,
  current: () => ReturnType<ReturnType<typeof anEngine>['current']>,
  phrase?: string,
) {
  await user.click(theButton());
  current().begins();
  if (phrase) current().says(phrase);
}

describe('Capture', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    held.mutate.mockClear();
    vi.mocked(sendCommand).mockReset();
    vi.mocked(sendCommand).mockResolvedValue({ ok: true as const, applied: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    pageIs('visible');
    document.documentElement.removeAttribute('data-car-dark');
  });

  describe('the Car view is not offered where the browser cannot recognise speech', () => {
    it('says car mode is not available and draws no button', async () => {
      await theCar({ dictating: { engine: null } });

      expect(screen.getByRole('status')).toHaveTextContent(NO_SPEECH_HERE);
      expect(screen.queryAllByRole('button')).toHaveLength(0);
    });
  });

  describe('the second tap captures what was said at once, to Any workspace and the Type Capture starts on', () => {
    it('captures one note with no priority and no due date', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await listeningTo(user, current, 'buy oat milk');

      await user.click(theButton());

      const sent = await theCapture();
      expect(sent).toMatchObject({
        message: 'buy oat milk',
        workspaceId: 'ws-home',
        typeId: ACTION.id,
        workspaceDecided: false,
      });
      expect(sent).not.toHaveProperty('priority');
      expect(sent).not.toHaveProperty('dueDate');
      expect(capturedCalls()).toHaveLength(1);
    });

    it('starts on the Type the Capture form starts on: the one used last', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({
        dictating: { engine },
        items: [{ typeId: THOUGHT.id } as Item],
      });
      await listeningTo(user, current, 'maybe split the page');

      await user.click(theButton());

      expect((await theCapture()).typeId).toBe(THOUGHT.id);
    });

    it('captures the engine\'s final reading of a phrase still provisional at the second tap, once', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await listeningTo(user, current);
      const listening = current();
      listening.says('send the inv', false);
      // Asked to stop, the real engine settles on what it was working out and ends.
      listening.whenStopped = () => {
        listening.says('Send the invoice.', true, true);
        listening.endsOnItsOwn();
      };

      await user.click(theButton());

      expect((await theCapture()).message).toBe('Send the invoice.');
      await settled();
      expect(capturedCalls()).toHaveLength(1);
    });

    it('captures what was final after a short wait when the engine never finishes', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine }, finishWithin: 30 });
      await listeningTo(user, current, 'water the plants');
      current().says('and the', false);

      await user.click(theButton());

      // Nothing answers the stop, so it is the bound that ends the wait; what was still provisional is kept as it stood.
      expect((await theCapture()).message).toBe('water the plants and the');
    });

    it('captures what an Android phone heard once, the engine repeating each reading with more of it', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await listeningTo(user, current);

      current().saysSoFar('at', 'at a', 'at a dark', 'at a dark mode option');
      await user.click(theButton());

      expect((await theCapture()).message).toBe('at a dark mode option');
    });

    it('captures nothing when nothing was said, and says so before going back to the start', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await listeningTo(user, current);

      await user.click(theButton());

      await waitFor(() => expect(theStatus()).toHaveTextContent('Nothing heard'));
      await waitFor(() => expect(theStatus()).toHaveTextContent('Tap to speak'));
      await settled();
      expect(capturedCalls()).toHaveLength(0);
    });

    it('captures once when the second tap is pressed twice', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine }, finishWithin: 300, capturedFor: 200 });
      await listeningTo(user, current, 'call the dentist');

      await user.click(theButton());
      await user.click(theButton());
      // A third press once it has finished and shows ✓ is no more a capture than the second.
      await waitFor(() => expect(theStatus()).toHaveTextContent('Captured'));
      await user.click(theButton());

      await theCapture();
      await settled();
      expect(capturedCalls()).toHaveLength(1);
    });
  });

  describe('the button and the status line say which state the view is in, and the card shows the words as they are recognised', () => {
    it('is starting, not listening, until the engine reports it started', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      expect(theStatus()).toHaveTextContent('Tap to speak');

      await user.click(theButton());
      expect(current().asked).toBe(true);
      expect(theStatus()).toHaveTextContent('Starting…');

      current().begins();
      expect(theStatus()).toHaveTextContent('Listening — tap to capture');
      expect(theButton()).toHaveAccessibleName('Capture');
    });

    it('shows final words in the card and the ones still provisional set apart after them', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await listeningTo(user, current, 'first thing');

      current().says('and the sec', false);

      expect(card()).toHaveTextContent('first thing and the sec');
      expect(screen.getByTestId('provisional')).toHaveTextContent('and the sec');
      expect(screen.getByTestId('provisional')).not.toHaveTextContent('first thing');
    });

    it('says Capturing and takes no tap while the engine is finishing', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine }, finishWithin: 500 });
      await listeningTo(user, current, 'call the dentist');

      await user.click(theButton());

      expect(theStatus()).toHaveTextContent('Capturing…');
      expect(theButton()).toHaveAttribute('aria-disabled', 'true');
    });

    it('shows a tick and vibrates once the note is kept, then goes back to Tap to speak', async () => {
      const vibrate = vi.fn();
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine }, vibrate });
      await listeningTo(user, current, 'call the dentist');

      await user.click(theButton());

      await waitFor(() => expect(theStatus()).toHaveTextContent('Captured'));
      expect(theButton()).toHaveAccessibleName('Captured');
      expect(vibrate).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(theStatus()).toHaveTextContent('Tap to speak'));
      expect(theButton()).toHaveAccessibleName('Speak a note');
      expect(card()).not.toHaveTextContent('call the dentist');
    });

    it('shows no tick and does not vibrate while the note is still being written', async () => {
      const vibrate = vi.fn();
      const { engine, current } = anEngine();
      const writing: OutboxStore = {
        all: () => Promise.resolve([]),
        put: () => new Promise(() => {}),
        remove: () => Promise.resolve(),
      };
      const user = await theCar({ dictating: { engine }, vibrate, store: writing });
      await listeningTo(user, current, 'call the dentist');

      await user.click(theButton());
      await settled();

      expect(theStatus()).toHaveTextContent('Capturing…');
      expect(vibrate).not.toHaveBeenCalled();
    });

    it('lists the notes captured from here at the bottom, newest first', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      for (const note of ['first note', 'second note']) {
        await listeningTo(user, current, note);
        await user.click(theButton());
        await waitFor(() => expect(theStatus()).toHaveTextContent('Tap to speak'));
      }

      const rows = screen.getAllByRole('listitem').map((one) => one.textContent);
      expect(rows).toEqual(['second note', 'first note']);
    });
  });

  describe('when dictation fails, the status says why in large text, and words already heard are captured', () => {
    it.each([
      ['the microphone is blocked', 'not-allowed', DICTATION_BLOCKED],
      ['there is no microphone', 'audio-capture', DICTATION_NO_MICROPHONE],
      ['there is no connection', 'network', DICTATION_OFFLINE],
    ])('says so and captures nothing when %s before anything was heard', async (_situation, code, line) => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await user.click(theButton());

      current().fails(code);

      expect(theStatus()).toHaveTextContent(line);
      expect(theButton()).toHaveAccessibleName('Speak a note');
      await settled();
      expect(capturedCalls()).toHaveLength(0);
    });

    it('says so again when the same failure happens on the next try', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await user.click(theButton());
      current().fails('not-allowed');

      await user.click(theButton());
      expect(theStatus()).toHaveTextContent('Starting…');
      current().fails('not-allowed');

      expect(theStatus()).toHaveTextContent(DICTATION_BLOCKED);
      expect(theButton()).toHaveAccessibleName('Speak a note');
    });

    it('captures the words heard before an error, and says why it stopped', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await listeningTo(user, current, 'already said');
      current().says('and half of', false);

      current().fails('network');

      expect((await theCapture()).message).toBe('already said and half of');
      expect(theStatus()).toHaveTextContent(DICTATION_OFFLINE);
      expect(theStatus()).toHaveTextContent('What you said was captured.');
      await settled();
      expect(capturedCalls()).toHaveLength(1);
    });

    it('says why it stopped when the error comes while the second tap waits for the last words', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await listeningTo(user, current, 'already said');
      const listening = current();
      listening.whenStopped = () => listening.fails('network');

      await user.click(theButton());

      expect((await theCapture()).message).toBe('already said');
      expect(theStatus()).toHaveTextContent(DICTATION_OFFLINE);
      expect(theStatus()).toHaveTextContent('What you said was captured.');
    });

    it('clears the message once the next start succeeds', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await user.click(theButton());
      current().fails('network');
      expect(theStatus()).toHaveTextContent(DICTATION_OFFLINE);

      await user.click(theButton());
      current().begins();

      expect(theStatus()).toHaveTextContent('Listening — tap to capture');
      expect(theStatus()).not.toHaveTextContent(DICTATION_OFFLINE);
    });

    it('stops the engine and captures nothing when the view is left while listening', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await listeningTo(user, current, 'never captured');
      const listening = current();

      user.unmount();

      expect(listening.aborted).toBe(true);
      await settled();
      expect(capturedCalls()).toHaveLength(0);
    });
  });

  describe('the screen is held on while the Car view is shown and visible, and let go otherwise', () => {
    it('holds it once opened and says so', async () => {
      const { engine } = anEngine();
      const wake = aWakeLock();
      await theCar({ dictating: { engine }, wakeLock: wake.api });

      expect(wake.request).toHaveBeenCalledWith('screen');
      expect(screen.getByText(/Screen stays on/)).toBeInTheDocument();
    });

    it('takes it again when the page comes back into view', async () => {
      const { engine } = anEngine();
      const wake = aWakeLock();
      await theCar({ dictating: { engine }, wakeLock: wake.api });

      // The browser lets go of it when the page is hidden.
      pageIs('hidden');
      wake.taken[0]!.takenBack();
      pageIs('visible');

      await waitFor(() => expect(wake.request).toHaveBeenCalledTimes(2));
      expect(wake.taken[1]!.released).toBe(false);
    });

    it('does not ask while the page is hidden, and does once it is visible', async () => {
      const { engine } = anEngine();
      const wake = aWakeLock();
      await theCar({ dictating: { engine }, wakeLock: wake.api, hidden: true });
      expect(wake.request).not.toHaveBeenCalled();

      pageIs('visible');

      await waitFor(() => expect(wake.request).toHaveBeenCalledTimes(1));
    });

    it('lets go of it on leaving the view', async () => {
      const { engine } = anEngine();
      const wake = aWakeLock();
      const user = await theCar({ dictating: { engine }, wakeLock: wake.api });
      await waitFor(() => expect(wake.taken).toHaveLength(1));

      user.unmount();

      expect(wake.taken[0]!.released).toBe(true);
    });

    it.each([
      ['the browser has no wake lock', () => undefined],
      ['the request is refused', aWakeLock(true).api],
    ])('says the screen may lock, and still captures, when %s', async (_situation, wakeLock) => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine }, wakeLock });
      await waitFor(() => expect(screen.getByText(/may lock/)).toBeInTheDocument());

      await listeningTo(user, current, 'still captured');
      await user.click(theButton());

      expect((await theCapture()).message).toBe('still captured');
    });
  });

  describe('dictation is in one language at a time, English to start with, shared with the mic in Write', () => {
    it.each(['nl', 'nl-BE'])('starts on English when the browser is set to %s', async (browser) => {
      vi.spyOn(navigator, 'language', 'get').mockReturnValue(browser);
      const { engine } = anEngine();
      await theCar({ dictating: { engine } });

      expect(theTag()).toHaveTextContent('EN');
    });

    it('switches with the tag, listens in the new language next, and remembers it for the mic in Write', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });

      await user.click(theTag());
      expect(theTag()).toHaveTextContent('NL');
      await user.click(theButton());

      expect(current().lang).toBe('nl-NL');
      // What Write's mic reads on opening (`useDictation`).
      expect(readDictationLanguage(localStorage)).toBe('nl');
    });

    it('starts on Dutch where the mic in Write was set to Dutch', async () => {
      const { engine } = anEngine();
      await theCar({ dictating: { engine }, language: 'nl' });

      expect(theTag()).toHaveTextContent('NL');
    });

    it('takes no tap on the tag while listening', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine } });
      await listeningTo(user, current);

      expect(theTag()).toBeDisabled();
    });

    it('starts on English without an error where storage is unavailable', async () => {
      const { engine } = anEngine();
      const refusing = {
        getItem: () => {
          throw new Error('refused');
        },
        setItem: () => {
          throw new Error('refused');
        },
      } as unknown as Storage;
      const user = await theCar({ dictating: { engine, store: refusing } });

      expect(theTag()).toHaveTextContent('EN');
      await user.click(theTag());
      expect(theTag()).toHaveTextContent('NL');
      expect(theStatus()).toHaveTextContent('Tap to speak');
    });
  });

  describe('the dark view is switched from the footer, beside the language tag, at any time', () => {
    it.each([
      { situation: 'light', listening: false, status: 'Tap to speak' },
      { situation: 'listening', listening: true, status: 'Listening — tap to capture' },
    ])('$situation, tapped: goes dark and captures nothing', async ({ listening, status }) => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine, store: aStore() } });
      if (listening) await listeningTo(user, current);

      await user.click(theMoon());

      expect(theMoon()).toHaveAttribute('aria-pressed', 'true');
      expect(theMoon()).toHaveAttribute('title', 'Switch to the light view');
      expect(theStatus()).toHaveTextContent(status);
      await settled();
      expect(capturedCalls()).toHaveLength(0);
    });

    it('goes light again on the next tap', async () => {
      const { engine } = anEngine();
      const user = await theCar({ dictating: { engine, store: aStore() } });

      await user.click(theMoon());
      await user.click(theMoon());

      expect(theMoon()).toHaveAttribute('aria-pressed', 'false');
      expect(theMoon()).toHaveAttribute('title', 'Switch to the dark view');
    });

    it('still resets to Tap to speak after Captured while dark', async () => {
      const { engine, current } = anEngine();
      const user = await theCar({ dictating: { engine, store: aStore() }, capturedFor: 200 });
      await listeningTo(user, current, 'buy oat milk');
      await user.click(theButton());
      await waitFor(() => expect(theStatus()).toHaveTextContent('Captured'));

      await user.click(theMoon());

      expect(theMoon()).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(theStatus()).toHaveTextContent('Tap to speak'));
    });
  });

  describe('while the Car view is shown dark the document is flagged, and never otherwise', () => {
    const flagged = () => document.documentElement.hasAttribute('data-car-dark');

    it('flags the document while dark and takes the flag off on switching light', async () => {
      const { engine } = anEngine();
      const user = await theCar({ dictating: { engine, store: aStore() } });
      expect(flagged()).toBe(false);

      await user.click(theMoon());
      expect(flagged()).toBe(true);

      await user.click(theMoon());
      expect(flagged()).toBe(false);
    });

    it('takes the flag off on leaving, and puts it back on coming again from what was remembered', async () => {
      const { engine } = anEngine();
      const store = aStore();
      const first = await theCar({ dictating: { engine, store } });
      await first.click(theMoon());
      expect(flagged()).toBe(true);

      first.unmount();
      expect(flagged()).toBe(false);

      await theCar({ dictating: { engine: anEngine().engine, store } });
      expect(flagged()).toBe(true);
    });

    it('is not flagged, and says its message light, where there is no speech engine', async () => {
      await theCar({ dictating: { engine: null, store: aStore({ [CAR_DARK_KEY]: 'dark' }) } });

      expect(flagged()).toBe(false);
      expect(screen.getByRole('status')).toHaveTextContent(NO_SPEECH_HERE);
    });
  });

  describe('the dark choice is remembered on this device, and the view is light until first switched', () => {
    it('is light with nothing stored, whatever the phone is set to', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('dark'), media: query }));
      const { engine } = anEngine();
      await theCar({ dictating: { engine, store: aStore() } });

      expect(theMoon()).toHaveAttribute('aria-pressed', 'false');
      expect(document.documentElement.hasAttribute('data-car-dark')).toBe(false);
    });

    it('is dark when it is opened again after being switched dark', async () => {
      const { engine } = anEngine();
      const store = aStore();
      const first = await theCar({ dictating: { engine, store } });
      await first.click(theMoon());
      first.unmount();

      await theCar({ dictating: { engine: anEngine().engine, store } });

      expect(theMoon()).toHaveAttribute('aria-pressed', 'true');
    });

    it('is light where something unrecognised is stored', async () => {
      const { engine } = anEngine();
      await theCar({ dictating: { engine, store: aStore({ [CAR_DARK_KEY]: 'blue' }) } });

      expect(theMoon()).toHaveAttribute('aria-pressed', 'false');
    });

    it('still switches without an error where storage is unavailable', async () => {
      const { engine } = anEngine();
      const refusing = {
        getItem: () => {
          throw new Error('refused');
        },
        setItem: () => {
          throw new Error('refused');
        },
      } as unknown as Storage;
      const user = await theCar({ dictating: { engine, store: refusing } });
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
      { situation: 'the language tag and the switch', text: night('-ink-soft'), on: night('-card'), least: 4.5 },
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
