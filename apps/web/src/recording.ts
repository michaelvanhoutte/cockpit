import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MAX_RECORDING_SECONDS, uuidv7 } from '@cockpit/shared';
import { TooManyTranscriptions, transcribeRecording } from './api/transcription';
import { DICTATION_BLOCKED, DICTATION_FAILED, DICTATION_NO_MICROPHONE } from './dictation';
import { soundOf, type KeptRecording, type KeptRecordings } from './keptRecordings';

/**
 * Speaking a note by recording it and having Whisper write it down ("Dictate in
 * Write with Whisper", issue 1041, under "Dictate in Capture with Whisper
 * instead of the browser's speech engine", issue 1037).
 *
 * **Nothing here listens.** The phone's recorder keeps the sound; on stop the
 * whole recording goes to the Worker and the words come back in one piece. So
 * there is no provisional text, no language to choose - Whisper tells English
 * from Dutch itself - and no engine that ends on its own: a recording stops when
 * it is tapped off, or at the limit.
 *
 * Imported by the Capture form and the Car view ("Dictate in the Car view with
 * Whisper", issue 1042), which are fetched behind the shell (`captureForm.ts`),
 * so none of it is in the first bundle. The browser's speech engine is gone.
 */

/** One recording in progress. */
export interface RecordingSession {
  /**
   * Ends the recording and answers everything recorded, as one blob in the
   * recorder's own format. A recording that already ended by itself answers
   * what it had.
   */
  stop(): Promise<Blob>;
  /** Ends it and throws the sound away; the microphone is let go either way. */
  cancel(): void;
}

/** What a recording says while it runs. */
export interface RecordingEvents {
  /**
   * It ended without being stopped - the microphone taken by another app, the
   * phone locked, the recorder failing - and what it had is kept for `stop`.
   */
  endedByItself?: () => void;
}

/**
 * Asks for the microphone and starts recording. Rejects like `getUserMedia` does
 * (`NotAllowedError`, `NotFoundError`), whose names `whyItCouldNotRecord` reads.
 */
export type StartRecording = (events?: RecordingEvents) => Promise<RecordingSession>;

/** The formats tried in order, first supported wins: Chrome's, then whatever the browser writes by default (Safari's MP4). */
const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

/** A speech recording does not need more, and a long one stays well inside what the Worker takes. */
const BITS_PER_SECOND = 64_000;

/**
 * The browser's own recorder, or null where it cannot record audio at all: no
 * microphone API, no `MediaRecorder`, or a page that is not a secure context.
 * Read on each call, never at load.
 */
export function browserRecorder(): StartRecording | null {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  if (typeof MediaRecorder === 'undefined') return null;
  return async (events) => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const release = () => stream.getTracks().forEach((track) => track.stop());
    let recorder: MediaRecorder;
    try {
      const mimeType = PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: BITS_PER_SECOND });
      recorder.start();
    } catch (error) {
      release();
      throw error;
    }
    const chunks: Blob[] = [];
    /** Set once `stop` is asked for, so an end that follows it is not one the recording came to by itself. */
    let asked = false;
    let ended = false;
    let settle: (recording: Blob) => void = () => {};
    const finished = new Promise<Blob>((resolve) => {
      settle = resolve;
    });
    /** The recording is over, asked or not: what it had is the answer to `stop`. */
    const end = () => {
      if (ended) return;
      ended = true;
      release();
      settle(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      if (!asked) events?.endedByItself?.();
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = end;
    // A recorder that fails stops; what it recorded until then is still kept.
    recorder.onerror = () => {
      if (recorder.state === 'inactive') end();
    };
    return {
      stop: () => {
        asked = true;
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          end();
        }
        return finished;
      },
      cancel: () => {
        ended = true;
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          // A recorder that is already over has nothing to stop.
        }
        release();
      },
    };
  };
}

/** What a person is told when a transcription did not come back and the recording could not be kept, so it has to be said again. */
export const DICTATION_COULD_NOT_TRANSCRIBE = 'Could not transcribe that. Check your connection and dictate it again.';

/** And when it did not come back but the recording is kept, with Retry beside it (issue 1044). */
export const DICTATION_KEPT_TO_RETRY = 'Could not transcribe that. The recording is kept here to retry.';

