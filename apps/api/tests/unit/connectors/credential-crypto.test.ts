import { describe, expect, it } from 'vitest';
import { open, seal, sealingKey } from '../../../src/connectors/credential-crypto.js';

/**
 * L1, against real Web Crypto: everything this module does is local, so every
 * branch is provable here without a network, a database or a Worker.
 *
 * What it cannot prove is that anything is sealed on the way in, which is
 * tests/integration/http/connections.test.ts's - that one reads the stored row
 * and asserts the credential is not in it in the clear.
 */

/** 32 bytes of base64, which is what a key has to be. */
const A_KEY = 'Y29ja3BpdC10ZXN0LWNvbm5lY3Rvci1rZXktMDAwMDA=';
const ANOTHER_KEY = 'YW5vdGhlci1rZXktZW50aXJlbHktMDAwMDAwMDAwMDA=';

const CREDENTIAL = '{"token_type":"Bearer","id_token":"an.identity.token"}';

describe('Connector management', () => {
  describe('a credential is stored sealed, and only this Cockpit can open it', () => {
    it('gives back what was sealed', async () => {
      const key = (await sealingKey(A_KEY))!;

      const sealed = await seal(CREDENTIAL, key);

      expect(sealed.sealedCredential).not.toContain('id_token');
      await expect(open(sealed, key)).resolves.toBe(CREDENTIAL);
    });

    /**
     * Reusing a nonce under one key is what breaks AES-GCM outright, so each
     * sealing gets its own - and sealing the same credential twice must
     * therefore produce two different sets of bytes.
     */
    it('seals the same credential differently every time', async () => {
      const key = (await sealingKey(A_KEY))!;

      const once = await seal(CREDENTIAL, key);
      const again = await seal(CREDENTIAL, key);

      expect(once.credentialNonce).not.toBe(again.credentialNonce);
      expect(once.sealedCredential).not.toBe(again.sealedCredential);
      await expect(open(again, key)).resolves.toBe(CREDENTIAL);
    });

    /**
     * Every way a sealed credential can fail to open is the same answer,
     * because the caller does the same thing with all of them: the credential
     * is not usable. What matters is that none of them hands back plausible
     * rubbish, which is the whole reason for an authenticated cipher.
     */
    it.each([
      { situation: 'bytes sealed under a different key', spoil: 'key' },
      { situation: 'bytes somebody has altered', spoil: 'bytes' },
      { situation: 'a nonce that is not the one it was sealed under', spoil: 'nonce' },
      { situation: 'a nonce of the wrong length', spoil: 'short nonce' },
      { situation: 'bytes that are not base64 at all', spoil: 'not base64' },
    ])('refuses to open $situation', async ({ spoil }) => {
      const key = (await sealingKey(A_KEY))!;
      const other = (await sealingKey(ANOTHER_KEY))!;
      const sealed = await seal(CREDENTIAL, key);

      const opening = {
        key: () => open(sealed, other),
        bytes: () => open({ ...sealed, sealedCredential: flipped(sealed.sealedCredential) }, key),
        nonce: () => open({ ...sealed, credentialNonce: flipped(sealed.credentialNonce) }, key),
        'short nonce': () => open({ ...sealed, credentialNonce: 'AAAA' }, key),
        'not base64': () => open({ ...sealed, sealedCredential: 'not base64 at all!' }, key),
      }[spoil]!;

      await expect(opening()).resolves.toBeNull();
    });
  });

  describe('an environment with no key seals nothing rather than storing a credential in the clear', () => {
    it.each([
      { situation: 'no key at all', secret: undefined },
      { situation: 'a key nobody filled in', secret: '' },
      { situation: 'a key that is not base64', secret: 'this is not base64!' },
      { situation: 'a key of the wrong length', secret: 'c2hvcnQ=' },
    ])('has nothing to seal with, given $situation', async ({ secret }) => {
      await expect(sealingKey(secret)).resolves.toBeNull();
    });

    it('has one, given 32 bytes of base64', async () => {
      await expect(sealingKey(A_KEY)).resolves.not.toBeNull();
    });
  });
});

/** One character of base64 changed, which is enough to alter the bytes behind it. */
function flipped(base64: string): string {
  const at = 4;
  const was = base64[at]!;
  return `${base64.slice(0, at)}${was === 'A' ? 'B' : 'A'}${base64.slice(at + 1)}`;
}
