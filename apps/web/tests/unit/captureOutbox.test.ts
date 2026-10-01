import { describe, expect, it } from 'vitest';
import { CommandRefused } from '../../src/api/client';
import {
  TimedOut,
  capturePayload,
  nextWait,
  outcomeOf,
  readEntry,
  stateOf,
  toSend,
  whatGoesBack,
  type OutboxEntry,
  type WaitingFile,
} from '../../src/captureOutbox';

/**
 * L1: which waiting capture goes next, what an answer means for it, and how
 * long to wait before trying again are calculations. The sending itself -
 * when it happens and what it leaves stored - is
 * tests/unit/captureOutboxSender.test.tsx, and the form drawing it is
 * tests/unit/components/CaptureNote.test.tsx.
 */

function anEntry(over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    v: 1,
    id: 'item-1',
    owner: 'user-ada',
    commandId: 'command-1',
    capturedAt: '2026-10-01T08:00:00.000Z',
    workspaceId: 'ws-work',
    decided: true,
    message: 'Ring the plumber',
    typeId: 'type-task',
    files: [],
    landed: false,
    refused: null,
    ...over,
  };
}

function aFile(over: Partial<WaitingFile> = {}): WaitingFile {
  return {
    id: 'file-1',
    commandId: 'command-file-1',
    name: 'receipt.png',
    type: 'image/png',
    bytes: new ArrayBuffer(2),
    landed: false,
    refused: null,
    ...over,
  };
}

describe('Offline', () => {
  describe('a waiting capture goes out oldest first, and only for whoever captured it', () => {
    it.each([
      {
        situation: 'three waiting, kept out of order',
        entries: [
          anEntry({ id: 'c', capturedAt: '2026-10-01T08:03:00.000Z' }),
          anEntry({ id: 'a', capturedAt: '2026-10-01T08:01:00.000Z' }),
          anEntry({ id: 'b', capturedAt: '2026-10-01T08:02:00.000Z' }),
        ],
        goes: ['a', 'b', 'c'],
      },
      {
        situation: 'one captured by somebody else on this browser',
        entries: [anEntry({ id: 'mine' }), anEntry({ id: 'theirs', owner: 'user-bob' })],
        goes: ['mine'],
      },
      {
        situation: 'one the server refused',
        entries: [anEntry({ id: 'refused', refused: 'workspace ws-work not found' }), anEntry({ id: 'next' })],
        goes: ['next'],
      },
      {
        situation: 'a note that landed with a file still to go',
        entries: [anEntry({ landed: true, files: [aFile({ landed: true }), aFile({ id: 'file-2' })] })],
        goes: ['item-1'],
      },
      {
        situation: 'a note that landed whose only file was refused',
        entries: [anEntry({ landed: true, files: [aFile({ refused: 'too big' })] })],
        goes: [],
      },
    ])('$situation', ({ entries, goes }) => {
      expect(toSend(entries, 'user-ada').map((entry) => entry.id)).toEqual(goes);
    });

    it('sends nothing while nobody is signed in', () => {
      expect(toSend([anEntry()], null)).toEqual([]);
    });
  });

  describe('a waiting capture this version cannot read is left alone', () => {
    it.each([
      { situation: 'written by a later version', raw: { ...anEntry(), v: 2 } },
      { situation: 'missing whose it is', raw: { ...anEntry(), owner: undefined } },
      { situation: 'not a capture at all', raw: 'a string' },
    ])('$situation', ({ raw }) => {
      expect(readEntry(raw)).toBeNull();
    });

    it('reads one written by this version', () => {
      expect(readEntry(anEntry())).toEqual(anEntry());
    });
  });

  describe('a capture keeps waiting unless the server refuses it, and then says why', () => {
    it.each([
      { situation: 'no connection', error: new TypeError('Failed to fetch'), waits: true },
      { situation: 'the send timed out', error: new TimedOut(), waits: true },
      { situation: 'a server error', error: new CommandRefused(503, 'capture_item failed: 503'), waits: true },
      { situation: 'the sign-in expired', error: new CommandRefused(401, 'not signed in'), waits: true },
      { situation: 'the request took too long', error: new CommandRefused(408, 'timeout'), waits: true },
      { situation: 'too many at once', error: new CommandRefused(429, 'slow down'), waits: true },
      { situation: 'its workspace is gone', error: new CommandRefused(404, 'workspace ws-work not found'), waits: false },
      { situation: 'it is not a valid capture', error: new CommandRefused(400, 'message is empty'), waits: false },
    ])('$situation', ({ error, waits }) => {
      const outcome = outcomeOf(error);
      expect(outcome.waits).toBe(waits);
      if (!outcome.waits) expect(outcome.reason).toBe(error.message);
    });
  });

  describe('with no answer at all, a waiting capture is tried again after 30s, doubling to a minute', () => {
    it('waits 30s, then a minute, and never longer', () => {
      const first = nextWait(null);
      const second = nextWait(first);
      const third = nextWait(second);
      expect([first, second, third]).toEqual([30_000, 60_000, 60_000]);
    });
  });

  describe('a capture sent late still says when it was captured', () => {
    it('carries the time Capture was pressed, and the same ids every time it is sent', () => {
      const entry = anEntry({ decided: false });
      expect(capturePayload(entry)).toEqual({
        commandId: 'command-1',
        issuedAt: '2026-10-01T08:00:00.000Z',
        workspaceId: 'ws-work',
        itemId: 'item-1',
        message: 'Ring the plumber',
        typeId: 'type-task',
        workspaceDecided: false,
      });
      expect(capturePayload(entry)).toEqual(capturePayload(entry));
    });
  });

  describe('a waiting capture says where it stands, and what putting it back returns', () => {
    it.each([
      { situation: 'not landed yet', entry: anEntry(), reads: { waiting: true } },
      {
        situation: 'landed, a file still to go',
        entry: anEntry({ landed: true, files: [aFile()] }),
        reads: { waiting: true },
      },
      {
        situation: 'refused',
        entry: anEntry({ refused: 'workspace ws-work not found' }),
        reads: { waiting: false, notSent: 'workspace ws-work not found' },
      },
      {
        situation: 'landed, a file refused',
        entry: anEntry({ landed: true, files: [aFile({ landed: true }), aFile({ id: 'f2', refused: '"b.pdf" is too big.' })] }),
        reads: { waiting: false, notSent: '"b.pdf" is too big.' },
      },
    ])('$situation', ({ entry, reads }) => {
      expect(stateOf(entry)).toEqual(reads);
    });

    it.each([
      {
        situation: 'a refused note returns with every file',
        entry: anEntry({ refused: 'gone', files: [aFile(), aFile({ id: 'f2' })] }),
        message: 'Ring the plumber',
        files: ['file-1', 'f2'],
      },
      {
        situation: 'a landed note returns only its refused file',
        entry: anEntry({ landed: true, files: [aFile({ landed: true }), aFile({ id: 'f2', refused: 'too big' })] }),
        message: null,
        files: ['f2'],
      },
    ])('$situation', ({ entry, message, files }) => {
      const back = whatGoesBack(entry);
      expect(back.message).toBe(message);
      expect(back.files.map((file) => file.id)).toEqual(files);
    });
  });
});
