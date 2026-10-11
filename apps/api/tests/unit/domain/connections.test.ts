import { describe, expect, it } from 'vitest';
import { decideSourceConnection, type HeldConnection } from '../../../src/domain/connections.js';

const AT = '2026-09-28T10:00:00.000Z';
const NEW_ID = '018f0000-0000-7000-8000-000000000001';
const HELD_ID = '018f0000-0000-7000-8000-000000000002';

const connect = { sourceAccountId: NEW_ID, choice: undefined, issuedAt: AT };

function held(over: Partial<HeldConnection> = {}): HeldConnection {
  return { id: HELD_ID, choice: null, failing: false, ...over };
}

describe('Connector management', () => {
  describe('connecting decides between a new connection and a refreshed one', () => {
    it.each([
      { situation: 'an account not yet connected in the Workspace', held: undefined, connection: 'new', id: NEW_ID },
      { situation: 'the same account connected again', held: held(), connection: 'refreshed', id: HELD_ID },
    ] as const)('$situation', ({ held: h, connection, id }) => {
      const decided = decideSourceConnection({ held: h }, connect);
      expect(decided.connection).toBe(connection);
      expect(decided.accountId).toBe(id);
    });
  });

  describe('a connection that was failing has the failure cleared', () => {
    it.each([
      { situation: 'a failing connection', held: held({ failing: true }), clears: true },
      { situation: 'a connection not failing', held: held(), clears: false },
      { situation: 'an account not yet connected', held: undefined, clears: false },
    ])('$situation', ({ held: h, clears }) => {
      expect(decideSourceConnection({ held: h }, connect).clearFailure).toBe(clears);
    });
  });

  describe('a reconnect under another choice drops what was waiting; one asking nothing keeps the choice', () => {
    it.each([
      { situation: 'another choice', held: held({ choice: 'a' }), asked: 'b', drops: true, writes: 'b' },
      { situation: 'the same choice', held: held({ choice: 'a' }), asked: 'a', drops: false, writes: 'a' },
      { situation: 'a choice where none was held', held: held({ choice: null }), asked: 'a', drops: true, writes: 'a' },
      { situation: 'no choice asked', held: held({ choice: 'a' }), asked: undefined, drops: false, writes: undefined },
      { situation: 'a first connection with a choice', held: undefined, asked: 'a', drops: false, writes: 'a' },
    ])('$situation', ({ held: h, asked, drops, writes }) => {
      const decided = decideSourceConnection({ held: h }, { ...connect, choice: asked });
      expect(decided.dropWaiting).toBe(drops);
      expect(decided.choiceOnRefresh).toBe(writes);
    });
  });

  describe('any connect makes the next check due now', () => {
    it.each([
      { situation: 'a new connection', held: undefined },
      { situation: 'a refreshed one', held: held({ failing: true }) },
    ])('$situation', ({ held: h }) => {
      expect(decideSourceConnection({ held: h }, connect).nextCheckDueAt).toBe(AT);
    });
  });
});
