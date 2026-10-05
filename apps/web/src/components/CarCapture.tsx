import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from '@cockpit/shared';
import { snapshotQuery, workspacesQuery } from '../api/queries';
import { browserStore, workspaceToCaptureFrom } from '../lastVisited';
import { useCapture } from '../capture';
import { useOutbox } from '../captureOutboxSender';
import { typesOffered } from '../itemTypes';
import {
  DICTATION_LANGUAGES,
  appendPhrase,
  replacePhrase,
  browserEngine,
  useDictation,
  type EngineFactory,
} from '../dictation';
import { browserWakeLock, useScreenWakeLock, type WakeLockApi } from '../wakeLock';

/**
 * The Car view of the phone Capture page ("Capture by voice in the car", issue
 * 730): one round button, tapped to start listening and tapped again to capture
 * what was said, with nothing to read or choose in between.
 *
 * **The second tap captures at once.** The note goes to *Any workspace* with
 * the Type Capture starts on, no priority and no due date, through the same
 * outbox the Capture form keeps its notes in (`captureOutboxSender.tsx`), so
 * it is kept offline like any other. Listening is the Capture form's own
 * (`dictation.ts`), so pauses are ridden through and a failure is said the same
 * way - except that **words already heard when dictation fails are captured**,
 * since a half note in the Inbox beats a lost one.
 *
 * **The screen is kept on for as long as this is shown** (`wakeLock.ts`).
 *
 * **It can be switched dark from its footer** ("Switch the Car view dark from
 * inside it", issue 753), for capturing at night. The choice is this device's,
 * light until first switched whatever the phone's own setting says. While shown
 * dark it flags the document (`CAR_DARK_FLAG`); the page heading, the Write | Car
 * switch, the shell's edge and the band under the tabs are styled from that flag
 * in `styles.css`. The flag is cleared on switching light and on leaving, so
 * Write and every other screen are never dark.
 *
 * Fetched behind the shell with the Capture form (`captureForm.ts`), so none of
 * it is in the first bundle.
 */

type Phase = 'idle' | 'starting' | 'listening' | 'capturing' | 'captured' | 'nothing';

/** The status line for each phase. */
const STATUS: Record<Phase, string> = {
  idle: 'Tap to speak',
  starting: 'Starting…',
  listening: 'Listening — tap to capture',
  capturing: 'Capturing…',
  captured: 'Captured',
  nothing: 'Nothing heard',
};

export const NO_SPEECH_HERE = 'Car capture needs speech recognition, which this browser does not have.';
export const CAR_NO_WORKSPACE = 'There is no workspace to capture into.';
export const CAR_STILL_READING = 'Still reading your workspace. Tap to try again.';
export const CAR_NO_TYPES = 'There is no type to give a note. Make one in a workspace first.';
export const WHAT_WAS_HEARD_WAS_CAPTURED = 'What you said was captured.';

const SCREEN_LINES = {
  held: 'Screen stays on while this is open',
  asking: 'Screen stays on while this is open',
  unavailable: 'This browser cannot keep the screen on, so it may lock',
};

/** Where the dark choice is kept: this browser, not the account, as the dictation language is. */
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

export function CarCapture({
  dictating,
  wakeLock = browserWakeLock,
  vibrate = (pattern) => globalThis.navigator?.vibrate?.(pattern),
  capturedFor = 2000,
  finishWithin = 1500,
}: {
  /** Where speech comes from and where the language is kept: the browser's own, unless a test hands in a fake. */
  dictating?: { engine?: EngineFactory | null; store?: Storage | undefined } | undefined;
  /** The browser's wake lock, or a fake. */
  wakeLock?: () => WakeLockApi | undefined;
  /** The phone's vibration, which a desktop browser does not have. */
  vibrate?: (pattern: number | number[]) => unknown;
  /** How long ✓ Captured stays before the button resets, in milliseconds. */
  capturedFor?: number;
  /** The longest to wait for the engine's last words after the second tap, in milliseconds. */
  finishWithin?: number;
}) {
  const [hasEngine] = useState(() => {
    const factory = dictating?.engine === undefined ? browserEngine : dictating.engine;
    return factory !== null && factory() !== null;
  });
  if (!hasEngine) {
    return (
      <p role="status" className="mt-8 text-center text-2xl leading-snug font-medium text-ink">
        {NO_SPEECH_HERE}
      </p>
    );
  }
  return (
    <Driving
      dictating={dictating}
      wakeLock={wakeLock}
      vibrate={vibrate}
      capturedFor={capturedFor}
      finishWithin={finishWithin}
    />
  );
}

