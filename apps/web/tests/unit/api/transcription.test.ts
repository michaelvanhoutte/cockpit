import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooManyTranscriptions, transcribeRecording } from '../../../src/api/transcription';

/** L1: how the Worker's answer to a recording is read; the fetch is the network, which jsdom has none of. */

afterEach(() => vi.unstubAllGlobals());

function workerAnswers(status: number, body: unknown = {}) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
}

describe('Capture', () => {
  describe('a recording is sent to be transcribed', () => {
    const recording = new Blob(['audio'], { type: 'audio/webm' });

    it('answers the words the Worker sent back', async () => {
      workerAnswers(200, { text: 'buy oat milk' });

      await expect(transcribeRecording(recording)).resolves.toBe('buy oat milk');
    });

    it('tells the account being held to its limit apart from any other refusal', async () => {
      workerAnswers(429);
      await expect(transcribeRecording(recording)).rejects.toBeInstanceOf(TooManyTranscriptions);

      workerAnswers(503);
      await expect(transcribeRecording(recording)).rejects.not.toBeInstanceOf(TooManyTranscriptions);
    });
  });
});
