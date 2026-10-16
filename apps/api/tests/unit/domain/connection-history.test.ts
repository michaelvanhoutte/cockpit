import { describe, expect, it } from 'vitest';
import {
  MESSAGE_MOST_BYTES,
  keptMessage,
  whatACheckWrites,
  type CheckOutcome,
  type LineAsHeld,
} from '../../../src/domain/connection-history.js';

/**
 * L1: what a check's end writes to its connection's history, decided from the
 * line before it and how the check ended. That the store really extends the
 * line it holds, in the transaction that ends the check, is
 * tests/integration/connectors/connection-history.test.ts's.
 */

const quiet: LineAsHeld = { outcome: 'worked', message: null, messageCut: false };
const unavailable: LineAsHeld = { outcome: 'failed', message: 'unavailable', messageCut: false };
const worked: CheckOutcome = { outcome: 'worked' };
const failedAlike: CheckOutcome = { outcome: 'failed', message: 'unavailable', messageCut: false };
const failedOtherwise: CheckOutcome = { outcome: 'failed', message: 'the sign-in was refused', messageCut: false };

describe('Connector management', () => {
  describe('consecutive alike checks fold into one line of the history; anything else starts a new one', () => {
    it.each([
      { situation: 'the first check, which worked', previous: null, ended: worked, writes: 'insert' },
      { situation: 'a check that worked after a quiet line', previous: quiet, ended: worked, writes: 'extend' },
      { situation: 'a check that worked after a failure', previous: unavailable, ended: worked, writes: 'insert' },
      { situation: 'a failure alike the one before', previous: unavailable, ended: failedAlike, writes: 'extend' },
      { situation: 'a failure with another message', previous: unavailable, ended: failedOtherwise, writes: 'insert' },
      { situation: 'a failure after a quiet line', previous: quiet, ended: failedAlike, writes: 'insert' },
      {
        situation: 'a failure whose message was cut after one that was not',
        previous: unavailable,
        ended: { outcome: 'failed', message: 'unavailable', messageCut: true } as CheckOutcome,
        writes: 'insert',
      },
    ])('$situation: $writes', ({ previous, ended, writes }) => {
      expect(whatACheckWrites(previous, ended)).toBe(writes);
    });
  });

  describe('a failure’s message is kept to 2 KB', () => {
    it('cuts one of 3 KB at 2 KB, and marks it cut', () => {
      const kept = keptMessage('x'.repeat(3 * 1024));
      expect(kept).toEqual({ message: 'x'.repeat(MESSAGE_MOST_BYTES), messageCut: true });
    });

    it('cuts on a character, never through one', () => {
      // Three bytes each in UTF-8, so 2 KB falls inside the 683rd.
      const kept = keptMessage('€'.repeat(1000));
      expect(kept.message).toBe('€'.repeat(682));
      expect(kept.messageCut).toBe(true);
    });

    it.each([
      { situation: 'a short one', message: 'the source stopped answering', kept: { message: 'the source stopped answering', messageCut: false } },
      { situation: 'one of exactly 2 KB', message: 'y'.repeat(MESSAGE_MOST_BYTES), kept: { message: 'y'.repeat(MESSAGE_MOST_BYTES), messageCut: false } },
      { situation: 'an empty one', message: '', kept: { message: null, messageCut: false } },
    ])('keeps $situation as given', ({ message, kept }) => {
      expect(keptMessage(message)).toEqual(kept);
    });
  });
});
