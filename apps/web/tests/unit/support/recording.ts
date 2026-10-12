import { act } from '@testing-library/react';
import { TooManyTranscriptions } from '../../../src/api/transcription';
import type { RecordingEvents, RecordingSession, StartRecording } from '../../../src/recording';

/**
 * The phone's recorder and the Worker's transcription, both of which are third
 * parties here and have no working implementation in jsdom: these do what they
 * are told. A recording is a tiny blob; what matters is when it started, when it
 * was stopped or let go, and what the transcription answers and when.
 */

export class FakeRecording implements RecordingSession {
  stopped = false;
  cancelled = false;
  constructor(private readonly events: RecordingEvents = {}) {}
  stop(): Promise<Blob> {
    this.stopped = true;
    return Promise.resolve(new Blob(['audio'], { type: 'audio/webm' }));
  }
  cancel(): void {
    this.cancelled = true;
  }
  /** The recorder ended without being stopped: the microphone taken, the recorder failing. */
  async endsByItself() {
    await act(async () => this.events.endedByItself?.());
  }
}

/** A browser that can record, and every recording it has made. */
export function aRecorder() {
  const made: FakeRecording[] = [];
  let refusal: { name: string } | null = null;
  let held: ((session: FakeRecording) => void) | null = null;
  let holdNext = false;
  const record: StartRecording = (events) => {
    if (refusal) return Promise.reject(Object.assign(new Error('refused'), refusal));
    const session = new FakeRecording(events);
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

/** A few turns of the event loop: a recording is kept on the device before it is sent, and its words land after the device is asked again. */
const deviceTurns = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A transcription that answers when the test says so. Each answer goes to the
 * latest request still waiting, waited for where it has not been sent yet, and
 * returns once what follows from it on the device has settled.
 */
export function aTranscriber() {
  const asked: { resolve: (words: string) => void; reject: (reason: Error) => void; settled: boolean }[] = [];
  const settle = async (how: (one: (typeof asked)[number]) => void) => {
    await act(async () => {
      let waiting = asked.filter((one) => !one.settled).at(-1);
      for (let i = 0; !waiting && i < 50; i++) {
        await deviceTurns();
        waiting = asked.filter((one) => !one.settled).at(-1);
      }
      if (!waiting) throw new Error('nothing was sent to transcribe');
      waiting.settled = true;
      how(waiting);
      await deviceTurns();
    });
  };
  return {
    transcribe: (_recording: Blob) =>
      new Promise<string>((resolve, reject) => {
        asked.push({ resolve, reject, settled: false });
      }),
    /** How many recordings were sent. */
    sent: () => asked.length,
    answers: (words: string) => settle((one) => one.resolve(words)),
    fails: () => settle((one) => one.reject(new Error('no connection'))),
    /** The Worker held the account to its transcriptions a minute. */
    isTurnedAway: () => settle((one) => one.reject(new TooManyTranscriptions())),
  };
}
