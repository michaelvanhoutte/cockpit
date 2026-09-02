import { describe, expect, it } from 'vitest';
import { accountChanges } from '../../../src/accounts/changes.js';

/**
 * The shape of the change list itself, rather than what any change does.
 *
 * **This exists because two branches appended to it at once.** "Modernise the
 * app shell" (issue 125) and "Reorder workspaces" (issue 31) were built beside
 * each other and both added a change called `0004-…`; git merged the two
 * definitions cleanly, because they are separate constants that do not touch,
 * and the collision was left for a person to notice in review. A store keys on
 * the name, so a duplicate is not cosmetic - it means the second change is
 * skipped forever on any account that applied the first.
 *
 * It was noticed, and renaming was the fix. What it cost is the reason this
 * file exists: a rename makes an applied change look unapplied, so it runs
 * again and the account cannot be opened at all (`duplicate column name`).
 * Catching the collision here, in CI, is what stops the renaming being needed
 * once the number has been carried into anybody's store.
 */
describe('Accounts', () => {
  describe('every schema change an account applies is named once, in order', () => {
    // L1: the list is a value. Whether each change *works* is proved against a
    // real store in tests/integration/accounts.
    const names = accountChanges('any-account-would-do').map((change) => change.name);

    it('gives no two changes the same name, so none can be mistaken for another', () => {
      expect(new Set(names).size).toBe(names.length);
    });

    it('numbers them from the front with no gaps and no repeats', () => {
      // The ordinal is what a reader sorts by, and two branches appending at
      // once is exactly how it stops being sortable.
      expect(names.map((name) => name.slice(0, 4))).toEqual(
        names.map((_, i) => String(i + 1).padStart(4, '0')),
      );
    });

    it('writes every name in one shape, so the ordinal above can always be read', () => {
      // Four digits, then lower-case words: `0006-2fa` and `0006-Workspace-Bar`
      // are both refused, and so is anything without a four-digit head, which
      // is what the ordinal case slices blindly.
      //
      // It does *not* police whether a name says what the change does -
      // `0006-issue-131` matches this happily. No pattern can make that
      // judgement and this one does not pretend to; it is a review question.
      // The name of this case says shape for that reason, having first said
      // something the assertion could not hold.
      for (const name of names) {
        expect(name, name).toMatch(/^\d{4}-[a-z][a-z0-9-]*$/);
      }
    });
  });
});
