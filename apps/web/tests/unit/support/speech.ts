import { act } from '@testing-library/react';
import type { EngineFactory, RecognitionEngine, RecognitionResultEvent } from '../../../src/dictation';

/**
 * The browser's speech engine, which is a third party and has no working
 * implementation in jsdom or in Playwright's Chromium: this one does what it is
 * told. `start()` only records the ask - the `start` event is `begins()`, the
 * way the real one reports it a moment later.
 *
 * `stop()` does nothing unless a test says what the real engine does when
 * asked to stop (`whenStopped`): deliver its last reading and end, or never
 * answer at all.
 */
export class FakeEngine implements RecognitionEngine {
  lang = '';
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: RecognitionResultEvent) => void) | null = null;
  asked = false;
  aborted = false;
  whenStopped: (() => void) | null = null;
  /** Everything said so far this session, as the engine reports it: cumulative. */
  private heard: { isFinal: boolean; 0: { transcript: string } }[] = [];
  start() {
    this.asked = true;
  }
  stop() {
    this.whenStopped?.();
  }
  abort() {
    this.aborted = true;
  }
  begins() {
    act(() => this.onstart?.());
  }
  /** One phrase heard: provisional until `isFinal`, and replacing the last one while it still is. */
  says(transcript: string, isFinal = true, replacing = false) {
    if (replacing) this.heard.pop();
    this.heard.push({ isFinal, 0: { transcript } });
    const resultIndex = this.heard.length - 1;
    act(() => this.onresult?.({ resultIndex, results: this.heard }));
  }
  endsOnItsOwn() {
    act(() => this.onend?.());
  }
  fails(error: string) {
    act(() => this.onerror?.({ error }));
  }
}

/** A browser with an engine, and every engine it has made. */
export function anEngine() {
  const made: FakeEngine[] = [];
  const engine: EngineFactory = () => {
    const one = new FakeEngine();
    made.push(one);
    return one;
  };
  return {
    engine,
    /** Sessions the engine was asked to start, newest last. */
    sessions: () => made.filter((one) => one.asked),
    /** The session listening now. */
    current: () => made.filter((one) => one.asked).at(-1)!,
  };
}
