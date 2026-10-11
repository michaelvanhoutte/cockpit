import { describe, expect, it } from 'vitest';
import litellm from '../fixtures/litellm-prices.json';
import { costMicros, readLiteLlm, withOverrides, type ModelPrice } from '../../src/prices';

const none = { input: 0, output: 0, cacheCreation: 0, cacheCreation1h: 0, cacheRead: 0 };
const rates: ModelPrice = { input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5, fastMultiplier: 10 };

describe('Harness Monitor', () => {
  describe('a request costs its tokens at its model rates', () => {
    it.each([
      { situation: 'input tokens', tokens: { ...none, input: 1000 }, micros: 1000 },
      { situation: 'output tokens', tokens: { ...none, output: 1000 }, micros: 2000 },
      { situation: 'cache reads', tokens: { ...none, cacheRead: 1000 }, micros: 3000 },
      { situation: '5-minute cache writes', tokens: { ...none, cacheCreation: 1000 }, micros: 4000 },
      { situation: '1-hour cache writes', tokens: { ...none, cacheCreation: 1000, cacheCreation1h: 1000 }, micros: 5000 },
      {
        situation: 'a cache write split between both lifetimes',
        tokens: { ...none, cacheCreation: 1000, cacheCreation1h: 400 },
        micros: 600 * 4 + 400 * 5,
      },
    ])('$situation are charged at their own rate', ({ tokens, micros }) => {
      expect(costMicros(rates, 'standard', tokens)).toBe(micros);
    });

    it('a fast-mode request on a model with a fast rate is charged the fast rate', () => {
      expect(costMicros(rates, 'fast', { ...none, input: 1000, output: 1000 })).toBe(3000 * 10);
    });

    it('a fast-mode request on a model without a fast rate is charged the normal rate', () => {
      const { fastMultiplier: _fast, ...normalOnly } = rates;
      expect(costMicros(normalOnly, 'fast', { ...none, input: 1000 })).toBe(1000);
    });

    it.each([
      { situation: 'a model that is not on the list', price: undefined },
      { situation: 'a model with no rate for a kind of token the request used', price: { input: 1, output: 2 } },
    ])('$situation is unpriced, never free', ({ price }) => {
      expect(costMicros(price, 'standard', { ...none, input: 5, cacheRead: 5 })).toBeNull();
    });

    it('a kind of token the request did not use needs no rate', () => {
      expect(costMicros({ input: 1, output: 2 }, 'standard', { ...none, input: 5 })).toBe(5);
    });
  });

  describe('the price list is read from the file LiteLLM publishes', () => {
    // The fixture is a slice of the real file, recorded as it was served.
    const list = readLiteLlm(litellm)!;

    it('a Claude model gets a rate for each kind of token, in dollars per million', () => {
      expect(list['claude-sonnet-5']).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 });
    });

    it('a model LiteLLM marks as having a fast rate carries its multiplier; one without carries none', () => {
      expect(list['claude-opus-4-8']).toEqual({
        input: 5,
        output: 25,
        cacheRead: 0.5,
        cacheWrite5m: 6.25,
        cacheWrite1h: 10,
        fastMultiplier: 2,
      });
      expect(list['claude-haiku-4-5']).not.toHaveProperty('fastMultiplier');
    });

    it('only the Anthropic entries are read, not other providers or the sample entry', () => {
      expect(Object.keys(list).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-5']);
    });

    it.each([
      { situation: 'text that is not a price list', file: 'oops' },
      { situation: 'a list', file: [] },
      { situation: 'nothing', file: null },
      { situation: 'a file with no model that has both rates', file: { 'claude-x': { litellm_provider: 'anthropic' } } },
      { situation: 'an empty file', file: {} },
    ])('$situation is not a price list', ({ file }) => {
      expect(readLiteLlm(file)).toBeNull();
    });
  });

  describe('the repository price file wins', () => {
    const fetched = { shared: { input: 1, output: 1 }, onlyFetched: { input: 2, output: 2 } };
    const repository = { shared: { input: 9, output: 9 }, onlyRepository: { input: 3, output: 3 } };

    it('a model in both takes the repository rates', () => {
      expect(withOverrides(fetched, repository).shared).toEqual({ input: 9, output: 9 });
    });

    it('a model only in the fetched list takes the fetched rates', () => {
      expect(withOverrides(fetched, repository).onlyFetched).toEqual({ input: 2, output: 2 });
    });
  });
});
