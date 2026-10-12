import { act } from '@testing-library/react';
import { TooManyTranscriptions } from '../../../src/api/transcription';
import type { RecordingSession, StartRecording } from '../../../src/recording';

/**
 * The phone's recorder and the Worker's transcription, both of which are third
 * parties here and have no working implementation in jsdom: these do what they
 * are told. A recording is a tiny blob; what matters is when it started, when it
 * was stopped or let go, and what the transcription answers and when.
 */

export class FakeRecording implements RecordingSession {
  stopped = false;
  cancelled = false;
  stop(): Promise<Blob> {
    this.stopped = true;
    return Promise.resolve(new Blob(['audio'], { type: 'audio/webm' }));
  }
  cancel(): void {
    this.cancelled = true;
  }
}

/** A browser that can record, and every recording it has made. */
export function aRecorder() {
  const made: FakeRecording[] = [];
  let refusal: { name: string } | null = null;
  let held: ((session: FakeRecording) => void) | null = null;
  let holdNext = false;
  const record: StartRecording = () => {
    if (refusal) return Promise.reject(Object.assign(new Error('refused'), refusal));
    const session = new FakeRecording();
    made.push(session);
    if (holdNext) {
      holdNext = false;
      return new Promise((resolve) => {
        held = resolve as (session: FakeRecording) => void;
      });
    }
    return Promise.resolve(session);
  };
  return {
    record,
    /** Every recording started, newest last. */
    recordings: () => made,
    /** The recording in progress now. */
    current: () => made.at(-1)!,
    /** The next ask for the microphone is refused the way `getUserMedia` refuses: by the error's name. */
    refusesWith(name: string) {
      refusal = { name };
    },
    /** The next ask for the microphone waits, as it does while the permission prompt is up. */
    holdsTheNextAsk() {
      holdNext = true;
    },
    /** The permission was given. */
    async allows() {
      await act(async () => held?.(made.at(-1)!));
    },
  };
}

/** A transcription that answers when the test says so. */
export function aTranscriber() {
  const asked: { resolve: (words: string) => void; reject: (reason: Error) => void }[] = [];
  return {
    transcribe: (_recording: Blob) =>
      new Promise<string>((resolve, reject) => {
        asked.push({ resolve, reject });
      }),
    /** How many recordings were sent. */
    sent: () => asked.length,
    async answers(words: string) {
      await act(async () => asked.at(-1)!.resolve(words));
    },
    async fails() {
      await act(async () => asked.at(-1)!.reject(new Error('no connection')));
    },
    /** The Worker held the account to its transcriptions a minute. */
    async isTurnedAway() {
      await act(async () => asked.at(-1)!.reject(new TooManyTranscriptions()));
    },
  };
}
