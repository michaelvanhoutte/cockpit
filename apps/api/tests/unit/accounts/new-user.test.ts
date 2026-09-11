import { describe, expect, it } from 'vitest';
import { NAME_LIMIT } from '@cockpit/shared';
import {
  ACCOUNT_NAME_LIMIT,
  addressLooksReal,
  foldAddress,
  idSearchPrefix,
  idsForNewUser,
  nameAsIdPart,
  newcomerNamed,
  whatIsWrongWith,
} from '../../../src/accounts/new-user.js';

/**
 * Unit level: what a name derives and what an address folds to are decisions
 * about strings, with no register behind them. The integration suite proves the
 * rows land and the refusals reach the person; it cannot ask what happens to a
 * name of forty-eight characters or to `Straße` without writing one of each
 * into a register first, which would prove the same thing more slowly.
 */
describe('Sign-in', () => {
  /**
   * Somebody who signs in without having been added ("Sign in with any Google
   * account, so a recruiter doesn't need to be added first", issue 343) has
   * nobody there to type a name for them, so every answer here is a name
   * rather than a refusal. That the name reaches the register at all is
   * tests/integration/http/sign-in.test.ts's.
   */
  describe('somebody who signs themselves up is called what Google calls them, and their account after it', () => {
    it.each([
      {
        situation: 'the name Google gives',
        given: 'Rita Recruiter',
        called: 'Rita Recruiter',
        accountAfter: 'Rita Recruiter',
      },
      { situation: 'that name without the spaces around it', given: '  Rita  ', called: 'Rita', accountAfter: 'Rita' },
      {
        situation: 'the address, where Google gives no name',
        given: undefined,
        called: 'rita@example.com',
        accountAfter: 'rita@example.com',
      },
      {
        situation: 'the address, where the name is nothing but spaces',
        given: '   ',
        called: 'rita@example.com',
        accountAfter: 'rita@example.com',
      },
      // A name somebody may hold that no account can be named after: they are
      // still called it, and nobody is there to be asked for another.
      {
        situation: 'a name no account can be named after, with the account named after the address',
        given: '日本語',
        called: '日本語',
        accountAfter: 'rita@example.com',
      },
    ])('by $situation', ({ given, called, accountAfter }) => {
      expect(newcomerNamed('rita@example.com', given)).toEqual({ name: called, idsFrom: accountAfter });
    });

    /**
     * Cut to what the rename form accepts, so an admin can still edit the row -
     * and by character rather than by UTF-16 unit, so the cut never leaves half
     * of one behind.
     */
    it('cuts a very long name to what an admin could have typed', () => {
      const { name } = newcomerNamed('rita@example.com', '😀'.repeat(NAME_LIMIT + 10));

      expect(name).toBe('😀'.repeat(NAME_LIMIT));
    });
  });
});

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

    /**
     * The case that hung. A name filling the whole limit used to append its
     * suffix and cut it straight back off, so every candidate was the same
     * string and the search never finished - a request that spun until the
     * Worker's CPU limit killed it, reachable by adding one long name twice.
     * Room is made for the suffix now, so each one is a different id.
     */
    it('still tells two people apart when their name fills the limit', () => {
      const long = 'a'.repeat(60);
      const held = new Set([idsForNewUser(long, () => false)!.accountId]);

      const second = idsForNewUser(long, ({ accountId }) => held.has(accountId))!;

      expect(second.accountId).not.toBe([...held][0]);
      expect(second.accountId.length).toBeLessThanOrEqual(ACCOUNT_NAME_LIMIT);
      expect(second.userId.endsWith('-2')).toBe(true);
    });

    /**
     * And it stops rather than searching forever. A thousand people of one name
     * is not a case worth walking; a refusal is something an admin can read.
     */
    it('gives up rather than searching for ever', () => {
      expect(idsForNewUser('Anna', () => true)).toBeNull();
    });

    /**
     * The seam the loop fix opened, and the one a lookup has to close: a
     * candidate with a suffix has room made for it by trimming the name, so
     * `tenant-<40 letters>-2` does *not* begin with `tenant-<40 letters>`.
     * Anything searching the register for "the ids this name could take" has to
     * search on the shorter prefix, or it cannot see the very rows it is
     * looking for - hands out one somebody already has, and the person is told
     * to try again for ever, since every attempt derives the same id.
     */
    it.each([
      { situation: 'a short name', name: 'Anna' },
      { situation: 'a name that fills the limit', name: 'a'.repeat(60) },
      { situation: 'a name ending in punctuation once folded', name: `${'b'.repeat(38)}!!!!` },
    ])('every id $situation can take starts with the prefix a lookup searches on', ({ name }) => {
      const prefix = idSearchPrefix(name)!;
      const held = new Set<string>();

      // Several people of this name, so the truncated candidates are reached.
      for (let person = 0; person < 4; person += 1) {
        const ids = idsForNewUser(name, ({ accountId }) => held.has(accountId))!;
        expect(ids.accountId.startsWith(`tenant-${prefix}`)).toBe(true);
        expect(ids.userId.startsWith(`user-${prefix}`)).toBe(true);
        held.add(ids.accountId);
      }
      expect(held.size).toBe(4);
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
