import { describe, expect, it } from 'vitest';
import {
  MESSAGE_MOST_BYTES,
  NAMED_MOST_ITEMS,
  keptDid,
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

const quiet: LineAsHeld = {
  reason: 'scheduled',
  outcome: 'worked',
  message: null,
  messageCut: false,
  status: null,
  did: false,
};
const broughtSomethingIn: LineAsHeld = { ...quiet, did: true };
const unavailable: LineAsHeld = {
  reason: 'scheduled',
  outcome: 'failed',
  message: 'unavailable',
  messageCut: false,
  status: 503,
  did: false,
};
const worked: CheckOutcome = { reason: 'scheduled', outcome: 'worked', did: false };
const workedAndDidSomething: CheckOutcome = { reason: 'scheduled', outcome: 'worked', did: true };
const failedAlike: CheckOutcome = {
  reason: 'scheduled',
  outcome: 'failed',
  message: 'unavailable',
  messageCut: false,
  status: 503,
  did: false,
};
const failedOtherwise: CheckOutcome = {
  reason: 'scheduled',
  outcome: 'failed',
  message: 'the sign-in was refused',
  messageCut: false,
  status: 503,
  did: false,
};

describe('Connector management', () => {
  describe('consecutive alike checks fold into one line of the history; anything else starts a new one', () => {
    it.each([
      { situation: 'the first check, which worked', previous: null, ended: worked, writes: 'insert' },
      { situation: 'a check that worked after a quiet line', previous: quiet, ended: worked, writes: 'extend' },
      { situation: 'a check that worked after a failure', previous: unavailable, ended: worked, writes: 'insert' },
      { situation: 'a failure alike the one before', previous: unavailable, ended: failedAlike, writes: 'extend' },
      { situation: 'a failure with another message', previous: unavailable, ended: failedOtherwise, writes: 'insert' },
      { situation: 'a failure with the same message and another status', previous: unavailable, ended: { ...failedAlike, status: 500 }, writes: 'insert' },
      { situation: 'a failure with the same message and no status after one with a status', previous: unavailable, ended: { ...failedAlike, status: null }, writes: 'insert' },
      { situation: 'a failure with no status alike the one before', previous: { ...unavailable, status: null }, ended: { ...failedAlike, status: null }, writes: 'extend' },
      { situation: 'a failure after a quiet line', previous: quiet, ended: failedAlike, writes: 'insert' },
      {
        situation: 'a failure whose message was cut after one that was not',
        previous: unavailable,
        ended: { ...failedAlike, messageCut: true } as CheckOutcome,
        writes: 'insert',
      },
      { situation: 'a check that did something after a quiet line', previous: quiet, ended: workedAndDidSomething, writes: 'insert' },
      { situation: 'a quiet check after one that did something', previous: broughtSomethingIn, ended: worked, writes: 'insert' },
      { situation: 'a second check that did something', previous: broughtSomethingIn, ended: workedAndDidSomething, writes: 'insert' },
      {
        situation: 'a failure alike the one before, having done something first',
        previous: unavailable,
        ended: { ...failedAlike, did: true },
        writes: 'insert',
      },
      { situation: 'a Check now after a quiet line', previous: quiet, ended: { ...worked, reason: 'check-now' as const }, writes: 'insert' },
      { situation: 'a quiet check after a Check now line', previous: { ...quiet, reason: 'check-now' as const }, ended: worked, writes: 'insert' },
      { situation: 'a delivery after a quiet line', previous: quiet, ended: { ...worked, reason: 'delivery' as const }, writes: 'insert' },
      {
        situation: 'a delivery that failed alike the one before it',
        previous: { ...unavailable, reason: 'delivery' as const },
        ended: { ...failedAlike, reason: 'delivery' as const },
        writes: 'insert',
      },
      { situation: 'a quiet check after a delivery line', previous: { ...quiet, reason: 'delivery' as const }, ended: worked, writes: 'insert' },
      {
        situation: 'a failure alike one that had done something',
        previous: { ...unavailable, did: true },
        ended: failedAlike,
        writes: 'insert',
      },
    ])('$situation: $writes', ({ previous, ended, writes }) => {
      expect(whatACheckWrites(previous, ended)).toBe(writes);
    });
  });

  describe('a line keeps what its check did', () => {
    const nothing = { broughtIn: [], closed: [], sentBack: [], refused: [] };

    it('keeps nothing for a check that did nothing', () => {
      expect(keptDid(nothing)).toBeNull();
    });

    it('counts each Item once and keeps its id', () => {
      expect(keptDid({ ...nothing, broughtIn: ['a', 'b', 'a'], refused: ['c'] })).toEqual({
        broughtIn: { count: 2, ids: ['a', 'b'] },
        closed: { count: 0, ids: [] },
        sentBack: { count: 0, ids: [] },
        refused: { count: 1, ids: ['c'] },
      });
    });

    it('keeps the exact count of a long list but only its first Items', () => {
      const many = Array.from({ length: NAMED_MOST_ITEMS + 10 }, (_, i) => `item-${i}`);
      const kept = keptDid({ ...nothing, closed: many })!;
      expect(kept.closed.count).toBe(many.length);
      expect(kept.closed.ids).toEqual(many.slice(0, NAMED_MOST_ITEMS));
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