function Driving({
  dictating,
  wakeLock,
  vibrate,
  capturedFor,
  finishWithin,
}: {
  dictating: { engine?: EngineFactory | null; store?: Storage | undefined } | undefined;
  wakeLock: () => WakeLockApi | undefined;
  vibrate: (pattern: number | number[]) => unknown;
  capturedFor: number;
  finishWithin: number;
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

  const [phase, setPhaseState] = useState<Phase>('idle');
  // Read by the second tap and by the engine's events, which do not wait for a render.
  const phaseNow = useRef<Phase>('idle');
  const setPhase = (next: Phase) => {
    phaseNow.current = next;
    setPhaseState(next);
  };
  /** Why dictation stopped, or why nothing could be captured: said as the status until the next start succeeds. */
  const [why, setWhy] = useState<string | null>(null);
  /** What has been settled on this time, and what the engine is still working out. */
  const said = useRef('');
  const [wordsShown, setWordsShown] = useState('');
  const [provisional, setProvisional] = useState('');
  const [recent, setRecent] = useState<Recent[]>([]);
  const store = dictating?.store ?? browserStore();
  const [dark, setDark] = useState(() => readCarDark(store));
  const toggleDark = () => {
    writeCarDark(store, !dark);
    setDark(!dark);
  };
  // Before the view first paints, so opening it dark never shows a light frame.
  useLayoutEffect(() => {
    if (!dark) return;
    document.documentElement.setAttribute(CAR_DARK_FLAG, '');
    return () => document.documentElement.removeAttribute(CAR_DARK_FLAG);
  }, [dark]);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const keepNow = useRef<(heard: string, stoppedBecause: string | null) => void>(() => {});
  /** An error raised while the second tap waits for the last words: the capture that follows says it. */
  const failedWhileCapturing = useRef<string | null>(null);
  const dictation = useDictation({
    ...dictating,
    // An error while listening: what was heard is captured, and the status says why it stopped.
    onFailure: (reason) => {
      if (phaseNow.current === 'capturing') {
        failedWhileCapturing.current = reason;
        return;
      }
      if (phaseNow.current !== 'starting' && phaseNow.current !== 'listening') return;
      const heard = said.current.trim();
      keepNow.current(heard, heard ? `${reason} ${WHAT_WAS_HEARD_WAS_CAPTURED}` : reason);
    },
    onPhrase: (text, final, replaces) => {
      if (final) {
        said.current = replaces
          ? replacePhrase(said.current, replaces, text)
          : appendPhrase(said.current, text);
        setWordsShown(said.current);
      } else {
        setProvisional(text);
      }
    },
  });

  // What the capture is made from, as it stands when it is asked for.
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
    resetTimer.current = setTimeout(() => {
      said.current = '';
      setWordsShown('');
      setProvisional('');
      setPhase('idle');
    }, capturedFor);
  };

  /**
   * Keeps what was heard, or says there was nothing. **Never waits on the
   * network**: the button reads ✓ and the phone vibrates once the note is
   * written to the outbox, which sends it behind - not before, since a ✓ for a
   * note still being written is lost to a reload.
   */
  const keep = (heard: string, stoppedBecause: string | null) => {
    const message = heard.trim();
    if (!message) {
      setPhase(stoppedBecause ? 'idle' : 'nothing');
      if (stoppedBecause) setWhy(stoppedBecause);
      else resetSoon();
      return;
    }
    const { from: workspaceId, chosen: type, answered: known } = target.current;
    if (!workspaceId || !type) {
      // Said rather than swallowed, with the words still on the card to be read back.
      setWhy(!workspaceId ? CAR_NO_WORKSPACE : known ? CAR_NO_TYPES : CAR_STILL_READING);
      setPhase('idle');
      return;
    }
    const id = uuidv7();
    const what = { message, typeId: type.id, workspaceId, decided: false };
    const captured = () => {
      setRecent((was) => [{ id, message }, ...was]);
      setWhy(stoppedBecause);
      setPhase('captured');
      vibrate(200);
      resetSoon();
    };
    setPhase('capturing');
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

  keepNow.current = keep;

  // Listening is what the engine says, so the button turns to stop only once it has started.
  useEffect(() => {
    if (dictation.listening && phaseNow.current === 'starting') {
      setPhase('listening');
      setWhy(null);
    }
  }, [dictation.listening]);

  const tap = () => {
    const now = phaseNow.current;
    if (now === 'idle') {
      said.current = '';
      setWordsShown('');
      setProvisional('');
      setPhase('starting');
      dictation.toggle();
    } else if (now === 'starting' || now === 'listening') {
      // Set before the wait, so a second press of the same button is not a second capture.
      setPhase('capturing');
      failedWhileCapturing.current = null;
      void dictation.finish(finishWithin).then(() => {
        const reason = failedWhileCapturing.current;
        const heard = said.current.trim();
        keep(heard, reason && (heard ? `${reason} ${WHAT_WAS_HEARD_WAS_CAPTURED}` : reason));
      });
    }
  };

  const status = phase === 'idle' || phase === 'captured' ? (why ?? STATUS[phase]) : STATUS[phase];
  const listening = phase === 'listening';
  const settled = phase === 'captured';
  const label = {
    idle: 'Speak a note',
    starting: 'Starting',
    listening: 'Capture',
    capturing: 'Capturing',
    captured: 'Captured',
    nothing: 'Nothing heard',
  }[phase];
  const { tag, name } = DICTATION_LANGUAGES[dictation.language];
  const heardSoFar = appendPhrase(wordsShown, provisional);
  /** The light class, or the dark one. */
  const d = (light: string, night: string) => (dark ? night : light);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center">
      <div
        aria-label="What was heard"
        className={`mt-4 min-h-28 w-full rounded-md border p-4 text-lg leading-snug ${d(
          'border-black/10 bg-white text-ink shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)]',
          'border-white/5 bg-night-card text-night-ink',
        )}`}
      >
        {heardSoFar ? (
          <>
            <span>{wordsShown}</span>
            {provisional && (
              <span data-testid="provisional" className={d('text-ink-faint', 'text-night-faint')}>
                {wordsShown ? ' ' : ''}
                {provisional}
              </span>
            )}
          </>
        ) : (
          <span className={d('text-ink-faint', 'text-night-faint')}>What you say shows here.</span>
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
            aria-disabled={phase === 'capturing' || phase === 'captured' || phase === 'nothing'}
            className={`milled relative flex size-40 items-center justify-center rounded-full ${d(
              'text-white shadow-lg',
              'text-[#c9cbd1] brightness-[0.7]',
            )} ${listening ? 'bg-over-deep' : settled ? 'bg-accent-deep' : d('bg-accent', 'bg-accent-deep')}`}
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
            phase === 'idle' && why
              ? d('text-over-deep', 'text-night-over')
              : d('text-ink', 'text-night-ink')
          }`}
        >
          {status}
        </p>
      </div>

      <footer
        className={`w-full border-t pt-3 text-sm ${d(
          'border-[rgb(41_43_49/0.08)] text-ink-faint',
          'border-white/5 text-night-ink-soft',
        )}`}
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={dictation.toggleLanguage}
            disabled={phase !== 'idle'}
            aria-label={`Dictation language: ${name}`}
            title={`Dictating in ${name}. Press to switch.`}
            className={`inline-flex min-h-9 items-center rounded-md border px-3 text-sm font-medium tracking-[0.05em] disabled:opacity-50 ${d(
              'border-black/10 bg-white text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink',
              'border-white/10 bg-night-card text-night-ink-soft',
            )}`}
          >
            {tag}
          </button>
          <button
            type="button"
            onClick={toggleDark}
            aria-pressed={dark}
            aria-label="Dark view"
            title={dark ? 'Switch to the light view' : 'Switch to the dark view'}
            className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-md border px-2 ${d(
              'border-black/10 bg-white text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink',
              'border-white/10 bg-night-card text-night-ink-soft',
            )}`}
          >
            {dark ? (
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
