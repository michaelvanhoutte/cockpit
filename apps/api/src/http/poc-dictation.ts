import Anthropic from '@anthropic-ai/sdk';
import type { Context } from 'hono';
import type { GatedEnv } from '../auth/gate.js';

/**
 * THROWAWAY POC - "is a better engine better on my voice?". Not to be merged.
 *
 * Takes one dictation's recording (the body) and what Chrome's engine heard
 * (`x-chrome-text`), and answers both alternatives side by side:
 * Whisper on Workers AI reading the audio, and Claude correcting Chrome's text.
 */
const MAX_AUDIO = 10 * 1024 * 1024;
const WHISPER = '@cf/openai/whisper-large-v3-turbo';
const CLAUDE = 'claude-opus-5-5';

const CORRECT = `The text below came from a phone's speech recognition. The speaker dictated a short note to themselves, in English or Dutch.
Speech recognition mishears words: it writes a word that sounds like the one said ("at a dark mode" for "add a dark mode").
Return the note with only the misheard words replaced by the words the speaker most likely said, and with sentence punctuation and capitals.
Do not rephrase, reorder, summarise, translate, or add anything. Where a word is plausible as it stands, keep it.
Answer with the corrected note and nothing else.`;

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

async function corrected(env: GatedEnv['Bindings'], chrome: string) {
  if (!chrome.trim()) return { text: '', ms: 0 };
  if (!env.ANTHROPIC_API_KEY) return { text: null, ms: 0, error: 'No ANTHROPIC_API_KEY in this environment' };
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    ...(env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } } : {}),
    timeout: 30_000,
    maxRetries: 1,
  });
  const started = Date.now();
  try {
    const answer = await client.messages.create({
      model: CLAUDE,
      max_tokens: 4_096,
      output_config: { effort: 'low' },
      system: CORRECT,
      messages: [{ role: 'user', content: chrome }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    if (answer.stop_reason === 'refusal') return { text: null, ms: Date.now() - started, error: 'Claude declined' };
    const text = answer.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('').trim();
    return { text, ms: Date.now() - started };
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
  const [fromWhisper, fromClaude] = await Promise.all([whisper(c.env, audio), corrected(c.env, chrome)]);
  return c.json({ chrome, whisper: fromWhisper, corrected: fromClaude, bytes: audio.byteLength });
}
