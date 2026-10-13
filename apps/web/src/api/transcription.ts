import { TRANSCRIPTION_PATH, transcriptionSchema } from '@cockpit/shared';
import { CommandRefused, refusal } from './client';

/** A request that has not answered by now is given up on, so "Transcribing…" and a waiting Capture always end. */
const TRANSCRIBE_TIMEOUT_MS = 90_000;

/**
 * The Worker held this account to its 20 transcriptions a minute ("Hold each
 * account to 20 transcriptions a minute", issue 1043). A refusal with its
 * status, so the capture outbox waits it out as it does any 429.
 */
export class TooManyTranscriptions extends CommandRefused {
  constructor() {
    super(429, 'transcribing failed: 429');
    this.name = 'TooManyTranscriptions';
  }
}

/**
 * Turning a recording into words, on the Worker ("Dictate in Write with
 * Whisper", issue 1041). Its own function rather than a typed-client call: the
 * request body is the recording's own bytes, as an attachment's is
 * (`uploadAttachment`), and the route sits outside the JSON contract.
 *
 * **Any failure is one failure to the caller**, and the view says so in one line:
 * a connection that never got through, a refusal, a model that was down. Only
 * the account's limit is told apart (`TooManyTranscriptions`), because trying
 * again at once cannot work. A refusal carries its status (`CommandRefused`),
 * which the capture outbox reads to tell a recording that can never be
 * transcribed from one to try again later (issue 1045).
 */
export async function transcribeRecording(recording: Blob, signal: AbortSignal = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)): Promise<string> {
  const res = await fetch(TRANSCRIPTION_PATH, {
    method: 'POST',
    // The recorder's own type, such as `audio/webm;codecs=opus` or `audio/mp4`.
    headers: { 'Content-Type': recording.type || 'audio/webm' },
    body: recording,
    signal,
  });
  if (res.status === 429) throw new TooManyTranscriptions();
  if (res.status === 401) throw refusal('transcribing', res.status);
  if (!res.ok) throw new CommandRefused(res.status, `The recording could not be transcribed (${res.status}).`);
  return transcriptionSchema.parse(await res.json()).text;
}

/** How the Capture form and the Car view ask `transcriptionOffered`: one key, so `/health` is read once for both. */
export const transcriptionOfferedQuery = {
  queryKey: ['transcription-offered'],
  queryFn: () => transcriptionOffered(),
  retry: false,
  staleTime: 5 * 60_000,
} as const;

/**
 * Whether this Cockpit can transcribe at all, which `/health` says of every
 * environment: a local run and the browser suite answer with a stand-in, a
 * deployment with Whisper, and one with neither has no mic to draw. Throws where
 * `/health` cannot be reached, so the answer is asked again when the connection
 * comes back instead of being remembered as no.
 */
export async function transcriptionOffered(): Promise<boolean> {
  const res = await fetch('/health', { cache: 'no-store' });
  if (!res.ok) throw refusal('health', res.status);
  const answer: unknown = await res.json();
  return typeof answer === 'object' && answer !== null && (answer as { transcription?: unknown }).transcription === true;
}
