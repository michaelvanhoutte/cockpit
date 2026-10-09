import { describe, expect, it } from 'vitest';
import {
  PULLED_CHECK_EVERY_MS,
  PULLED_CHECK_LEASE_MS,
  PULLED_CHECK_SOON_MS,
  leaseFrom,
  nextCheckAfter,
  whatADeliveryDoes,
} from '../../../src/domain/pulled-checks.js';

/**
 * Unit level: the arithmetic a delivered check of a pulled connection is
 * decided by - whether a run's lease still holds, and when the next check
 * falls due ("Check a pulled connector on its cadence through the generic
 * host", issue 891). That the store holds it to this, across the queue, is
 * tests/integration/connectors/pulled-checks.test.ts's.
 */

const NOW = new Date('2026-10-08T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

describe('Connector management', () => {
  describe('a connection to a source Cockpit pulls from is checked one run at a time', () => {
    it.each([
      { situation: 'a check waiting and no run under way', queuedAt: at(-1_000), leaseUntil: null, does: 'run', outcome: 'runs' },
      { situation: 'a run still within its time', queuedAt: at(-1_000), leaseUntil: at(1), does: 'already running', outcome: 'does nothing' },
      { situation: 'a run whose time runs out this instant', queuedAt: at(-1_000), leaseUntil: at(0), does: 'run', outcome: 'runs' },
      { situation: 'a run whose time has run out', queuedAt: at(-1_000), leaseUntil: at(-1), does: 'run', outcome: 'runs' },
      { situation: 'no check waiting, the last one already run', queuedAt: null, leaseUntil: null, does: 'not queued', outcome: 'does nothing' },
      { situation: 'no check waiting and a run under way', queuedAt: null, leaseUntil: at(60_000), does: 'already running', outcome: 'does nothing' },
    ] as const)('a check delivered with $situation $outcome', ({ queuedAt, leaseUntil, does }) => {
      expect(whatADeliveryDoes({ queuedAt, leaseUntil }, NOW)).toBe(does);
    });

    it('a run is given longer than the time between checks, and the next check is about five minutes after a run ends', () => {
      expect(leaseFrom(NOW)).toBe(at(PULLED_CHECK_LEASE_MS));
      expect(nextCheckAfter(NOW)).toBe(at(5 * 60_000));
      expect(PULLED_CHECK_LEASE_MS).toBeGreaterThan(PULLED_CHECK_EVERY_MS);
    });

    it('a run that says there is more to do is followed by a check soon, well inside the usual cadence', () => {
      expect(nextCheckAfter(NOW, true)).toBe(at(PULLED_CHECK_SOON_MS));
      expect(nextCheckAfter(NOW, false)).toBe(at(PULLED_CHECK_EVERY_MS));
      expect(PULLED_CHECK_SOON_MS).toBeLessThan(PULLED_CHECK_EVERY_MS);
    });
  });
});
