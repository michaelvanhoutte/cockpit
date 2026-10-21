import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from '@cockpit/shared';
import { useWorkspaces } from '../api/useWorkspaces';
import { useAppearance } from '../appearance';
import { browserStore, workspaceToCaptureFrom } from '../lastVisited';
import { useCapture } from '../capture';
import { stateOf } from '../captureOutbox';
import { useOutbox, useWaitingCaptures, type Heard } from '../captureOutboxSender';
import { useKeptRecordings } from '../keptRecordings';
import { TooManyTranscriptions, transcribeRecording, transcriptionOfferedQuery } from '../api/transcription';
import {
  DICTATION_COULD_NOT_TRANSCRIBE,
  DICTATION_TOO_MANY,
  browserRecorder,
  clock,
  useRecordedDictation,
  type StartRecording,
} from '../recording';
import { browserWakeLock, useScreenWakeLock, type WakeLockApi } from '../wakeLock';

/**
 * The Car view of the phone Capture page ("Capture by voice in the car", issue
 * 730): one round button, tapped to start recording and tapped again to capture
 * what was said, with nothing to read or choose in between.
 *
 * **Recorded and transcribed as Write's mic is** ("Dictate in the Car view with
 * Whisper", issue 1042, under issue 1037): the recording is the Capture form's
 * own (`recording.ts`), so the card shows a running time in place of live words,
 * *Transcribing…* follows the second tap, and Whisper tells English from Dutch
 * itself. A recording that reaches the limit stops and is captured as if tapped.
 *
 * **The recording is captured, not only its words** ("Capture in the Car view
 * without a connection, from the recording", issue 1045). On the second tap it
 * goes into the same outbox the Capture form keeps its notes in
 * (`captureOutboxSender.tsx`), to *Any workspace*, no priority and no due date; the outbox transcribes it and sends the
 * capture. The button shows ✓ as soon as the words are kept - or, with no
 * connection, a transcription that fails or the account at its limit, as soon
 * as that is known, and the note is listed as waiting for its words until the
 * outbox can get them, while Cockpit is open. Only where the outbox cannot be
 * written is it transcribed here and sent directly, and lost if that fails.
 * A note spoken before the workspaces have been read waits for them rather
 * than being thrown away, and one with no workspace to go into is kept under Write's strip with Retry, as Write keeps its own.
 *
 * **The screen is kept on for as long as this is shown** (`wakeLock.ts`).
 *
 * **It can be switched dark from its footer** ("Switch the Car view dark from
 * inside it", issue 753), for capturing at night. The choice is this device's,
 * light until first switched whatever the phone's own setting says. While shown
 * dark it flags the document (`CAR_DARK_FLAG`); the page heading, the Write | Car
 * switch, the shell's edge and the band under the tabs are styled from that flag
 * in `styles.css`. The flag is set too whenever the app is dark ("Keep the Car
 * view dark whenever the app is", issue 845), and the switch is hidden then,
 * since pressing it would change nothing; it returns, with this choice as it
 * was, once the app is light. The flag is cleared on switching light and on
 * leaving, so Write and every other screen are never dark by it.
 *
 * Fetched behind the shell with the Capture form (`captureForm.ts`), so none of
 * it is in the first bundle.
 */

type Phase = 'idle' | 'starting' | 'listening' | 'transcribing' | 'captured' | 'nothing';

/** The status line for each phase. */
const STATUS: Record<Phase, string> = {
  idle: 'Tap to speak',
  starting: 'Starting…',
  listening: 'Listening — tap to capture',
  transcribing: 'Transcribing…',
  captured: 'Captured',
  nothing: 'Nothing heard',
};

/** How a spoken note is listed while the outbox still waits to transcribe it. */
export const WAITING_FOR_WORDS = 'Waiting for its words';

/** How long a note spoken before the workspaces have been read waits for them. */
const STILL_READING_FOR_MS = 10_000;

