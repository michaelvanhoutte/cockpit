import { useEffect, useRef, useState } from 'react';
import { browserStore } from './lastVisited';

/**
 * Speaking a note instead of typing it ("Dictate a note in Capture", issue 714).
 *
 * **The browser's own speech recognition and nothing of ours**: no key, no cost,
 * and no audio ever reaches Cockpit's server - it goes to whichever vendor backs
 * the browser, and needs a connection. This file is the whole of how a view
 * drives that engine, so a second view - hands-free capture in a car - takes
 * `useDictation` and the same language choice rather than a second copy of any
 * of it.
 *
 * Imported only by the Capture form and the Car view, which are fetched behind
 * the shell (`captureForm.ts`), so none of it is in the first bundle.
 *
 * Three parts, each small: the **language** choice remembered on this device,
 * the **engine** wrapped as `DictationSession` (what to do on each event the
 * browser raises), and `useDictation`, which is the session for a component.
 */

/** English or Dutch, one at a time: the engine must be told which before it listens, and cannot tell. */
export type DictationLanguage = 'en' | 'nl';

export const DICTATION_LANGUAGES: Record<
  DictationLanguage,
  { tag: string; name: string; locale: string }
> = {
  en: { tag: 'EN', name: 'English', locale: 'en-US' },
  nl: { tag: 'NL', name: 'Dutch', locale: 'nl-NL' },
};

/**
 * Where the choice is kept: this browser, not the account. It is how a person
 * speaks into this device rather than a fact about them, so it needs no sync and
 * no stored data of its own. **Shared by every view that dictates**, so
 * choosing Dutch on Capture is Dutch in the car too. Not forgotten at sign-out,
 * for the same reason: it says nothing about whoever was signed in.
 */
export const DICTATION_LANGUAGE_KEY = 'cockpit.dictation-language';

/**
 * The language last chosen on this device, and **English whatever the browser's
 * own language is** where nothing was chosen or storage refuses - a Dutch-set
 * browser was a poor guess for someone who mostly dictates in English.
 */
export function readDictationLanguage(store: Storage | undefined): DictationLanguage {
  try {
    const stored = store?.getItem(DICTATION_LANGUAGE_KEY);
    if (stored === 'nl') return 'nl';
  } catch {
    // Storage refused: nothing was remembered, so English.
  }
  return 'en';
}

export function writeDictationLanguage(store: Storage | undefined, language: DictationLanguage): void {
  try {
    store?.setItem(DICTATION_LANGUAGE_KEY, language);
  } catch {
    // Not remembered; this visit still uses the choice.
  }
}

/** The part of the browser's recognition object this uses, which is also all a test's fake has to offer. */
export interface RecognitionEngine {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  start(): void;
  /** Ends and delivers what it has heard so far. */
  stop(): void;
  /** Ends and delivers nothing more. */
  abort(): void;
}

export interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

/** Makes one engine, or answers null where the browser has none. */
export type EngineFactory = () => RecognitionEngine | null;

/** The browser's own engine: standard where it is, prefixed in Chrome, Edge and Safari. Read on each call, never at load. */
export const browserEngine: EngineFactory = () => {
  const scope = globalThis as unknown as {
    SpeechRecognition?: new () => RecognitionEngine;
    webkitSpeechRecognition?: new () => RecognitionEngine;
  };
  const Engine = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return Engine ? new Engine() : null;
};

/** What a person is told when dictation cannot run, per the way the engine said so. */
export const DICTATION_BLOCKED = 'Dictation needs the microphone, which is blocked for this site.';
export const DICTATION_NO_MICROPHONE = 'No microphone was found to dictate with.';
export const DICTATION_OFFLINE = 'Dictation needs a connection, and could not reach one.';
export const DICTATION_FAILED = 'Dictation could not start.';

function whyItStopped(code: string): string | null {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return DICTATION_BLOCKED;
    case 'audio-capture':
      return DICTATION_NO_MICROPHONE;
    case 'network':
      return DICTATION_OFFLINE;
    // Silence and our own stopping are the engine's ordinary ways of ending.
    case 'no-speech':
    case 'aborted':
      return null;
    default:
      return DICTATION_FAILED;
  }
}

/** A phrase added to a note: after a space, unless the note is empty or already ends in whitespace. */
export function appendPhrase(note: string, phrase: string): string {
  const said = phrase.trim();
  if (!said) return note;
  if (!note.trim()) return said;
  return /\s$/.test(note) ? `${note}${said}` : `${note} ${said}`;
}

/** The words of a reading as the engine's own wording leaves them: lower case, no punctuation. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether `reading` is the same stretch of speech as `earlier`, heard again
 * with more of it or with a word corrected, rather than a phrase of its own.
 *
 * **Chrome on Android reports each reading of the session so far as a final
 * result of its own** ("at", "at a", "at a dark"), where a desktop engine
 * reports each phrase once ("add a", "dark mode"). Both arrive the same way, so
 * only the words tell them apart: a reading is the earlier one again when it is
 * longer and its words, in the same places, repeat at least half of the earlier
 * ones - all of them for a plain continuation, a good part where the engine
 * revised a word on the way ("at a" then "add a dark mode"). Separate phrases
 * share no words in the same places, bar the odd coincidence, which costs a
 * phrase the next one then stands in for. A repeat of the very same words is
 * the same reading, so it replaces rather than adds.
 */