/** What is told when the account was held to its 20 transcriptions a minute (issue 1043). */
export const DICTATION_TOO_MANY = 'Too many recordings were sent in a minute. Try again shortly.';

/** What is said after a recording stopped itself. */
export const DICTATION_STOPPED_AT_THE_LIMIT = `Stopped at the ${MAX_RECORDING_SECONDS / 60}-minute limit. What was said up to then is in the note.`;

/** The line for a microphone that would not start, per the way the browser refused. */
export function whyItCouldNotRecord(error: unknown): string {
  const name = typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return DICTATION_BLOCKED;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return DICTATION_NO_MICROPHONE;
    default:
      return DICTATION_FAILED;
  }
}

/** `0:07`, `12:30`: whole seconds as a clock. */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';

/** A recording kept for want of its words, as a view offers it with Retry. */
export interface WaitingRecording {
  id: string;
  /** When it was stopped. */
  recordedAt: string;
  /** How long it is, in whole seconds. */
  seconds: number;
  /** True while its Retry is underway in this tab. */
  retrying: boolean;
}

/** What the line says when the words did not come back, by whether the recording is kept to retry. */
function whyNotTranscribed(failure: unknown, kept: boolean): string {
  if (failure instanceof TooManyTranscriptions) return DICTATION_TOO_MANY;
  return kept ? DICTATION_KEPT_TO_RETRY : DICTATION_COULD_NOT_TRANSCRIBE;
}

/** Where nothing keeps recordings: the Car view, whose recordings the capture outbox keeps instead (issue 1045). */
const NO_KEEPER = {
  subscribe: () => () => {},
  getShown: (): KeptRecording[] => NOTHING_KEPT,
};
const NOTHING_KEPT: KeptRecording[] = [];

export interface RecordedDictation {
  /** Whether a mic is drawn: the browser can record and the page has a transcriber. */
  available: boolean;
  /** True only once the recorder has started, which is when the first words are being kept. */
  listening: boolean;
  /** True from the tap until the words are in the note: starting, recording or transcribing. */
  busy: boolean;
  transcribing: boolean;
  /** Whole seconds recorded so far. */
  seconds: number;
  /** The line saying why dictation did not finish, or null. */
  error: string | null;
  /** A line that is not a failure, such as the recording having stopped at the limit; or null. */
  notice: string | null;
  /** Starts recording, or stops it and transcribes. */
  toggle(): void;
  /**
   * Stops a recording if one is running and waits for its words to be in the
   * note, however far it has got. True when there is nothing more to wait for,
   * false when the words could not be had - the error says why.
   */
  finish(): Promise<boolean>;
  /** The recordings kept for want of their words, oldest first; none where nothing keeps them. */
  waiting: WaitingRecording[];
  /** Sends a kept recording again; its words land in the note once, however many tabs retry it. */
  retry(id: string): void;
}

/**
 * The state of a recording for a component: what the recorder and the page
 * offer, the four phases a view draws, and the words delivered to `onWords`.
 * `onWords` is read when the words arrive, so it may change every render.
 *
 * `record`, `transcribe` and `limitSeconds` are what a test hands in; a view
 * passes none of them. Unmounting while recording lets go of the microphone and
 * drops what was recorded, as closing the form means.
 *
 * **With `keeping`, a stopped recording is never lost** ("Keep a recording
 * Write could not transcribe, with Retry", issue 1044): it is kept on the
 * device before it is sent, and deleted only once its words are in the note,
 * so a transcription that fails, a form closed while it is out, and a page
 * closed before the answer each leave it waiting in `waiting`, with `retry`.
 * Where it cannot be kept it is sent as it is. A page hidden mid-recording - the
 * phone locked, another app opened - and a recorder that ends by itself each
 * stop it as a tap would, so what was said up to then goes the same way.
 */