export const NO_RECORDING_HERE = 'Car capture needs a browser that can record audio, and this one cannot.';
export const NO_TRANSCRIBER_HERE = 'Car capture needs Cockpit to transcribe speech, and this one cannot.';
export const CAR_NO_WORKSPACE = 'There is no workspace to capture into.';
export const CAR_STILL_READING = 'Still reading your workspace. Tap to try again.';
/** Said after either of those where the recording could be kept, as Write keeps one it could not transcribe. */
export const CAR_KEPT_IN_WRITE = 'The recording is kept in Write to retry.';

const SCREEN_LINES = {
  held: 'Screen stays on while this is open',
  asking: 'Screen stays on while this is open',
  unavailable: 'This browser cannot keep the screen on, so it may lock',
};

/** Where the dark choice is kept: this browser, not the account. */
export const CAR_DARK_KEY = 'cockpit.car-dark';

/** The attribute set on the document while the view is shown dark. */
export const CAR_DARK_FLAG = 'data-car-dark';

/** Whether the view was last left dark on this device: light where nothing, or nothing recognised, is stored. */
export function readCarDark(store: Storage | undefined): boolean {
  try {
    return store?.getItem(CAR_DARK_KEY) === 'dark';
  } catch {
    // Storage refused: nothing was remembered, so light.
    return false;
  }
}

export function writeCarDark(store: Storage | undefined, dark: boolean): void {
  try {
    store?.setItem(CAR_DARK_KEY, dark ? 'dark' : 'light');
  } catch {
    // Not remembered; this visit still uses the choice.
  }
}

/** How many of the notes captured from this view are listed. */
const RECENT = 3;

/** One note captured from this view, by its Item's id, with its words where they were had here. */
interface Recent {
  id: string;
  message: string | null;
}

/** What the view records with and transcribes with: the browser's recorder and the Worker, unless a test hands in fakes. */
interface Dictating {
  record?: StartRecording | null;
  /** Used only where the outbox cannot be written; the outbox transcribes with its own sender. */
  transcribe?: (recording: Blob) => Promise<string>;
  /** Whether the Worker can transcribe; left out, the page asks `/health`. */
  transcriber?: boolean;
  limitSeconds?: number;
  /** Where the dark choice is kept. */
  store?: Storage | undefined;
}

export function CarCapture({
  dictating,
  wakeLock = browserWakeLock,
  vibrate = (pattern) => globalThis.navigator?.vibrate?.(pattern),
  capturedFor = 2000,
}: {
  dictating?: Dictating | undefined;
  /** The browser's wake lock, or a fake. */
  wakeLock?: () => WakeLockApi | undefined;
  /** The phone's vibration, which a desktop browser does not have. */
  vibrate?: (pattern: number | number[]) => unknown;
  /** How long ✓ Captured stays before the button resets, in milliseconds. */
  capturedFor?: number;
}) {
  const [record] = useState<StartRecording | null>(() =>
    dictating?.record === undefined ? browserRecorder() : dictating.record,
  );
  const transcribable = useQuery({
    ...transcriptionOfferedQuery,
    enabled: record !== null && dictating?.transcriber === undefined,
  });
  const transcriber = dictating?.transcriber ?? transcribable.data;
  const unavailable = record === null ? NO_RECORDING_HERE : transcriber === false ? NO_TRANSCRIBER_HERE : null;
  if (unavailable) {
    return (
      <p role="status" className="mt-8 text-center text-2xl leading-snug font-medium text-ink">
        {unavailable}
      </p>
    );
  }
  return (
    <Driving
      dictating={{ ...dictating, record }}
      wakeLock={wakeLock}
      vibrate={vibrate}
      capturedFor={capturedFor}
    />
  );
}

