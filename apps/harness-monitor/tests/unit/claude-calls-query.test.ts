import { describe, expect, it } from 'vitest';
import { callsQueryString, parseCallsQuery } from '../../src/claude-calls-page';

const read = (query: string) => parseCallsQuery(new URLSearchParams(query));

describe('Harness Monitor', () => {
  describe("Cockpit's Claude calls is asked for by its address, which never asks for a choice that repeats the rows", () => {
    it.each([
      { situation: 'each feature, coloured by feature', query: 'group=feature&split=feature', split: 'environment' },
      { situation: 'each environment, coloured by environment', query: 'group=environment&split=environment', split: 'feature' },
      { situation: 'each starter, coloured by starter', query: 'group=startedBy&split=startedBy', split: 'environment' },
      { situation: 'each environment, with no colouring named', query: 'group=environment', split: 'feature' },
      { situation: 'each pull request, coloured by feature', query: 'group=pr&split=feature', split: 'feature' },
      { situation: 'each feature, coloured by model', query: 'group=feature&split=model', split: 'model' },
      { situation: 'each day, coloured by starter', query: 'group=day&split=startedBy', split: 'startedBy' },
    ])('$situation is coloured by $split', ({ query, split }) => {
      expect(read(query).split).toBe(split);
    });

    it.each([
      { situation: 'each feature with a Feature filter', query: 'group=feature&feature=choose-a-panel', held: { feature: null, environment: null } },
      { situation: 'each environment with an Environment filter', query: 'group=environment&environment=ci', held: { feature: null, environment: null } },
      { situation: 'each feature with an Environment filter, which it does not repeat', query: 'group=feature&environment=ci', held: { feature: null, environment: 'ci' } },
      { situation: 'each day with a Feature filter', query: 'group=day&feature=choose-a-panel', held: { feature: 'choose-a-panel', environment: null } },
      { situation: 'each pull request with both filters', query: 'group=pr&feature=choose-a-panel&environment=ci', held: { feature: 'choose-a-panel', environment: 'ci' } },
    ])('$situation holds $held', ({ query, held }) => {
      expect(read(query)).toMatchObject(held);
    });

    it('the address a dropped filter leaves is the one without it, so both share a cache entry', () => {
      expect(callsQueryString(read('group=feature&feature=choose-a-panel&split=feature'))).toBe(callsQueryString(read('group=feature')));
    });
  });
});
