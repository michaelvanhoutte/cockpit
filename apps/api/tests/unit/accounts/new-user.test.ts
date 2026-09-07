import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_NAME_LIMIT,
  addressLooksReal,
  foldAddress,
  idsForNewUser,
  nameAsIdPart,
  whatIsWrongWith,
} from '../../../src/accounts/new-user.js';

/**
 * Unit level: what a name derives and what an address folds to are decisions
 * about strings, with no register behind them. The integration suite proves the
 * rows land and the refusals reach the person; it cannot ask what happens to a
 * name of forty-eight characters or to `Straße` without writing one of each
 * into a register first, which would prove the same thing more slowly.
 */
describe('User management', () => {
  describe('a name gives an account something to be called, or is refused', () => {
    it.each([
      { situation: 'an ordinary name', name: 'Anna', part: 'anna' },
      { situation: 'two words', name: 'Anna Smith', part: 'anna-smith' },
      // `ß` has no single-character uppercase, so folding upper-then-lower is
      // what turns it into letters an id can hold rather than dropping it.
      { situation: 'a letter that folds to two', name: 'Straße', part: 'strasse' },
      { situation: 'accents', name: 'Renée', part: 'ren-e' },
      { situation: 'punctuation around the edges', name: '  ..Anna..  ', part: 'anna' },
      { situation: 'a name that is already an id', name: 'anna-smith', part: 'anna-smith' },
    ])('$situation', ({ name, part }) => {
      expect(nameAsIdPart(name)).toBe(part);
    });

    it.each([
      { situation: 'nothing at all', name: '' },
      { situation: 'only spaces', name: '   ' },
      { situation: 'only punctuation', name: '!!!' },
      // Nothing an id can be made of, though it is a name somebody may hold.
      { situation: 'only letters no id can hold', name: '日本語' },
    ])('refuses $situation', ({ name }) => {
      expect(nameAsIdPart(name)).toBeNull();
    });

    /**
     * A backup writes an account's name as a file name, and a Windows path
     * stops at 260 characters, so a long name is bounded here rather than
     * discovered to be unusable on the day somebody takes a backup.
     */
    it('bounds what a very long name derives', () => {
      const derived = idsForNewUser('a'.repeat(200), () => false)!;

      expect(derived.accountId.length).toBeLessThanOrEqual(ACCOUNT_NAME_LIMIT);
      expect(derived.accountId).toMatch(/^[A-Za-z0-9._-]+$/);
    });
  });

  describe('two people of one name both get in, with accounts of their own', () => {
    it('gives the first the plain id', () => {
      expect(idsForNewUser('Anna', () => false)).toEqual({
        accountId: 'tenant-anna',
        userId: 'user-anna',
      });
    });

    it.each([
      { situation: 'the account is taken', held: ['tenant-anna'] },
      { situation: 'the person is taken', held: ['user-anna'] },
      { situation: 'both are taken', held: ['tenant-anna', 'user-anna'] },
    ])('extends the id when $situation', ({ held }) => {
      const ids = idsForNewUser('Anna', ({ accountId, userId }) =>
        held.includes(accountId) || held.includes(userId),
      );

      expect(ids).toEqual({ accountId: 'tenant-anna-2', userId: 'user-anna-2' });
    });

    /**
     * The pair keeps one suffix, so a person and their account still read as
     * belonging together - `user-anna-3` owning `tenant-anna-2` would be true
     * and unreadable.
     */
    it('keeps the person and their account on the same number', () => {
      const held = ['tenant-anna', 'user-anna-2'];
      const ids = idsForNewUser('Anna', ({ accountId, userId }) =>
        held.includes(accountId) || held.includes(userId),
      )!;

      expect(ids).toEqual({ accountId: 'tenant-anna-3', userId: 'user-anna-3' });
    });

    it('refuses a name that leaves nothing to extend', () => {
      expect(idsForNewUser('!!!', () => false)).toBeNull();
    });
  });

  describe('an address is settled on one spelling before the register sees it', () => {
    it.each([
      { situation: 'capitals', typed: 'Anna@Example.com', folded: 'anna@example.com' },
      { situation: 'spaces around it', typed: '  anna@example.com  ', folded: 'anna@example.com' },
    ])('folds $situation', ({ typed, folded }) => {
      expect(foldAddress(typed)).toBe(folded);
    });

    it.each([
      { situation: 'an ordinary address', address: 'anna@example.com', real: true },
      { situation: 'a subdomain', address: 'anna@mail.example.co.uk', real: true },
      { situation: 'no domain', address: 'anna@', real: false },
      { situation: 'no name', address: '@example.com', real: false },
      { situation: 'no at sign', address: 'anna.example.com', real: false },
      { situation: 'no dot in the domain', address: 'anna@example', real: false },
      { situation: 'a space in it', address: 'anna smith@example.com', real: false },
    ])('$situation', ({ address, real }) => {
      expect(addressLooksReal(address)).toBe(real);
    });
  });

  describe('what was typed is refused in words the person can act on', () => {
    it.each([
      { situation: 'no address', typed: { name: 'Anna', address: '' }, says: /address/ },
      { situation: 'an address that is not one', typed: { name: 'Anna', address: 'anna' }, says: /not an address/ },
      { situation: 'no name', typed: { name: '  ', address: 'anna@example.com' }, says: /name is needed/ },
      {
        situation: 'a name no account can be called after',
        typed: { name: '!!!', address: 'anna@example.com' },
        says: /nothing an account could be named after/,
      },
    ])('$situation', ({ typed, says }) => {
      expect(whatIsWrongWith(typed)?.what).toMatch(says);
    });

    it('says nothing is wrong with a name and an address', () => {
      expect(whatIsWrongWith({ name: 'Anna', address: 'anna@example.com' })).toBeNull();
    });
  });
});
