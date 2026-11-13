import { describe, expect, it } from 'vitest';
import type { ConnectionHistoryLine, NameOutcomeShown } from '@cockpit/shared';
import { lineShown } from '../../src/connectionHistory';
import { timeOfDayLabel, timeToTheSecondLabel } from '../../src/dateFormat';

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
  did: { broughtIn: none, closed: none, sentBack: none, refused: none, named: { count: 0, messages: [] } },
  listed: 2,
  startedAt: null,
};

const outcome: Omit<NameOutcomeShown, 'name'> = { panel: null, dashboard: null, why: null, dashboards: null, panels: null };
const readOne = (message: Partial<{ id: string; title: string | null; dismissed: boolean }>, names: NameOutcomeShown[]) => ({
  ...line,
  did: { ...line.did, named: { count: 1, messages: [{ id: 'm1', title: 'Quote request', dismissed: false, ...message, names }] } },
});

describe('Connector management', () => {
  describe('a check’s history line says how many messages it listed, in the mark’s own words', () => {
    it.each([
      { situation: 'a quiet check under a flag', line, mark: 'flagged', says: '2 flagged, nothing new' },
      {
        situation: 'a quiet check under a category',
        line: { ...line, listed: 1 },
        mark: 'with category Cockpit',
        says: '1 with category Cockpit, nothing new',
      },
      { situation: 'a listing of none', line: { ...line, listed: 0 }, mark: 'flagged', says: '0 flagged, nothing new' },
      {
        situation: 'a check that brought one in',
        line: { ...line, did: { ...line.did, broughtIn: { count: 1, items: [] } }, listed: 3 },
        mark: 'flagged',
        says: 'Brought in 1 · 3 flagged',
      },
      {
        situation: 'quiet checks folded together',
        line: { ...line, count: 3, listed: 3 },
        mark: 'flagged',
        says: '3 flagged',
      },
      { situation: 'a line written before the count', line: { ...line, reason: 'scheduled', listed: null }, mark: 'flagged', says: null },
      { situation: 'a connection whose mark has no wording', line, mark: undefined, says: null },
    ])('$situation', ({ line: held, mark, says }) => {
      expect(lineShown(held, mark).detail).toBe(says);
    });
  });

  describe('a check’s history line says it finished, when it started and ended, and how long it took (issue 1725)', () => {
    const ended = '2026-10-17T09:00:05.000Z';
    const ranFor = (seconds: number) => new Date(Date.parse(ended) - seconds * 1000).toISOString();
    const range = (seconds: number) => `${timeToTheSecondLabel(ranFor(seconds))} → ${timeToTheSecondLabel(ended)}`;
    const checked = { ...line, firstAt: ended, lastAt: ended, listed: null };

    it.each([
      { situation: 'one that worked', held: { ...checked, startedAt: ranFor(3) }, when: range(3), says: 'Manual check · finished in 3 s · worked', detail: null },
      {
        situation: 'one that failed, the status and message after how long it took',
        held: { ...checked, startedAt: ranFor(8), outcome: 'failed' as const, reason: 'scheduled', status: 503, message: 'unavailable' },
        when: range(8),
        says: 'Scheduled check · failed after 8 s',
        detail: 'HTTP 503 · unavailable',
      },
      { situation: 'one over a minute', held: { ...checked, startedAt: ranFor(80), reason: 'follow-up' }, when: range(80), says: 'Follow-up check · finished in 1 min 20 s · worked', detail: null },
      { situation: 'one of whole minutes', held: { ...checked, startedAt: ranFor(120) }, when: range(120), says: 'Manual check · finished in 2 min · worked', detail: null },
      { situation: 'one written before it, with no start', held: checked, when: timeToTheSecondLabel(ended), says: 'Manual check · finished · worked', detail: null },
      {
        situation: 'a failed one written before it',
        held: { ...checked, outcome: 'failed' as const, reason: 'scheduled', message: 'unavailable' },
        when: timeToTheSecondLabel(ended),
        says: 'Scheduled check · failed',
        detail: 'unavailable',
      },
      {
        situation: 'one that did something, the rest of what it says after',
        held: { ...checked, startedAt: ranFor(3), did: { ...line.did, broughtIn: { count: 2, items: [] } } },
        when: range(3),
        says: 'Manual check · finished in 3 s · worked',
        detail: 'Brought in 2',
      },
    ])('$situation', ({ held, when, says, detail }) => {
      expect(lineShown(held)).toMatchObject({ when, says, detail });
    });

    it('keeps the time range of folded checks and the time of a delivery, which ran no check', () => {
      const folded = lineShown({ ...checked, count: 11, firstAt: '2026-10-17T08:00:05.000Z', startedAt: ranFor(3) });
      expect(folded).toMatchObject({
        when: `${timeOfDayLabel('2026-10-17T08:00:05.000Z')}–${timeOfDayLabel(ended)}`,
        says: 'Checked 11 times, nothing new',
        detail: null,
      });
      expect(lineShown({ ...checked, reason: 'delivery' })).toMatchObject({ when: timeOfDayLabel(ended), says: 'Worked', detail: 'Delivered' });
    });

    it.each([
      { reason: 'check-now', says: 'Manual check' },
      { reason: 'scheduled', says: 'Scheduled check' },
      { reason: 'follow-up', says: 'Follow-up check' },
      { reason: 'a reason from a later release', says: 'finished' },
    ])('names a $reason check in words', ({ reason, says }) => {
      expect(lineShown({ ...checked, reason }).says.startsWith(says)).toBe(true);
    });
  });
  describe('a check’s history line says what each name it read did (issue 1197)', () => {
    it.each([
      {
        situation: 'filed on a Panel',
        names: [{ ...outcome, name: 'Tasks', panel: 'Tasks', dashboard: 'Privé' }],
        says: ['Tasks → filed on Tasks (Privé)'],
      },
      {
        situation: 'Panels on three Dashboards',
        names: [{ ...outcome, name: 'Tasks', why: 'several', dashboards: 3 }],
        says: ['Tasks: skipped, Panels on 3 Dashboards'],
      },
      {
        situation: 'two Panels on one Dashboard',
        names: [{ ...outcome, name: 'Tasks', why: 'several', dashboards: 1 }],
        says: ['Tasks: skipped, more than one Panel by that name'],
      },
      {
        situation: 'a Dashboard-qualified name reading as two Panels',
        names: [{ ...outcome, name: 'A-B-C', why: 'pairs', panels: 2 }],
        says: ['A-B-C: skipped, matches 2 Panels'],
      },
      { situation: 'no Panel', names: [{ ...outcome, name: 'Red category', why: 'no-panel' }], says: ['Red category: skipped, no Panel by that name'] },
      { situation: 'the followed category', names: [{ ...outcome, name: 'Cockpit', why: 'followed' }], says: ['Cockpit: skipped, the category followed'] },
      { situation: 'filing off', names: [{ ...outcome, name: 'Tasks', why: 'off' }], says: ['Tasks: skipped, filing by category is off'] },
      {
        situation: 'already there when filing was ticked',
        names: [{ ...outcome, name: 'Tasks', why: 'baseline' }],
        says: ['Tasks: skipped, already on it when filing was ticked'],
      },
      { situation: 'a reason a later release adds', names: [{ ...outcome, name: 'Tasks', why: 'moved' }], says: ['Tasks: skipped'] },
    ])('$situation', ({ names, says }) => {
      expect(lineShown(readOne({}, names), 'flagged', 'category').named[0]!.outcomes).toEqual(says);
    });

    it('is a line of its own that does not claim nothing was new', () => {
      const shown = lineShown(readOne({}, [{ ...outcome, name: 'Tasks', why: 'off' }]), 'flagged', 'category');
      expect(shown.detail).toBe('Read names of 1 · 2 flagged');
    });
  });

  describe('a message no longer in Cockpit, or dismissed, reads as the other kinds do', () => {
    it.each([
      { situation: 'dismissed since', message: { dismissed: true }, shown: { id: null, text: 'Quote request (dismissed)' } },
      { situation: 'gone', message: { title: null }, shown: { id: null, text: 'an Item no longer in Cockpit' } },
      { situation: 'still there', message: {}, shown: { id: 'm1', text: 'Quote request' } },
    ])('$situation', ({ message, shown }) => {
      const [named] = lineShown(readOne(message, [{ ...outcome, name: 'Tasks', why: 'off' }])).named;
      expect(named).toMatchObject(shown);
    });

    it('says how many more messages the count holds than the line names', () => {
      const many = { ...line, did: { ...line.did, named: { count: 51, messages: readOne({}, []).did.named.messages } } };
      expect(lineShown(many).namedMore).toBe(50);
    });
  });
});
