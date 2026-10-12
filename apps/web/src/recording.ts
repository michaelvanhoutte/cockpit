import { useEffect, useRef, useState } from 'react';
import { MAX_RECORDING_SECONDS } from '@cockpit/shared';
import { transcribeRecording } from './api/transcription';
import { DICTATION_BLOCKED, DICTATION_FAILED, DICTATION_NO_MICROPHONE } from './dictation';

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
 * Imported by the Capture form, which is fetched behind the shell
 * (`captureForm.ts`), so none of it is in the first bundle. The Car view still
 * dictates through `dictation.ts` until its own unit lands.
 */

/** One recording in progress. */
export interface RecordingSession {
  /** Ends the recording and answers everything recorded, as one blob in the recorder's own format. */
  stop(): Promise<Blob>;
  /** Ends it and throws the sound away; the microphone is let go either way. */
  cancel(): void;
}

/**
 * Asks for the microphone and starts recording. Rejects like `getUserMedia` does
 * (`NotAllowedError`, `NotFoundError`), whose names `whyItCouldNotRecord` reads.
 */
export type StartRecording = () => Promise<RecordingSession>;

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
  return async () => {
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
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    return {
      stop: () =>
        new Promise<Blob>((resolve, reject) => {
          recorder.onstop = () => {
            release();
            resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
          };
          recorder.onerror = () => {
            release();
            reject(new Error('the recorder failed'));
          };
          try {
            recorder.stop();
          } catch (error) {
            release();
            reject(error);
          }
        }),
      cancel: () => {
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

/** What a person is told when a transcription did not come back; the recording is not kept, so this says to say it again. */
export const DICTATION_COULD_NOT_TRANSCRIBE = 'Could not transcribe that. Check your connection and dictate it again.';

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
}

/**
 * The state of a recording for a component: what the recorder and the page
 * offer, the four phases a view draws, and the words delivered to `onWords`.
 * `onWords` is read when the words arrive, so it may change every render.
 *
 * `record`, `transcribe` and `limitSeconds` are what a test hands in; a view
 * passes none of them. Unmounting lets go of the microphone and drops whatever
 * was recorded.
 */
export function useRecordedDictation({
  onWords,
  transcriber,
  record,
  transcribe = transcribeRecording,
  limitSeconds = MAX_RECORDING_SECONDS,
}: {
  onWords: (words: string) => void;
  /** Whether the Worker can transcribe, as `/health` says; false until known. */
  transcriber: boolean;
  record?: StartRecording | null;
  transcribe?: (recording: Blob) => Promise<string>;
  limitSeconds?: number;
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

  /** Ends the recording and carries its words into the note. */
  const stopAndTranscribe = (atTheLimit: boolean): Promise<boolean> => {
    const ended = session.current;
    if (!ended) return Promise.resolve(true);
    session.current = null;
    stopTimers();
    setPhase('transcribing');
    const run = (async () => {
      try {
        const text = await transcribeNow.current(await ended.stop());
        if (!mounted.current) return false;
        words.current(text);
        if (atTheLimit) setNotice(DICTATION_STOPPED_AT_THE_LIMIT);
        return true;
      } catch {
        if (mounted.current) setError(DICTATION_COULD_NOT_TRANSCRIBE);
        return false;
      } finally {
        underway.current = null;
        if (mounted.current) setPhase('idle');
      }
    })();
    underway.current = run;
    return run;
  };

  const begin = async () => {
    if (!start) return;
    setError(null);
    setNotice(null);
    letGo.current = false;
    setPhase('starting');
    let started: RecordingSession;
    try {
      started = await start();
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