function Driving({
  dictating,
  wakeLock,
  vibrate,
  capturedFor,
}: {
  dictating: Dictating;
  wakeLock: () => WakeLockApi | undefined;
  vibrate: (pattern: number | number[]) => unknown;
  capturedFor: number;
}) {
  const { data: list } = useWorkspaces();
  const workspaces = list?.workspaces ?? [];
  // The workspace this is captured *from*, which every Item records even while
  // it belongs to none: the same answer the Capture form gives
  // (components/CaptureNote.tsx).
  const from = workspaceToCaptureFrom(browserStore(), workspaces);
  /** Whether there is an answer to what a note is captured into, even "nothing". */
  const readYet = list !== undefined;

  const outbox = useOutbox();
  const waitingHere = useWaitingCaptures();
  const keptRecordings = useKeptRecordings();
  const { ask } = useCapture();
  const screen = useScreenWakeLock(wakeLock);

  /** Where the note is once its first try at words is over: kept (✓), or empty. Recording and transcribing are the recorder's. */
  const [outcome, setOutcome] = useState<'idle' | 'captured' | 'nothing'>('idle');
  /** Why nothing could be captured, said as the status until the next tap. */
  const [why, setWhy] = useState<string | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  /** The words of notes that landed while this was open, in this tab or another. */
  const [landedWords, setLandedWords] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(
    () =>
      outbox.onLanding(({ entry }) => {
        if (entry.message) setLandedWords((was) => new Map(was).set(entry.id, entry.message));
      }),
    [outbox],
  );
  const store = dictating.store ?? browserStore();
  /** This view's own choice, kept while the app is dark and not shown then. */
  const [chosenDark, setDark] = useState(() => readCarDark(store));
  const appDark = useAppearance() === 'dark';
  /** The night look: the view's own choice, or the app being dark. */
  const dark = chosenDark || appDark;
  const toggleDark = () => {
    writeCarDark(store, !chosenDark);
    setDark(!chosenDark);
  };
  // Before the view first paints, so opening it dark never shows a light frame.
  useLayoutEffect(() => {
    if (!dark) return;
    document.documentElement.setAttribute(CAR_DARK_FLAG, '');
    return () => document.documentElement.removeAttribute(CAR_DARK_FLAG);
  }, [dark]);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // What the capture is made from, as it stands when the recording is handed over.
  const target = useRef({ from, readYet });
  target.current = { from, readYet };
  /** Notes waiting for the workspaces to be read, told once they have been. */
  const whenRead = useRef(new Set<() => void>());
  useEffect(() => {
    if (readYet) for (const told of [...whenRead.current]) told();
  });

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const resetSoon = () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setOutcome('idle'), capturedFor);
  };

  /** What a note is captured into, once read - or as it stands after a while of waiting for it. */
  const onceRead = () =>
    new Promise<typeof target.current>((resolve) => {
      if (target.current.readYet) return resolve(target.current);
      const told = () => {
        clearTimeout(late);
        whenRead.current.delete(told);
        resolve(target.current);
      };
      const late = setTimeout(told, STILL_READING_FOR_MS);
      whenRead.current.add(told);
    });

  /** ✓, the vibration, and the note at the top of the list. */
  const captured = (id: string, message: string | null) => {
    setRecent((was) => [{ id, message }, ...was]);
    setOutcome('captured');
    vibrate(200);
    resetSoon();
  };

  const nothingHeard = () => {
    setOutcome('nothing');
    resetSoon();
  };

  /**
   * Keeps the recording, or says there was nothing in it. **Never waits on the
   * capture reaching the server**: ✓ shows once the words are kept in the
   * outbox, or once it is known they cannot be had yet - never before the
   * recording is written, since a ✓ for one still being written is lost to a
   * reload.
   */
  const keepRecording = async (sound: Blob, seconds: number) => {
    const { from: workspaceId, readYet: known } = await onceRead();
    if (!workspaceId) {
      const reason = known ? CAR_NO_WORKSPACE : CAR_STILL_READING;
      // Nothing to capture it into, so kept under Write's strip with Retry rather than lost.
      const keptForWrite = await keptRecordings.keep(sound, seconds, uuidv7()).then(
        () => true,
        () => false,
      );
      setWhy(keptForWrite ? `${reason} ${CAR_KEPT_IN_WRITE}` : reason);
      return;
    }
    const id = uuidv7();
    const what = { workspaceId, decided: false };
    let heard: Heard;
    try {
      heard = await outbox.addRecorded({ ...what, id, recording: sound, seconds });
    } catch {
      // The outbox cannot be written (a private window): transcribed here and sent at once.
      await sendDirectly(sound, what, id);
      return;
    }
    if (heard === 'nothing') {
      // Said here, so it is not also left among the notes not sent.
      void outbox.remove(id).catch(() => undefined);
      nothingHeard();
      return;
    }
    captured(id, null);
  };

  const sendDirectly = async (
    sound: Blob,
    what: { workspaceId: string; decided: boolean },
    id: string,
  ) => {
    let message: string;
    try {
      message = (await (dictating.transcribe ?? transcribeRecording)(sound)).trim();
    } catch (failure) {
      setWhy(failure instanceof TooManyTranscriptions ? DICTATION_TOO_MANY : DICTATION_COULD_NOT_TRANSCRIBE);
      return;
    }
    if (!message) return nothingHeard();
    captured(id, message);
    ask(
      { ...what, message },
      {
        refused: (reason) => {
          setRecent((was) => was.filter((one) => one.id !== id));
          setWhy(reason);
        },
      },
    );
  };

  const dictation = useRecordedDictation({
    record: dictating.record ?? null,
    ...(dictating.limitSeconds ? { limitSeconds: dictating.limitSeconds } : {}),
    // The view is only drawn where a transcriber was found or is still being asked.
    transcriber: true,
    onWords: () => undefined,
    onRecording: keepRecording,
  });

  /**
   * The notes captured from here, newest first: those of this visit, and the
   * spoken ones the outbox still holds, which a reload keeps. Each by its
   * words, or as waiting for them.
   */
  const stillWaiting = waitingHere.filter((entry) => entry.recording && stateOf(entry).waiting);
  // One kept from before a reload stays listed, by its words, once it lands.
  const waitingIds = stillWaiting.map((entry) => entry.id).join(' ');
  useEffect(() => {
    const ids = waitingIds ? waitingIds.split(' ') : [];
    setRecent((was) => {
      const missing = ids.filter((id) => !was.some((one) => one.id === id));
      return missing.length === 0 ? was : [...was, ...missing.map((id) => ({ id, message: null }))];
    });
  }, [waitingIds]);
  const listed = [...new Set([...recent.map((one) => one.id), ...stillWaiting.map((entry) => entry.id)])]
    // Ids are made in time order, so the newest is the greatest.
    .sort((a, b) => (a < b ? 1 : -1))
    .flatMap((id) => {
      const entry = stillWaiting.find((one) => one.id === id);
      if (entry) return [{ id, words: entry.message || WAITING_FOR_WORDS, waiting: !entry.message }];
      const words = recent.find((one) => one.id === id)?.message ?? landedWords.get(id);
      return words ? [{ id, words, waiting: false }] : [];
    });

  const tap = () => {
    if (outcome !== 'idle') return;
    if (!dictation.busy) setWhy(null);
    dictation.toggle();
  };

  const phase: Phase =
    outcome !== 'idle'
      ? outcome
      : dictation.transcribing
        ? 'transcribing'
        : dictation.listening
          ? 'listening'
          : dictation.busy
            ? 'starting'
            : 'idle';
  /** Why nothing could be captured, in large text: shown in place of the idle line. */
  const problem = phase === 'idle' ? (why ?? dictation.error) : null;
  const status = problem ?? STATUS[phase];
  const listening = phase === 'listening';
  const settled = phase === 'captured';
  const label = {
    idle: 'Speak a note',
    starting: 'Starting',
    listening: 'Capture',
    transcribing: 'Transcribing',
    captured: 'Captured',
    nothing: 'Nothing heard',
  }[phase];
  /** The light class, or the dark one. */
  const d = (light: string, night: string) => (dark ? night : light);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center">
      <div
        aria-label="Recording"
        className={`mt-4 min-h-28 w-full rounded-md border p-4 text-lg leading-snug ${d(
          'border-shade/10 bg-field text-ink shadow-field',
          'border-white/5 bg-night-card text-night-ink',
        )}`}
      >
        {listening ? (
          <span className="tabular-nums">Listening · {clock(dictation.seconds)}</span>
        ) : (
          <span className={d('text-ink-faint', 'text-night-faint')}>
            {phase === 'transcribing' ? 'Transcribing…' : 'Tap the button and speak.'}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col items-center justify-center py-6">
        <div className="relative">
          {listening && (
            <span
              aria-hidden="true"
              className={`absolute inset-0 rounded-full motion-safe:animate-ping ${d('bg-over/40', 'bg-over/15')}`}
            />
          )}
          <button
            type="button"
            onClick={tap}
            aria-label={label}
            aria-disabled={
              phase === 'transcribing' || phase === 'captured' || phase === 'nothing'
            }
            className={`milled relative flex size-40 items-center justify-center rounded-full ${
              dark
                ? `text-night-icon brightness-[0.7] ${listening ? 'bg-over-deep' : 'bg-accent-deep'}`
                : `shadow-lg ${
                    listening
                      ? 'bg-over-deep text-white'
                      : settled
                        ? 'bg-accent-deep text-white'
                        : 'bg-accent text-on-accent'
                  }`
            }`}
          >
            {listening ? (
              <svg viewBox="0 0 16 16" className="size-14" aria-hidden="true">
                <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
              </svg>
            ) : settled ? (
              <span aria-hidden="true" className="text-6xl leading-none">
                ✓
              </span>
            ) : (
              <svg viewBox="0 0 16 16" className="size-16" aria-hidden="true">
                <rect
                  x="5.5"
                  y="1.5"
                  width="5"
                  height="8"
                  rx="2.5"
                  fill="currentColor"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <path
                  d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>
        <p
          role="status"
          className={`mt-6 text-center text-2xl leading-snug font-medium ${
            problem
              ? d('text-over-deep-ink', 'text-night-over')
              : d('text-ink', 'text-night-ink')
          }`}
        >
          {status}
        </p>
      </div>

      <footer
        className={`w-full border-t pt-3 text-sm ${d(
          'border-shade/8 text-ink-faint',
          'border-white/5 text-night-ink-soft',
        )}`}
      >
        <div className="flex items-center gap-3">
          {!appDark && (
            <button
              type="button"
              onClick={toggleDark}
              aria-pressed={chosenDark}
              aria-label="Dark view"
              title={chosenDark ? 'Switch to the light view' : 'Switch to the dark view'}
              className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border px-2 ${d(
                'border-shade/10 bg-field text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink',
                'border-white/10 bg-night-card text-night-ink-soft',
              )}`}
            >
              {chosenDark ? (
                <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
                  <circle cx="8" cy="8" r="3" fill="currentColor" />
                  <path
                    d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
                  <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" fill="currentColor" />
                </svg>
              )}
            </button>
          )}
          <span>{SCREEN_LINES[screen]}</span>
        </div>
        {listed.length > 0 && (
          <ul aria-label="Captured here" className="mt-2">
            {listed.slice(0, RECENT).map((one) => (
              <li
                key={one.id}
                className={`truncate py-0.5 ${
                  one.waiting ? d('text-ink-faint', 'text-night-faint') : d('text-ink-soft', 'text-night-ink-soft')
                }`}
              >
                {one.words}
              </li>
            ))}
          </ul>
        )}
      </footer>
    </div>
  );
}
