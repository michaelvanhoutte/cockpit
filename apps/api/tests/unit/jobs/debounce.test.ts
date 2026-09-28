import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEBOUNCE_SECONDS,
  debounceSecondsFor,
  isSuperseded,
  laterOf,
  type RefreshAsk,
} from '../../../src/jobs/debounce.js';

/**
 * Unit level: which of several asks for the same refresh is left to run is a
 * pure decision over the asks themselves and what was recorded of them - no
 * queue, no store, no clock ("Debounce the settle-triggered repropose fan-out
 * across a real time window", issue 582).
 */

const ask = (at: number, id: string): RefreshAsk => ({ at, id });

/** What the record holds once every ask in `recordedInOrder` has been offered to it, in that order. */
const recordOf = (recordedInOrder: readonly RefreshAsk[]): RefreshAsk | null =>
  recordedInOrder.reduce<RefreshAsk | null>((recorded, incoming) => laterOf(recorded, incoming), null);

describe('Triage', () => {
  describe('of several refreshes asked for at once, exactly the latest runs', () => {
    it.each([
      {
        situation: 'one ask on its own',
        asks: [ask(1_000, 'a')],
        recordedInOrder: [ask(1_000, 'a')],
        runs: ['a'],
      },
      {
        situation: 'three asks recorded in the order they were made',
        asks: [ask(1_000, 'a'), ask(2_000, 'b'), ask(3_000, 'c')],
        recordedInOrder: [ask(1_000, 'a'), ask(2_000, 'b'), ask(3_000, 'c')],
        runs: ['c'],
      },
      {
        situation: 'a later ask recorded before an earlier one',
        asks: [ask(1_000, 'a'), ask(2_000, 'b')],
        recordedInOrder: [ask(2_000, 'b'), ask(1_000, 'a')],
        runs: ['b'],
      },
      {
        situation: 'two asks made in the same millisecond',
        asks: [ask(1_000, 'a'), ask(1_000, 'b')],
        recordedInOrder: [ask(1_000, 'a'), ask(1_000, 'b')],
        runs: ['b'],
      },
      {
        situation: 'the latest ask queued but never recorded',
        asks: [ask(1_000, 'a'), ask(2_000, 'b')],
        recordedInOrder: [ask(1_000, 'a')],
        runs: ['a', 'b'],
      },
      {
        situation: 'nothing recorded at all',
        asks: [ask(1_000, 'a'), ask(2_000, 'b')],
        recordedInOrder: [],
        runs: ['a', 'b'],
      },
    ])('$situation', ({ asks, recordedInOrder, runs }) => {
      const recorded = recordOf(recordedInOrder);

      expect(asks.filter((mine) => !isSuperseded(recorded, mine)).map((mine) => mine.id)).toEqual(runs);
    });

    it('a refresh queued before the debounce existed always runs', () => {
      expect(isSuperseded(ask(9_000, 'later'), undefined)).toBe(false);
    });
  });

  describe('a refresh waits the configured window, or the default where none is configured', () => {
    it.each([
      { situation: 'nothing configured', configured: undefined, seconds: DEFAULT_DEBOUNCE_SECONDS },
      { situation: 'no wait at all', configured: '0', seconds: 0 },
      { situation: 'a whole number of seconds', configured: '45', seconds: 45 },
      { situation: 'a fraction of a second', configured: '1.5', seconds: DEFAULT_DEBOUNCE_SECONDS },
      { situation: 'a negative number', configured: '-5', seconds: DEFAULT_DEBOUNCE_SECONDS },
      { situation: 'not a number', configured: 'soon', seconds: DEFAULT_DEBOUNCE_SECONDS },
      { situation: 'an empty value', configured: '', seconds: DEFAULT_DEBOUNCE_SECONDS },
    ])('$situation', ({ configured, seconds }) => {
      expect(debounceSecondsFor(configured)).toBe(seconds);
    });
  });
});
