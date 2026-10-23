import { describe, expect, it } from 'vitest';
import { satisfiesSample } from '../samples.js';

/**
 * L1: the check every sample answer is held to by the Worker's own tests
 * (tests/integration/http/panel-reads.test.ts). It has to fail on exactly what
 * would break an installed widget, or the sample guards nothing.
 */
const SAMPLE = {
  count: 2,
  panel: { name: 'Falcon' },
  groups: [{ heading: null, rows: [{ label: 'Renew', priority: null, places: ['Day ▸ Admin'] }] }],
};

describe('Panels', () => {
  describe('an answer is checked against the sample for everything an installed widget reads, and only that', () => {
    it.each([
      { situation: 'the same shape', actual: SAMPLE, wrong: [] },
      {
        situation: 'fields added at any level',
        actual: {
          ...SAMPLE,
          more: true,
          panel: { name: 'Falcon', kind: 'items' },
          groups: [{ heading: { name: 'Admin' }, rows: [{ label: 'Renew', priority: 'high', places: ['Elsewhere ▸ Else'], extra: 1 }], note: 'x' }],
        },
        wrong: [],
      },
      { situation: 'a field gone', actual: { ...SAMPLE, count: undefined }, wrong: ['the answer.count is missing'] },
      { situation: 'a field of another kind', actual: { ...SAMPLE, count: '2' }, wrong: ['the answer.count is a string, not a number'] },
      {
        situation: 'a nested field gone',
        actual: { ...SAMPLE, groups: [{ heading: null, rows: [{ priority: null, places: ['Day ▸ Admin'] }] }] },
        wrong: ['the answer.groups[0].rows[0].label is missing'],
      },
      {
        situation: 'a list that became one thing',
        actual: { ...SAMPLE, groups: { heading: null } },
        wrong: ['the answer.groups is an object, not an array'],
      },
      {
        situation: 'fewer entries than the sample describes',
        actual: { ...SAMPLE, groups: [] },
        wrong: ['the answer.groups has 0 entries, and the sample has 1'],
      },
    ])('says $situation', ({ actual, wrong }) => {
      expect(satisfiesSample(SAMPLE, JSON.parse(JSON.stringify(actual)))).toEqual(wrong);
    });
  });
});
