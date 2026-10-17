import { describe, expect, it } from 'vitest';
import type { ConnectionHistoryLine } from '@cockpit/shared';
import { lineShown } from '../../src/connectionHistory';

/**
 * F1: how a connection's history line is worded ("Say how many messages each
 * pulled check listed, on its history line", issue 1196) - what the person
 * reads, drawn from a line as the API sends it.
 */

const none = { count: 0, items: [] };
const line: ConnectionHistoryLine = {
  id: 'one',
  outcome: 'worked',
  reason: 'check-now',
  message: null,
  messageCut: false,
  status: null,
  count: 1,
  firstAt: '2026-10-17T09:00:00.000Z',
  lastAt: '2026-10-17T09:00:00.000Z',
  did: { broughtIn: none, closed: none, sentBack: none, refused: none },
  listed: 2,
};

describe('Connector management', () => {
  describe('a check’s history line says how many messages it listed, in the mark’s own words', () => {
    it.each([
      { situation: 'a quiet check under a flag', line, mark: 'flagged', says: 'Check now · 2 flagged, nothing new' },
      {
        situation: 'a quiet check under a category',
        line: { ...line, listed: 1 },
        mark: 'with category Cockpit',
        says: 'Check now · 1 with category Cockpit, nothing new',
      },
      { situation: 'a listing of none', line: { ...line, listed: 0 }, mark: 'flagged', says: 'Check now · 0 flagged, nothing new' },
      {
        situation: 'a check that brought one in',
        line: { ...line, did: { ...line.did, broughtIn: { count: 1, items: [] } }, listed: 3 },
        mark: 'flagged',
        says: 'Check now · Brought in 1 · 3 flagged',
      },
      {
        situation: 'quiet checks folded together',
        line: { ...line, count: 3, listed: 3 },
        mark: 'flagged',
        says: '3 flagged',
      },
      { situation: 'a line written before the count', line: { ...line, reason: 'scheduled', listed: null }, mark: 'flagged', says: 'Scheduled' },
      { situation: 'a connection whose mark has no wording', line, mark: undefined, says: 'Check now' },
    ])('$situation', ({ line: held, mark, says }) => {
      expect(lineShown(held, mark).detail).toBe(says);
    });
  });
});
