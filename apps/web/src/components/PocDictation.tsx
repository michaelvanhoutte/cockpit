import { useEffect, useRef, useState } from 'react';
import { appendPhrase, replacePhrase } from '../dictation';

/**
 * THROWAWAY POC - "is a better engine better on my voice?". Not to be merged.
 *
 * While Chrome's engine listens, the phone also records the audio. When
 * listening stops, the recording and Chrome's text go to `/v1/poc/dictation`,
 * and the three readings are shown side by side, with a tally of which one
 * was picked as best, kept on this device.
 */
type Reading = { text: string | null; ms: number; error?: string; language?: string };
type Compared = { chrome: string; whisper: Reading; corrected: Reading; bytes: number };
type State =
  | { at: 'idle' }
  | { at: 'recording' }
  | { at: 'sending' }
  | { at: 'done'; result: Compared; picked?: Engine }
  | { at: 'failed'; why: string; chrome: string };
type Engine = 'chrome' | 'corrected' | 'whisper';

const TALLY_KEY = 'cockpit.poc-dictation-tally';
const NAMES: Record<Engine, string> = {
  chrome: 'A · Chrome (today)',
  corrected: 'B · Chrome + Claude',
  whisper: 'C · Whisper',
};

function readTally(): Record<Engine, number> {
  try {
    const stored = JSON.parse(localStorage.getItem(TALLY_KEY) ?? '{}') as Partial<Record<Engine, number>>;
    return { chrome: stored.chrome ?? 0, corrected: stored.corrected ?? 0, whisper: stored.whisper ?? 0 };
  } catch {
    return { chrome: 0, corrected: 0, whisper: 0 };
  }
}

export function usePocDictation(listening: boolean) {
  const [state, setState] = useState<State>({ at: 'idle' });
  const heardText = useRef('');
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const micError = useRef<string | null>(null);

  useEffect(() => {
    if (listening) {
      heardText.current = '';
      chunks.current = [];
      micError.current = null;
      setState({ at: 'recording' });
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          const made = new MediaRecorder(stream);
          made.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.current.push(e.data);
          };
          made.onstop = () => {
            stream.getTracks().forEach((track) => track.stop());
            void send(new Blob(chunks.current, { type: made.mimeType }));
          };
          made.start();
          recorder.current = made;
        })
        .catch((err: Error) => {
          micError.current = `Recording alongside Chrome failed: ${err.name} ${err.message}`;
        });
      return;
    }
    const made = recorder.current;
    recorder.current = null;
    if (made && made.state !== 'inactive') {
      setState({ at: 'sending' });
      // Lets the last phrase Chrome settles on land before the text is read.
      setTimeout(() => made.stop(), 400);
    } else if (micError.current) {
      setState({ at: 'failed', why: micError.current, chrome: heardText.current });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  async function send(audio: Blob) {
    try {
      const answer = await fetch('/v1/poc/dictation', {
        method: 'POST',
        headers: {
          'content-type': audio.type || 'application/octet-stream',
          'x-chrome-text': encodeURIComponent(heardText.current),
        },
        body: audio,
      });
      if (!answer.ok) throw new Error(`${answer.status} ${await answer.text()}`);
      setState({ at: 'done', result: (await answer.json()) as Compared });
    } catch (err) {
      setState({ at: 'failed', why: (err as Error).message, chrome: heardText.current });
    }
  }

  return {
    state,
    /** Chrome's phrases, kept the way the note keeps them. */
    heard(text: string, final: boolean, replaces?: string) {
      if (!final) return;
      heardText.current = replaces ? replacePhrase(heardText.current, replaces, text) : appendPhrase(heardText.current, text);
    },
    pick(engine: Engine) {
      if (state.at !== 'done' || state.picked) return;
      const tally = readTally();
      tally[engine] += 1;
      try {
        localStorage.setItem(TALLY_KEY, JSON.stringify(tally));
      } catch {
        // Not remembered.
      }
      setState({ ...state, picked: engine });
    },
    dismiss: () => setState({ at: 'idle' }),
  };
}

export function PocCompare({
  poc,
  onUse,
}: {
  poc: ReturnType<typeof usePocDictation>;
  onUse: (text: string) => void;
}) {
  const { state } = poc;
  if (state.at === 'idle') return null;
  const tally = readTally();
  return (
    <div className="order-1 mt-2 rounded border border-dashed border-gray-400 p-2 text-sm sm:order-none">
      <div className="mb-1 flex items-center justify-between font-semibold">
        <span>POC: which heard you best?</span>
        <button type="button" className="px-2 text-gray-500" onClick={poc.dismiss} aria-label="Close the comparison">
          ×
        </button>
      </div>
      {state.at === 'recording' && <p>Recording alongside Chrome…</p>}
      {state.at === 'sending' && <p>Transcribing with Whisper and correcting with Claude…</p>}
      {state.at === 'failed' && <p className="text-over">Comparison failed: {state.why}</p>}
      {state.at === 'done' &&
        (
          [
            ['chrome', { text: state.result.chrome, ms: 0 }],
            ['corrected', state.result.corrected],
            ['whisper', state.result.whisper],
          ] as [Engine, Reading][]
        ).map(([engine, reading]) => (
          <div key={engine} className={`mt-2 rounded p-1 ${state.picked === engine ? 'bg-green-100' : ''}`}>
            <div className="text-xs text-gray-500">
              {NAMES[engine]}
              {reading.ms ? ` · ${(reading.ms / 1000).toFixed(1)}s` : ''}
              {reading.language ? ` · heard as ${reading.language}` : ''}
            </div>
            {reading.text !== null ? (
              <p className="whitespace-pre-wrap">{reading.text || <em>(nothing)</em>}</p>
            ) : (
              <p className="text-over">{reading.error}</p>
            )}
            {reading.text && (
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  disabled={state.picked !== undefined}
                  className="rounded border px-2 py-1 disabled:opacity-40"
                  onClick={() => poc.pick(engine)}
                >
                  Best
                </button>
                <button type="button" className="rounded border px-2 py-1" onClick={() => onUse(reading.text!)}>
                  Use as note
                </button>
              </div>
            )}
          </div>
        ))}
      <p className="mt-2 text-xs text-gray-500">
        Picked best so far: A {tally.chrome} · B {tally.corrected} · C {tally.whisper}
      </p>
    </div>
  );
}
