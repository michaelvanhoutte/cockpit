import { describe, expect, it } from 'vitest';
import {
  hookSecretFor,
  isHookSecret,
  waitingFrom,
} from '../../../src/engines/claude-code-hooks.js';

/**
 * L1: pure apart from Web Crypto, which is the same API the Worker runs - the
 * secret a connection's hooks carry, how often one connection is heard, and
 * what each hook says ("See on the item when Claude is waiting on you", issue
 * 572). That the route refuses by them, before any account is opened, is
 * tests/integration/http/claude-code-hooks.test.ts's.
 */

const KEY = 'Y29ja3BpdC10ZXN0LWNvbm5lY3Rvci1rZXktMDAwMDA=';
const OTHER_KEY = 'b3RoZXItZW52aXJvbm1lbnQta2V5LTAwMDAwMDAwMDA=';

describe('Connector management', () => {
  describe('a hook is let in only with the secret issued for its own connection', () => {
    it.each([
      { situation: 'its own connection’s secret', issuedFor: 'conn-a', key: KEY, admitted: true },
      { situation: 'another connection’s secret', issuedFor: 'conn-b', key: KEY, admitted: false },
      { situation: 'a secret another environment issued', issuedFor: 'conn-a', key: OTHER_KEY, admitted: false },
    ])('$situation', async ({ issuedFor, key, admitted }) => {
      const secret = (await hookSecretFor(key, issuedFor))!;

      expect(await isHookSecret(KEY, 'conn-a', secret)).toBe(admitted);
    });

    it.each([
      { situation: 'no secret', presented: '' },
      { situation: 'something that is not a secret at all', presented: 'not base64url!' },
    ])('refuses $situation', async ({ presented }) => {
      expect(await isHookSecret(KEY, 'conn-a', presented)).toBe(false);
    });

    it('issues no secret where the environment holds no key', async () => {
      expect(await hookSecretFor(undefined, 'conn-a')).toBeNull();
      expect(await isHookSecret(undefined, 'conn-a', 'anything')).toBe(false);
    });

    it('issues the same secret every time it is asked', async () => {
      expect(await hookSecretFor(KEY, 'conn-a')).toBe(await hookSecretFor(KEY, 'conn-a'));
    });
  });

  describe('Stop says Claude is waiting on you, a prompt that it is working again', () => {
    it.each([
      { event: 'Stop', waiting: true },
      { event: 'UserPromptSubmit', waiting: false },
      { event: 'PreToolUse', waiting: null },
      { event: undefined, waiting: null },
    ])('$event', ({ event, waiting }) => {
      expect(waitingFrom(event)).toBe(waiting);
    });
  });
});