export function isLaterReadingOf(earlier: string, reading: string): boolean {
  const before = wordsOf(earlier);
  const after = wordsOf(reading);
  if (before.length === 0 || after.length < before.length) return false;
  const same = before.filter((word, i) => after[i] === word).length;
  if (after.length === before.length) return same === before.length;
  return same * 2 >= before.length;
}

/** A note with `reading` in the place of `earlier` at its end; added after the note where the note no longer ends with it. */
export function replacePhrase(note: string, earlier: string, reading: string): string {
  const old = earlier.trim();
  const body = note.trimEnd();
  if (old && body.endsWith(old)) return appendPhrase(body.slice(0, body.length - old.length), reading);
  return appendPhrase(note, reading);
}

export interface DictationHandlers {
  /** Whether the engine is actually listening: true only once it has said it started. */
  onListening(listening: boolean): void;
  /**
   * A phrase: final once the engine has settled on it, otherwise provisional and
   * to be replaced. Empty provisional text clears. A final that is a later
   * reading of the one before it in the same listening session names that one in
   * `replaces`: the view puts it in that one's place, not after it.
   */
  onPhrase(text: string, final: boolean, replaces?: string): void;
  /** Why dictation stopped, or null once a start succeeds. */
  onError(message: string | null): void;
}

/**
 * One engine's life, from a tap on the mic to the next tap.
 *
 * **Listening is what the engine says, not what was asked**: a tap only asks, and
 * the `start` event is the moment the first words will be heard, so that is when
 * it is reported - not before, or the first words go to a button that looked ready.
 *
 * **While listening, an end the engine makes on its own** (silence, a blip)
 * silently begins a new session; only `stop` or an error ends it. Words spoken
 * in the gap, well under a second, can be lost. A session that ends without ever
 * starting is not restarted, which would be a loop.
 */
export class DictationSession {
  private engine: RecognitionEngine | null = null;
  private wanted = false;
  private started = false;
  private interim = '';
  /** The last final this engine session reported, so a later reading of the same words can replace it. Empty on a new session. */
  private lastFinal = '';
  /** Set while `finish` waits for the engine's last words; calling it ends the wait. */
  private finishing: (() => void) | null = null;

  constructor(
    private readonly make: EngineFactory,
    private readonly language: () => DictationLanguage,
    private readonly on: DictationHandlers,
  ) {}

  /** True from the tap until it is stopped, whether or not the engine has started yet. */
  get asked(): boolean {
    return this.wanted;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.begin();
  }

  /** Ends listening. The phrase still being recognised is kept as it stands rather than lost, and nothing the engine says afterwards is heard. */
  stop(options: { keepPhrase?: boolean } = {}): void {
    const wasAsked = this.wanted;
    this.wanted = false;
    if (options.keepPhrase !== false) this.settle();
    else this.interim = '';
    this.release();
    if (wasAsked) this.on.onListening(false);
  }

