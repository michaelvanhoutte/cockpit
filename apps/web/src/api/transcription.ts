import { TRANSCRIPTION_PATH, transcriptionSchema } from '@cockpit/shared';
import { refusal } from './client';

/**
 * Turning a recording into words, on the Worker ("Dictate in Write with
 * Whisper", issue 1041). Its own function rather than a typed-client call: the
 * request body is the recording's own bytes, as an attachment's is
 * (`uploadAttachment`), and the route sits outside the JSON contract.
 *
 * **Any failure is one failure to the caller**, and the view says so in one line:
 * a connection that never got through, a refusal, a model that was down. The
 * status is kept on the error for whoever needs to tell them apart later.
 */
export async function transcribeRecording(recording: Blob, signal?: AbortSignal): Promise<string> {
  const res = await fetch(TRANSCRIPTION_PATH, {
    method: 'POST',
    // The recorder's own type, such as `audio/webm;codecs=opus` or `audio/mp4`.
    headers: { 'Content-Type': recording.type || 'audio/webm' },
    body: recording,
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw refusal('transcribing', res.status);
  return transcriptionSchema.parse(await res.json()).text;
}

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
