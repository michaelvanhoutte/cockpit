import { describe, expect, it } from 'vitest';
import { checkWriteKey } from '../../src/auth';

describe('Harness Monitor', () => {
  describe('only the write key adds rows', () => {
    it.each([
      { situation: 'no key', header: null, configured: 'secret', expected: 'refused' },
      { situation: 'a key that is not a bearer key', header: 'secret', configured: 'secret', expected: 'refused' },
      { situation: 'a wrong key', header: 'Bearer nope', configured: 'secret', expected: 'refused' },
      { situation: 'a key that is a prefix of the right one', header: 'Bearer secre', configured: 'secret', expected: 'refused' },
      { situation: 'the right key', header: 'Bearer secret', configured: 'secret', expected: 'allowed' },
      { situation: 'the right key when none is configured', header: 'Bearer secret', configured: undefined, expected: 'unconfigured' },
      { situation: 'an empty key when none is configured', header: 'Bearer x', configured: '', expected: 'unconfigured' },
    ])('$situation is $expected', async ({ header, configured, expected }) => {
      expect(await checkWriteKey(header, configured)).toBe(expected);
    });
  });
});
