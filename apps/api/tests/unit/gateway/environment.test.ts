import { describe, expect, it } from 'vitest';
import { environmentOf, hasClaudeKey } from '../../../src/gateway/environment.js';
import { environmentOfToken } from '../../../src/gateway/receive.js';

/**
 * Unit level: which system a Worker is, whether its key counts, and which
 * environment a token names are decisions over plain values. What the person
 * sees of them is the integration tier's
 * (tests/integration/http/ai-usage-from-other-environments.test.ts).
 */

describe('AI usage', () => {
  describe('a Worker is the environment its configuration names, and local where it names none', () => {
    it.each([
      { situation: 'production', value: 'production', expected: 'production' },
      { situation: 'staging', value: 'staging', expected: 'staging' },
      { situation: 'nothing', value: undefined, expected: 'local' },
      { situation: 'something nobody defined', value: 'prod', expected: 'local' },
      { situation: 'production in another case', value: 'Production', expected: 'local' },
    ])('is $expected when it names $situation', ({ value, expected }) => {
      expect(environmentOf({ ENVIRONMENT: value })).toBe(expected);
    });
  });

  describe('outside production a key with no recording token counts as no key', () => {
    it.each([
      { situation: 'production, a key and no token', environment: 'production', key: 'sk-a', token: '', url: '', counts: true },
      { situation: 'production, no key', environment: 'production', key: '', token: '', url: '', counts: false },
      { situation: 'staging, a key, a token and an address', environment: 'staging', key: 'sk-a', token: 'tok', url: 'https://p.test', counts: true },
      { situation: 'staging, a key and no token', environment: 'staging', key: 'sk-a', token: '', url: 'https://p.test', counts: false },
      { situation: 'staging, a key and a token but no address', environment: 'staging', key: 'sk-a', token: 'tok', url: '', counts: false },
      { situation: 'local, a key and no token', environment: undefined, key: 'sk-a', token: undefined, url: 'https://p.test', counts: false },
      { situation: 'local, a token and no key', environment: undefined, key: '', token: 'tok', url: 'https://p.test', counts: false },
    ])('is $counts for $situation', ({ environment, key, token, url, counts }) => {
      expect(
        hasClaudeKey({
          ENVIRONMENT: environment,
          ANTHROPIC_API_KEY: key,
          USAGE_RECORDING_TOKEN: token,
          USAGE_RECORDING_URL: url,
        }),
      ).toBe(counts);
    });
  });

  describe('a recording token says which environment sent a record, and an unknown one says none', () => {
    const held = { USAGE_TOKEN_STAGING: 'staging-secret', USAGE_TOKEN_CI: 'ci-secret', USAGE_TOKEN_LOCAL: 'local-secret' };

    it.each([
      { situation: 'staging’s token', header: 'Bearer staging-secret', held, expected: 'staging' },
      { situation: 'CI’s token', header: 'Bearer ci-secret', held, expected: 'ci' },
      { situation: 'the local token', header: 'bearer local-secret', held, expected: 'local' },
      { situation: 'a token of none of them', header: 'Bearer other-secret', held, expected: null },
      { situation: 'a token that is only the start of one', header: 'Bearer staging', held, expected: null },
      { situation: 'no header', header: undefined, held, expected: null },
      { situation: 'another scheme', header: 'Basic staging-secret', held, expected: null },
      { situation: 'an empty token, with none configured', header: 'Bearer ', held: {}, expected: null },
      { situation: 'a token for an environment with none configured', header: 'Bearer ci-secret', held: { USAGE_TOKEN_STAGING: 'staging-secret' }, expected: null },
      { situation: 'a token configured for two environments', header: 'Bearer same', held: { USAGE_TOKEN_STAGING: 'same', USAGE_TOKEN_CI: 'same' }, expected: null },
    ])('reads $situation as $expected', async ({ header, held: tokens, expected }) => {
      expect(await environmentOfToken(tokens, header)).toBe(expected);
    });
  });
});
