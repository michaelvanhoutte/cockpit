import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from '@cockpit/shared';
import { snapshotQuery, workspacesQuery } from '../api/queries';
import { useAppearance } from '../appearance';
import { browserStore, workspaceToCaptureFrom } from '../lastVisited';
import { useCapture } from '../capture';
import { useOutbox } from '../captureOutboxSender';
import { typesOffered } from '../itemTypes';
import { transcriptionOffered } from '../api/transcription';
import { browserRecorder, clock, useRecordedDictation, type StartRecording } from '../recording';
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
 * A transcription that fails says why in large text and captures nothing.
 *
 * **Once the words are back they are captured at once.** The note goes to *Any
 * workspace* with the Type Capture starts on, no priority and no due date,
 * through the same outbox the Capture form keeps its notes in
 * (`captureOutboxSender.tsx`). Transcribing needs a connection, so with none
 * nothing is captured.
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

type Phase = 'idle' | 'starting' | 'listening' | 'transcribing' | 'capturing' | 'captured' | 'nothing';

/** The status line for each phase. */
const STATUS: Record<Phase, string> = {
  idle: 'Tap to speak',
  starting: 'Starting…',
  listening: 'Listening — tap to capture',
  transcribing: 'Transcribing…',
  capturing: 'Capturing…',
  captured: 'Captured',
  nothing: 'Nothing heard',
};

export const NO_RECORDING_HERE = 'Car capture needs a browser that can record audio, and this one cannot.';
export const NO_TRANSCRIBER_HERE = 'Car capture needs Cockpit to transcribe speech, and this one cannot.';
export const CAR_NO_WORKSPACE = 'There is no workspace to capture into.';
export const CAR_STILL_READING = 'Still reading your workspace. Tap to try again.';
export const CAR_NO_TYPES = 'There is no type to give a note. Make one in a workspace first.';

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

/** One note captured from this view, as it is listed. */
interface Recent {
  id: string;
  message: string;
}

/** What the view records with and transcribes with: the browser's recorder and the Worker, unless a test hands in fakes. */
interface Dictating {
  record?: StartRecording | null;
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
    queryKey: ['transcription-offered'],
    queryFn: transcriptionOffered,
    retry: false,
    staleTime: 5 * 60_000,
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
  const { data: list } = useQuery(workspacesQuery);
  const workspaces = list?.workspaces ?? [];
  // The workspace this is captured *from*, which every Item records even while
  // it belongs to none, and the type it starts on: the same two answers the
  // Capture form gives (components/CaptureNote.tsx).
  const from = workspaceToCaptureFrom(browserStore(), workspaces);
  const snapshot = useQuery({ ...snapshotQuery(from ?? ''), enabled: Boolean(from) });
  const chosen = typesOffered(snapshot.data?.itemTypes ?? [], snapshot.data?.items ?? [])[0];
  const answered = snapshot.data?.itemTypes !== undefined;

  const outbox = useOutbox();
  const { ask } = useCapture();
  const screen = useScreenWakeLock(wakeLock);

  /**
   * Where the note is once the words are back: being written to the outbox, kept
   * (✓), or empty. Recording and transcribing are the recorder's, not kept here.
   */
  const [outcome, setOutcome] = useState<'idle' | 'capturing' | 'captured' | 'nothing'>('idle');
  /** Why nothing could be captured, said as the status until the next tap. */
  const [why, setWhy] = useState<string | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
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

  // What the capture is made from, as it stands when the words arrive.
  const target = useRef({ from, chosen, answered });
  target.current = { from, chosen, answered };

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

  /**
   * Keeps what was said, or says there was nothing. **Never waits on the
   * network**: the button reads ✓ and the phone vibrates once the note is
   * written to the outbox, which sends it behind - not before, since a ✓ for a
   * note still being written is lost to a reload.
   */
  const keep = (heard: string) => {
    const message = heard.trim();
    if (!message) {
      setOutcome('nothing');
      resetSoon();
      return;
    }
    const { from: workspaceId, chosen: type, answered: known } = target.current;
    if (!workspaceId || !type) {
      setWhy(!workspaceId ? CAR_NO_WORKSPACE : known ? CAR_NO_TYPES : CAR_STILL_READING);
      setOutcome('idle');
      return;
    }
    const id = uuidv7();
    const what = { message, typeId: type.id, workspaceId, decided: false };
    const captured = () => {
      setRecent((was) => [{ id, message }, ...was]);
      setOutcome('captured');
      vibrate(200);
      resetSoon();
    };
    setOutcome('capturing');
    // ✓ only once the note is kept, so leaving at the vibration loses nothing;
    // the write is local and quick. Where the outbox cannot be written (a
    // private window), it is sent at once instead.
    void outbox.add({ ...what, id, files: [] }).then(captured, () => {
      captured();
      ask(what, {
        refused: (reason) => {
          setRecent((was) => was.filter((one) => one.id !== id));
          setWhy(reason);
        },
      });
    });
  };

  const dictation = useRecordedDictation({
    record: dictating.record ?? null,
    ...(dictating.transcribe ? { transcribe: dictating.transcribe } : {}),
    ...(dictating.limitSeconds ? { limitSeconds: dictating.limitSeconds } : {}),
    // The view is only drawn where a transcriber was found or is still being asked.
    transcriber: true,
    onWords: keep,
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
    capturing: 'Capturing',
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
              phase === 'transcribing' || phase === 'capturing' || phase === 'captured' || phase === 'nothing'
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
        {recent.length > 0 && (
          <ul aria-label="Captured here" className="mt-2">
            {recent.slice(0, RECENT).map((one) => (
              <li key={one.id} className={`truncate py-0.5 ${d('text-ink-soft', 'text-night-ink-soft')}`}>
                {one.message}
              </li>
            ))}
          </ul>
        )}
      </footer>
    </div>
  );
}
