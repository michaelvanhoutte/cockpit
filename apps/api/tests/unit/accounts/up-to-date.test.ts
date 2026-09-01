import { describe, expect, it } from 'vitest';
import { bringUpToDate, type Change } from '../../../src/accounts/up-to-date.js';

/**
 * Unit level: bringing an account up to date is a list of changes, a record of
 * what has already run, and an executor that applies one of them. With the
 * executor injected there is no storage, no clock and no Durable Object left in
 * it, so every branch is decidable here.
 *
 * The executor below is a store rather than a call log: what these cases assert
 * is the set of changes an account ends up having applied, which is the state
 * the real executor writes, not the sequence of calls that got there.
 */

const ACCOUNT = 'tenant-default';

function change(name: string): Change {
  return { name, statements: [{ sql: `-- ${name}` }] };
}

/** An account's store, reduced to the only thing these cases can observe about it. */
function anAccountThatAppliesEverything() {
  const applied: string[] = [];
  return { applied, apply: (c: Change) => void applied.push(c.name) };
}

describe('Accounts', () => {
  describe('an account applies every change it has not applied yet, once and in order', () => {
    it('applies the ones it is missing, oldest first', () => {
      const account = anAccountThatAppliesEverything();

      const justApplied = bringUpToDate(
        ACCOUNT,
        [change('one'), change('two'), change('three')],
        [],
        account.apply,
      );

      expect(account.applied).toEqual(['one', 'two', 'three']);
      expect(justApplied).toEqual(['one', 'two', 'three']);
    });

    it('leaves alone the ones it has already applied', () => {
      const account = anAccountThatAppliesEverything();

      const justApplied = bringUpToDate(
        ACCOUNT,
        [change('one'), change('two'), change('three')],
        ['one', 'two'],
        account.apply,
      );

      expect(account.applied).toEqual(['three']);
      expect(justApplied).toEqual(['three']);
    });
  });

  describe('a change that cannot be applied says which change failed and why', () => {
    it('names the change and the reason, and stops there', () => {
      const account = anAccountThatAppliesEverything();
      const apply = (c: Change) => {
        if (c.name === 'two') throw new Error('table commands already exists');
        account.apply(c);
      };

      expect(() =>
        bringUpToDate(ACCOUNT, [change('one'), change('two'), change('three')], [], apply),
      ).toThrow(/two.*table commands already exists/);

      // The change that failed is not recorded, and nothing after it is tried:
      // the next open has to be able to retry it whole.
      expect(account.applied).toEqual(['one']);
    });
  });
});