export function useRecordedDictation({
  onWords,
  transcriber,
  record,
  transcribe = transcribeRecording,
  limitSeconds = MAX_RECORDING_SECONDS,
  keeping = null,
  onRecording,
}: {
  onWords: (words: string) => void;
  /**
   * Takes a stopped recording in place of transcribing it, which the Car view
   * does to keep it in the capture outbox ("Capture in the Car view without a
   * connection, from the recording", issue 1045). It stays *Transcribing…*
   * until this settles, and `onWords` is then never called.
   */
  onRecording?: (recording: Blob, seconds: number) => Promise<void>;
  /** Whether the Worker can transcribe, as `/health` says; false until known. */
  transcriber: boolean;
  record?: StartRecording | null;
  transcribe?: (recording: Blob) => Promise<string>;
  limitSeconds?: number;
  /** Where a recording waits for its words; none, and a recording whose words do not come back is lost. */
  keeping?: KeptRecordings | null;
}): RecordedDictation {
  const [start] = useState<StartRecording | null>(() => (record === undefined ? browserRecorder() : record));
  const [phase, setPhaseState] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const words = useRef(onWords);
  words.current = onWords;
  const transcribeNow = useRef(transcribe);
  transcribeNow.current = transcribe;
  const keeper = useRef(keeping);
  keeper.current = keeping;
  const handOver = useRef(onRecording);
  handOver.current = onRecording;
  const source = keeping ?? NO_KEEPER;
  const kept = useSyncExternalStore(source.subscribe, source.getShown, source.getShown);
  /**
   * The kept recordings this tab is transcribing now: a first attempt, not yet
   * offered for Retry, or a retry. A ref for the check, state for the drawing.
   */
  const inHandNow = useRef(new Map<string, 'first' | 'retry'>());
  const [inHand, setInHand] = useState<ReadonlyMap<string, 'first' | 'retry'>>(new Map());
  const holding = (id: string, how: 'first' | 'retry' | null) => {
    if (how === null) inHandNow.current.delete(id);
    else inHandNow.current.set(id, how);
    if (mounted.current) setInHand(new Map(inHandNow.current));
  };

  /** Mirrors `phase` for code that runs between renders. */
  const phaseNow = useRef<Phase>('idle');
  const setPhase = (next: Phase) => {
    phaseNow.current = next;
    setPhaseState(next);
  };
  const session = useRef<RecordingSession | null>(null);
  /** Set by a tap while the microphone is still being asked for: the session is let go once it arrives. */
  const letGo = useRef(false);
  /** The transcription underway, which Capture waits on. */
  const underway = useRef<Promise<boolean> | null>(null);
  const timers = useRef<{ tick: ReturnType<typeof setInterval>; limit: ReturnType<typeof setTimeout> } | null>(null);
  const mounted = useRef(true);
  /** When the recording running now started, for how long it is once stopped. */
  const startedAt = useRef(0);

  const stopTimers = () => {
    if (!timers.current) return;
    clearInterval(timers.current.tick);
    clearTimeout(timers.current.limit);
    timers.current = null;
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopTimers();
      session.current?.cancel();
      session.current = null;
    };
  }, []);

  /**
   * Keeps a stopped recording before it is sent, answering its id, or null
   * where it cannot be kept. Held as a first attempt before it is written, so
   * it is never offered for Retry while it is still on its way.
   */
  const keepIt = async (sound: Blob, length: number): Promise<string | null> => {
    if (!keeper.current) return null;
    const id = uuidv7();
    holding(id, 'first');
    try {
      await keeper.current.keep(sound, length, id);
      return id;
    } catch {
      holding(id, null);
      return null;
    }
  };

  /**
   * Transcribes a recording and puts its words in the note; a kept one is
   * deleted only once they are in. True when there is nothing more to wait
   * for - including where another tab already put them in its own note -
   * false where the form closed first and the recording stays. Throws where
   * the words did not come back.
   */
  const carryOver = async (sound: Blob, id: string | null): Promise<boolean> => {
    const text = await transcribeNow.current(sound);
    let delivered = false;
    const putIn = () => {
      if (!mounted.current) return false;
      words.current(text);
      delivered = true;
      return true;
    };
    if (id === null || !keeper.current) return putIn();
    try {
      return (await keeper.current.land(id, putIn)) !== 'not taken';
    } catch {
      // Storage failed around it: the words are not lost for that, though the
      // recording may stay to be offered again.
      return delivered || putIn();
    }
  };

  /** Ends the recording and carries its words into the note. */
  const stopAndTranscribe = (atTheLimit: boolean): Promise<boolean> => {
    const ended = session.current;
    if (!ended) return Promise.resolve(true);
    session.current = null;
    const length = Math.floor((Date.now() - startedAt.current) / 1000);
    stopTimers();
    setPhase('transcribing');
    const run = (async () => {
      let id: string | null = null;
      try {
        const sound = await ended.stop();
        // Handed over even where the view has gone meanwhile: it is the recording's keeper, not the view.
        if (handOver.current) {
          await handOver.current(sound, length);
          return true;
        }
        id = await keepIt(sound, length);
        const heard = await carryOver(sound, id);
        if (heard && atTheLimit && mounted.current) setNotice(DICTATION_STOPPED_AT_THE_LIMIT);
        return heard;
      } catch (failure) {
        if (mounted.current) setError(whyNotTranscribed(failure, id !== null));
        return false;
      } finally {
        if (id !== null) holding(id, null);
        underway.current = null;
        if (mounted.current) setPhase('idle');
      }
    })();
    underway.current = run;
    return run;
  };
  const stopNow = useRef(stopAndTranscribe);
  stopNow.current = stopAndTranscribe;

  // The page hidden mid-recording - the phone locked, another app opened - is a
  // stop: what was said up to then is kept and transcribed, not left running
  // where the browser may cut it off.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState !== 'hidden') return;
      if (phaseNow.current === 'recording') void stopNow.current(false);
      else if (phaseNow.current === 'starting') letGo.current = true;
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, []);

  const retry = (id: string) => {
    const keeping = keeper.current;
    if (!keeping || inHandNow.current.has(id)) return;
    const one = keeping.getShown().find((recording) => recording.id === id);
    if (!one) return;
    setError(null);
    setNotice(null);
    holding(id, 'retry');
    void (async () => {
      try {
        await carryOver(soundOf(one), id);
      } catch (failure) {
        if (mounted.current) setError(whyNotTranscribed(failure, true));
      } finally {
        holding(id, null);
      }
    })();
  };

  const begin = async () => {
    if (!start) return;
    setError(null);
    setNotice(null);
    letGo.current = false;
    setPhase('starting');
    let started: RecordingSession;
    let mine: RecordingSession | null = null;
    try {
      started = await start({
        // Only the recording running now: one already stopped or let go has nothing more to say.
        endedByItself: () => {
          if (mine !== null && session.current === mine) void stopNow.current(false);
        },
      });
      mine = started;
    } catch (failure) {
      if (!mounted.current) return;
      setPhase('idle');
      setError(whyItCouldNotRecord(failure));
      return;
    }
    if (!mounted.current || letGo.current) {
      started.cancel();
      if (mounted.current) setPhase('idle');
      return;
    }
    session.current = started;
    const from = Date.now();
    startedAt.current = from;
    setSeconds(0);
    setPhase('recording');
    timers.current = {
      tick: setInterval(() => setSeconds(Math.floor((Date.now() - from) / 1000)), 1000),
      limit: setTimeout(() => void stopAndTranscribe(true), limitSeconds * 1000),
    };
  };

  return {
    available: start !== null && transcriber,
    listening: phase === 'recording',
    busy: phase !== 'idle',
    transcribing: phase === 'transcribing',
    seconds,
    error,
    notice,
    waiting: kept
      .filter((one) => inHand.get(one.id) !== 'first')
      .map((one) => ({
        id: one.id,
        recordedAt: one.recordedAt,
        seconds: one.seconds,
        retrying: inHand.get(one.id) === 'retry',
      })),
    retry,
    toggle: () => {
      switch (phaseNow.current) {
        case 'idle':
          void begin();
          break;
        case 'starting':
          letGo.current = true;
          break;
        case 'recording':
          void stopAndTranscribe(false);
          break;
        case 'transcribing':
          break;
      }
    },
    finish: () => {
      switch (phaseNow.current) {
        case 'recording':
          return stopAndTranscribe(false);
        case 'transcribing':
          return underway.current ?? Promise.resolve(true);
        case 'starting':
          // Nothing has been recorded yet, and what is being asked for is let go.
          letGo.current = true;
          return Promise.resolve(true);
        case 'idle':
          return Promise.resolve(true);
      }
    },
  };
}