  /**
   * Ends listening **and waits for the engine's last reading**, which `stop`
   * does not: a phrase still provisional is delivered final by the engine when
   * it is asked to stop, and that reading is the better one. Resolves once the
   * engine has ended, or after `boundMs` where it never does - whatever was
   * heard by then is kept as `stop` keeps it. Never restarts.
   */
  finish(boundMs: number): Promise<void> {
    const engine = this.engine;
    if (!this.wanted || !engine || !this.started) {
      this.stop();
      return Promise.resolve();
    }
    this.wanted = false;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.finishing = null;
        this.stop();
        this.on.onListening(false);
        resolve();
      };
      const timer = setTimeout(done, boundMs);
      this.finishing = done;
      try {
        engine.stop();
      } catch {
        done();
      }
    });
  }

  /**
   * Drops the phrase still being recognised, because the view has made it part
   * of the note itself (typed over it). The engine would otherwise deliver its
   * final reading of it later and add it twice, so a listening session is
   * swapped for a fresh one that has not heard it. The same goes for the last
   * final of a session that reports each reading again: a longer one would
   * otherwise come after the typing and say what is already in the note.
   */
  forgetPhrase(): void {
    if (!this.interim && !this.lastFinal) return;
    this.interim = '';
    this.lastFinal = '';
    if (this.wanted && this.engine) {
      this.release();
      this.begin();
    }
  }

  private begin(): void {
    const engine = this.make();
    if (!engine) {
      this.fail(DICTATION_FAILED);
      return;
    }
    this.engine = engine;
    this.started = false;
    // A new session counts from the start: its readings never replace the last one's.
    this.lastFinal = '';
    engine.lang = DICTATION_LANGUAGES[this.language()].locale;
    engine.continuous = true;
    engine.interimResults = true;
    engine.onstart = () => {
      if (this.engine !== engine) return;
      this.started = true;
      this.on.onError(null);
      this.on.onListening(true);
    };
    engine.onresult = (event) => {
      if (this.engine !== engine) return;
      this.heard(event);
    };
    engine.onerror = (event) => {
      if (this.engine !== engine) return;
      const why = whyItStopped(event.error);
      if (why) this.fail(why);
    };
    engine.onend = () => {
      if (this.engine !== engine) return;
      this.settle();
      if (this.finishing) {
        this.finishing();
        return;
      }
      if (this.wanted && this.started) {
        this.release();
        this.begin();
        return;
      }
      if (this.wanted) this.fail(DICTATION_FAILED);
    };
    try {
      engine.start();
    } catch {
      this.fail(DICTATION_FAILED);
    }
  }

  private heard(event: RecognitionResultEvent): void {
    let provisional = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i]!;
      const text = result[0].transcript;
      if (result.isFinal) this.final(text);
      else provisional += text;
    }
    this.interim = provisional;
    this.on.onPhrase(provisional, false);
  }

  /** A final phrase, in the place of the session's last one where it is a later reading of the same words. */
  private final(text: string): void {
    const earlier = this.lastFinal;
    this.lastFinal = text;
    if (earlier !== '' && isLaterReadingOf(earlier, text)) this.on.onPhrase(text, true, earlier);
    else this.on.onPhrase(text, true);
  }

  /** Turns what was still provisional into a phrase of its own. */
  private settle(): void {
    const left = this.interim.trim();
    this.interim = '';
    if (left) this.final(left);
    this.on.onPhrase('', false);
  }

  private fail(message: string): void {
    this.wanted = false;
    this.settle();
    this.release();
    this.on.onListening(false);
    this.on.onError(message);
  }

  private release(): void {
    // Whoever waits on the engine's last words is not left waiting on a released one.
    this.finishing?.();
    const engine = this.engine;
    this.engine = null;
    if (!engine) return;
    engine.onstart = engine.onend = engine.onerror = engine.onresult = null;
    try {
      engine.abort();
    } catch {
      // An engine that is already over has nothing to abort.
    }
  }
}

export interface Dictation {
  /** Whether this browser has an engine at all: where it has not, nothing is drawn. */
  available: boolean;
  listening: boolean;
  language: DictationLanguage;
  /** Switches English and Dutch, for the next session; not while listening. */
  toggleLanguage(): void;
  /** The line saying why dictation is not running, or null. */
  error: string | null;
  /** Starts listening, or stops where already asked to. */
  toggle(): void;
  /** Stops listening, keeping what was said. */
  stop(): void;
  /** Stops listening and waits for the engine's last reading of what it was still working out, for at most `withinMs`. */
  finish(withinMs: number): Promise<void>;
  /** Forgets what is still being recognised and the last final heard, which the view has taken into the note itself. */
  forgetPhrase(): void;
}

/**
 * The session for a component: what the browser has, what was last chosen on
 * this device, and the three states a view draws. `onPhrase` is how what is
 * said reaches the view; it is read on each event, so it may change every render.
 *
 * `engine` and `store` are what a test hands in; a view passes neither.
 * Unmounting stops the engine and drops what was still provisional.
 */
export function useDictation({
  onPhrase,
  onFailure,
  engine = browserEngine,
  store = browserStore(),
}: {
  onPhrase: (text: string, final: boolean, replaces?: string) => void;
  /** Told each time dictation stops on an error, after what was still provisional has been delivered as final - including an error worded as the last one was, which `error` alone cannot show. */
  onFailure?: (message: string) => void;
  engine?: EngineFactory | null;
  store?: Storage | undefined;
}): Dictation {
  const factory = engine;
  const [available] = useState(() => factory !== null && factory() !== null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState(() => readDictationLanguage(store));

  const phrase = useRef(onPhrase);
  phrase.current = onPhrase;
  const failure = useRef(onFailure);
  failure.current = onFailure;
  const languageNow = useRef(language);
  languageNow.current = language;

  const session = useRef<DictationSession | null>(null);
  if (!session.current && factory) {
    session.current = new DictationSession(factory, () => languageNow.current, {
      onListening: setListening,
      onPhrase: (text, final, replaces) => phrase.current(text, final, replaces),
      onError: (message) => {
        setError(message);
        if (message) failure.current?.(message);
      },
    });
  }
  useEffect(() => {
    const own = session.current;
    return () => own?.stop({ keepPhrase: false });
  }, []);

  return {
    available,
    listening,
    language,
    error,
    toggleLanguage: () => {
      if (session.current?.asked) return;
      const next: DictationLanguage = languageNow.current === 'en' ? 'nl' : 'en';
      writeDictationLanguage(store, next);
      setLanguage(next);
    },
    toggle: () => {
      const own = session.current;
      if (!own) return;
      if (own.asked) own.stop();
      else own.start();
    },
    stop: () => session.current?.stop(),
    finish: (withinMs) => session.current?.finish(withinMs) ?? Promise.resolve(),
    forgetPhrase: () => session.current?.forgetPhrase(),
  };
}
