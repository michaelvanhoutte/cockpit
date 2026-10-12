import type { Context } from 'hono';
import type { GatedEnv } from '../auth/gate.js';

/**
 * THROWAWAY POC - "is a better engine better on my voice?". Not to be merged.
 *
 * Takes one dictation's recording (the body) and what Chrome's engine heard
 * (`x-chrome-text`), and answers Whisper on Workers AI's reading of the audio
 * beside it.
 */
const MAX_AUDIO = 10 * 1024 * 1024;
const WHISPER = '@cf/openai/whisper-large-v3-turbo';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function whisper(env: GatedEnv['Bindings'], audio: Uint8Array) {
  if (!env.AI) return { text: null, ms: 0, error: 'No Workers AI binding in this environment' };
  const started = Date.now();
  try {
    const answer = (await env.AI.run(WHISPER as never, { audio: toBase64(audio) } as never)) as {
      text?: string;
      transcription_info?: { language?: string };
    };
    return { text: answer.text?.trim() ?? '', language: answer.transcription_info?.language, ms: Date.now() - started };
  } catch (err) {
    return { text: null, ms: Date.now() - started, error: (err as Error).message };
  }
}

export async function compareDictation(c: Context<GatedEnv>) {
  const audio = new Uint8Array(await c.req.arrayBuffer());
  if (audio.byteLength === 0) return c.json({ error: 'no audio was sent' }, 400);
  if (audio.byteLength > MAX_AUDIO) return c.json({ error: 'the recording is too long' }, 413);
  let chrome = '';
  try {
    chrome = decodeURIComponent(c.req.header('x-chrome-text') ?? '');
  } catch {
    return c.json({ error: 'x-chrome-text was not validly encoded' }, 400);
  }
  return c.json({ chrome, whisper: await whisper(c.env, audio), bytes: audio.byteLength });
}
