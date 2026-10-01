import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendCommand, uploadAttachment } from '../../../src/api/client';

/**
 * F1, with `fetch` replaced at the network's edge: the outbox gives up on a
 * capture or an upload that takes too long, and what it gives up on has to
 * stop rather than go on beside its own retry (`captureOutboxSender.tsx`).
 * When it gives up is tests/unit/captureOutboxSender.test.tsx's; this is that
 * stopping it reaches the request at all.
 */

/** The network, which stops a request the moment it is told to, as a browser's does. */
function aNetwork() {
  const stopped: string[] = [];
  vi.stubGlobal(
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const url = input instanceof Request ? input.url : String(input);
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const stop = () => {
          stopped.push(new URL(url, 'http://localhost').pathname);
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop);
      }),
  );
  return stopped;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Offline', () => {
  describe('a capture or a file given up on is stopped, not left running', () => {
    it.each([
      {
        situation: 'a capture',
        send: (signal: AbortSignal) =>
          sendCommand(
            'capture_item',
            {
              commandId: '01a0f83f-c040-749a-b6e6-330d17bc4140',
              issuedAt: '2026-10-01T08:00:00.000Z',
              workspaceId: 'ws-work',
              itemId: '01a0f83f-c040-749a-b6e6-330d17bc4141',
              message: 'Ring the plumber',
              typeId: 'type-task',
            },
            signal,
          ),
        path: '/v1/commands/capture_item',
      },
      {
        situation: 'a file',
        send: (signal: AbortSignal) =>
          uploadAttachment({
            itemId: 'item-1',
            workspaceId: 'ws-work',
            attachmentId: 'file-1',
            commandId: 'command-1',
            file: new File(['bytes'], 'receipt.png', { type: 'image/png' }),
            signal,
          }),
        path: '/v1/items/item-1/attachments',
      },
    ])('stops $situation once it is given up on', async ({ send, path }) => {
      const stopped = aNetwork();
      const givingUp = new AbortController();

      const sending = send(givingUp.signal);
      givingUp.abort();

      await expect(sending).rejects.toThrow();
      expect(stopped).toEqual([path]);
    });
  });
});
