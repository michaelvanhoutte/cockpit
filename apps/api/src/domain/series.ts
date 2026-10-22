import type { Series, SetRepeatCommand } from '@cockpit/shared';
import { captureDay } from './capture-day.js';

/** A repeat that is refused, in the words the person is told beside the field ("Set an Item to repeat from its form", issue 1406). */
export const UNKNOWN_TIME_ZONE = 'Cockpit does not know the time zone this device is in, so it cannot say when a day starts.';
export const NEXT_ON_PASSED = 'Next on cannot be before today.';

/** A series as its row holds it. */
export type SeriesRow = Series & { createdAt: string; updatedAt: string };

/** What a Repeats change comes to for an Item and its series, if it has one. */
export type RepeatDecision =
  | { kind: 'refused'; why: string }
  /** Made against an older version of the rule: logged, nothing changed. */
  | { kind: 'stale' }
  /** *Never* on an Item that repeats nothing: there is no series to stop. */
  | { kind: 'nothing' }
  | { kind: 'write'; row: SeriesRow; isNew: boolean };

/**
 * Decides one Repeats change ("Set an Item to repeat from its form, and see the
 * rule on its row", issue 1406).
 *
 * **Today is the day the change was issued on, on the zone it carries** - not the
 * moment it arrived - so the refusal of a *Next on* in the past does not depend
 * on how long the change took to get here. **A set rule starts the series
 * again** if *Never* had stopped it. Setting a repeat never reads or writes the
 * Item's own due date.
 */
export function decideRepeat(
  own: SeriesRow | null,
  cmd: SetRepeatCommand,
  tenantId: string,
): RepeatDecision {
  if (own && cmd.issuedAt < own.updatedAt) return { kind: 'stale' };
  if (cmd.repeat === null) {
    if (!own) return { kind: 'nothing' };
    return { kind: 'write', row: { ...own, stoppedAt: own.stoppedAt ?? cmd.issuedAt, updatedAt: cmd.issuedAt }, isNew: false };
  }
  const { timeZone, ...rule } = cmd.repeat;
  const today = captureDay(cmd.issuedAt, timeZone);
  if (today === null) return { kind: 'refused', why: UNKNOWN_TIME_ZONE };
  // Only a *Next on* the person moves is held to today: the form sends the stored one back with every other choice, and nothing advances it yet.
  const keepsItsDay = own !== null && own.stoppedAt === null && own.nextOn === rule.nextOn;
  if (rule.nextOn < today.date && !keepsItsDay) return { kind: 'refused', why: NEXT_ON_PASSED };
  return {
    kind: 'write',
    isNew: own === null,
    row: {
      id: own?.id ?? cmd.seriesId,
      tenantId,
      ...rule,
      timeZone,
      stoppedAt: null,
      createdAt: own?.createdAt ?? cmd.issuedAt,
      updatedAt: cmd.issuedAt,
    },
  };
}
