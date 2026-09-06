//
// Unit tests for what `pnpm user:add` decides, run by `node --test` from the
// Scripts CI job, like the rest of scripts/lib.
//
// Nothing here reaches an environment. What is worth asserting is which rows
// the command would write and which it refuses to write at all - because the
// register is the allowlist, so a row put there wrongly is somebody signing in
// to an account that is not theirs, and a row refused wrongly is somebody
// locked out with no way in but a hand-written INSERT.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  addUser,
  nameForTheRegister,
  readAddress,
  readArguments,
  readRefusal,
} from './add-user.mjs';

/** A register with the two people a fresh environment is seeded with. */
const SEEDED = {
  tenants: [
    { id: 'tenant-default', name: 'Michael', created_at: '2026-08-12T00:00:00.000Z' },
    { id: 'tenant-ada', name: 'Ada', created_at: '2026-09-01T00:00:00.000Z' },
  ],
  users: [
    { id: 'user-michael', name: 'Michael', account_id: 'tenant-default', email: 'michael@example.com' },
    { id: 'user-ada', name: 'Ada', account_id: 'tenant-ada', email: 'ada@example.com' },
  ],
  accounts: ['tenant-ada', 'tenant-default'],
};

/**
 * An environment answering with a register, recording what was written to it.
 * `answers` replaces what the write route hands back, which is how the race
 * between the read and the write is driven.
 */
function environment({ register = SEEDED, answers } = {}) {
  const written = [];
  return {
    written,
    read: async (path) => {
      assert.equal(path, '/v1/admin/backup/register');
      return register;
    },
    write: async (path, body) => {
      written.push({ path, body });
      return answers ?? { accountsCreated: 1, usersCreated: 1 };
    },
  };
}

const at = () => new Date('2026-09-06T09:00:00.000Z');

describe('adding a user gives them an account of their own, ready to sign in to', () => {
  it('writes the person and the account they own, in one write', async () => {
    const env = environment();

    const added = await addUser({
      ...env,
      name: 'Anna',
      email: 'anna@example.com',
      now: at,
    });

    assert.deepEqual(added, {
      user: 'user-anna',
      account: 'tenant-anna',
      name: 'Anna',
      address: 'anna@example.com',
      createdAt: '2026-09-06T09:00:00.000Z',
    });
    // One write rather than two, so an interruption leaves the register
    // untouched. What that write creates is still decided by the route, which
    // is why the counts are checked below rather than the 200.
    assert.equal(env.written.length, 1);
    assert.equal(env.written[0].path, '/v1/admin/restore/register');
    assert.deepEqual(env.written[0].body, {
      tenants: [{ id: 'tenant-anna', name: 'Anna', created_at: '2026-09-06T09:00:00.000Z' }],
      users: [
        {
          id: 'user-anna',
          name: 'Anna',
          account_id: 'tenant-anna',
          role: 'user',
          email: 'anna@example.com',
          created_at: '2026-09-06T09:00:00.000Z',
        },
      ],
    });
  });

  it('leaves the Google identity for Google to say, at the first sign-in', async () => {
    const env = environment();

    await addUser({ ...env, name: 'Anna', email: 'anna@example.com', now: at });

    assert.ok(!('google_subject' in env.written[0].body.users[0]));
  });

  it('gives them the ordinary role, there being no other kind to choose', async () => {
    const env = environment();

    await addUser({ ...env, name: 'Anna', email: 'anna@example.com', now: at });

    assert.equal(env.written[0].body.users[0].role, 'user');
  });

  it('holds the address in one spelling, so signing in finds the row', async () => {
    const env = environment();

    const added = await addUser({ ...env, name: 'Anna', email: '  Anna@Example.COM ', now: at });

    assert.equal(added.address, 'anna@example.com');
    assert.equal(env.written[0].body.users[0].email, 'anna@example.com');
  });
});

describe('adding a user refuses a name or an address the register already knows', () => {
  for (const { situation, name, email, says } of [
    {
      situation: 'the name is one the register already has an account for',
      name: 'Ada',
      email: 'new@example.com',
      says: /tenant-ada is already in the register/,
    },
    {
      situation: 'the name derives an id somebody already goes by, written differently',
      name: '  ada  ',
      email: 'new@example.com',
      says: /tenant-ada is already in the register/,
    },
    {
      // The two ids are refused separately because they can be taken
      // separately: a person's account need not be named after them, and the
      // seeded register is exactly that - `user-michael` owns `tenant-default`,
      // so `tenant-michael` is free while the person is not.
      situation: 'the name is one somebody already goes by, whose account is named otherwise',
      name: 'Michael',
      email: 'new@example.com',
      says: /user-michael is already in the register/,
    },
    {
      situation: 'the address is one somebody already signs in with',
      name: 'Anna',
      email: 'ada@example.com',
      says: /ada@example\.com is already in the register, as user-ada/,
    },
    {
      // Held as written and compared as written by the index, so the command is
      // what has to notice - the register would take both rows.
      situation: 'the address differs from one already there only in case',
      name: 'Anna',
      email: 'ADA@Example.com',
      says: /already in the register, as user-ada/,
    },
  ]) {
    it(`refuses and writes nothing when ${situation}`, async () => {
      const env = environment();

      await assert.rejects(() => addUser({ ...env, name, email, now: at }), says);
      assert.deepEqual(env.written, []);
    });
  }

  // The refusals above are decided against the register as it was read, so
  // somebody adding the same person in that window gets past them, and the
  // write can then half-happen. Each way it can says what is actually true,
  // because they need different things done about them - and the middle one
  // leaves a person who can sign in to an account that is not theirs.
  for (const { situation, answers, says } of [
    {
      situation: 'both rows arrived first, so nothing was written',
      answers: { accountsCreated: 0, usersCreated: 0 },
      says: /nothing was added/,
    },
    {
      situation: 'the account arrived first, so the person now owns somebody else’s',
      answers: { accountsCreated: 0, usersCreated: 1 },
      says: /own an account somebody else made.*settle who owns what/s,
    },
    {
      situation: 'the person arrived first, leaving an account nobody owns',
      answers: { accountsCreated: 1, usersCreated: 0 },
      says: /an account nobody owns.*safe to leave/s,
    },
  ]) {
    it(`says what is true when ${situation}`, async () => {
      const env = environment({ answers });

      await assert.rejects(
        () => addUser({ ...env, name: 'Anna', email: 'anna@example.com', now: at }),
        says,
      );
    });
  }

  it('says so when the write answers something that is not the register', async () => {
    const env = environment({ answers: { ok: true } });

    await assert.rejects(
      () => addUser({ ...env, name: 'Anna', email: 'anna@example.com', now: at }),
      /is something in front of this environment/,
    );
  });
});

describe('a name is turned into one an account can be named after, or refused', () => {
  for (const { situation, given, account, user } of [
    { situation: 'a plain first name', given: 'Anna', account: 'tenant-anna', user: 'user-anna' },
    {
      situation: 'a name with a space in it',
      given: 'Anna Karenina',
      account: 'tenant-anna-karenina',
      user: 'user-anna-karenina',
    },
    {
      situation: 'a name carrying accents',
      given: 'Anna Müller',
      account: 'tenant-anna-muller',
      user: 'user-anna-muller',
    },
    {
      // Upper-then-lower rather than lowercasing, which is not case folding:
      // `Straße` lowercases unchanged and would lose the letter entirely.
      situation: 'a letter that only folds by being uppercased first',
      given: 'Straße',
      account: 'tenant-strasse',
      user: 'user-strasse',
    },
    {
      situation: 'a name with punctuation in it',
      given: "O'Neill-Smith",
      account: 'tenant-o-neill-smith',
      user: 'user-o-neill-smith',
    },
    {
      situation: 'a name padded with spaces and separators',
      given: '  -- Anna --  ',
      account: 'tenant-anna',
      user: 'user-anna',
    },
  ]) {
    it(`derives an id from ${situation}`, () => {
      const ids = nameForTheRegister(given);
      assert.equal(ids.account, account);
      assert.equal(ids.user, user);
      // Whatever comes out has to be a name the rest of the system will take:
      // an account is addressed by it, and a backup writes a file named after
      // it (`accountNameSchema`, and `nameAsAFile` in backup.mjs).
      assert.match(ids.account, /^[A-Za-z0-9._-]+$/);
    });
  }

  it('keeps the name as it was written, and only the id is derived', () => {
    assert.equal(nameForTheRegister('  Anna Müller  ').given, 'Anna Müller');
  });

  it('cuts an id short of the path length a backup has to fit in', () => {
    // A backup writes an account's name as a file name, and Windows refuses a
    // path past 260 characters - so an unbounded id makes an account that can
    // never be backed up.
    const ids = nameForTheRegister('Anna '.repeat(40));
    assert.ok(ids.account.length <= 56, `${ids.account.length} characters is too long`);
    assert.match(ids.account, /^[A-Za-z0-9._-]+$/);
    // Cut before the ends are trimmed, so nothing is left hanging on a
    // separator the cut landed in the middle of.
    assert.doesNotMatch(ids.account, /-$/);
  });

  for (const { situation, given } of [
    { situation: 'nothing at all', given: '' },
    { situation: 'only spaces', given: '   ' },
    { situation: 'only punctuation', given: '!!! ---' },
    { situation: 'letters no id can be made of', given: '日本語' },
  ]) {
    it(`refuses a name that is ${situation}`, () => {
      assert.throws(() => nameForTheRegister(given), /name/);
    });
  }
});

describe('a refusal to add a user says which of the things somebody typed was wrong', () => {
  it('refuses when no address was given, since that is what makes a user real', async () => {
    const env = environment();

    await assert.rejects(
      () => addUser({ ...env, name: 'Anna', email: undefined, now: at }),
      /--email/,
    );
    assert.deepEqual(env.written, []);
  });

  for (const { situation, email } of [
    { situation: 'is a name rather than an address', email: 'Anna' },
    { situation: 'has no domain behind it', email: 'anna@example' },
    { situation: 'has a space in the middle of it', email: 'anna @example.com' },
  ]) {
    it(`refuses an address that ${situation}`, () => {
      assert.throws(() => readAddress(email), /not an address/);
    });
  }

  it('takes an address it cannot check the account behind', () => {
    // Nothing here can tell whether a Google account holds this; that is
    // discovered at the first sign-in, so refusing plausible ones is theatre.
    assert.equal(readAddress('anna.karenina+cockpit@googlemail.com'), 'anna.karenina+cockpit@googlemail.com');
  });

  it('refuses when no name was given', async () => {
    const env = environment();

    await assert.rejects(
      () => addUser({ ...env, name: undefined, email: 'anna@example.com', now: at }),
      /--name/,
    );
    assert.deepEqual(env.written, []);
  });

  it('says so when the environment answers something that is not the register', async () => {
    await assert.rejects(
      () =>
        addUser({
          read: async () => ({ ok: true }),
          write: async () => assert.fail('nothing should be written'),
          name: 'Anna',
          email: 'anna@example.com',
          now: at,
        }),
      /is something in front of this environment/,
    );
  });

  for (const { situation, answer, says } of [
    {
      situation: 'the secret was not accepted',
      answer: { status: 401, body: '{"error":"not allowed"}' },
      says: /BACKUP_TOKEN/,
    },
    {
      situation: 'the register disagrees about who somebody is',
      answer: { status: 409, body: '{"error":"the address is already in the register as user-ada"}' },
      says: /Nobody was added/,
    },
    {
      situation: 'nothing answered at all',
      answer: { status: 0, body: '' },
      says: /is the environment up/,
    },
    {
      situation: 'something nobody planned for',
      answer: { status: 500, body: 'gateway fell over' },
      says: /answered 500: gateway fell over/,
    },
  ]) {
    it(`says so when ${situation}`, () => {
      assert.match(readRefusal(answer), says);
    });
  }
});

describe('adding a user writes to the environment it was pointed at, and local by default', () => {
  it('takes local when no environment was named', () => {
    assert.equal(readArguments(['--name', 'Anna', '--email', 'anna@example.com']).environment, 'local');
  });

  it('takes the environment it was given', () => {
    assert.equal(
      readArguments(['--name', 'Anna', '--email', 'a@b.com', '--env', 'production']).environment,
      'production',
    );
  });

  // Everything about what was typed is decided here, because the runner prints
  // the usage line for what this throws and for nothing else - so a name or an
  // address left out anywhere further in is a mistyped command answered without
  // the line saying how to type it.
  for (const { situation, argv, says } of [
    { situation: 'no name', argv: ['--email', 'a@b.com'], says: /--name/ },
    { situation: 'no address', argv: ['--name', 'Anna'], says: /--email/ },
    { situation: 'nothing at all', argv: [], says: /--name/ },
    { situation: 'a name no id can be made of', argv: ['--name', '!!!', '--email', 'a@b.com'], says: /leaves nothing/ },
    { situation: 'an address that is not one', argv: ['--name', 'Anna', '--email', 'Anna'], says: /not an address/ },
  ]) {
    it(`refuses ${situation}, so the usage line is what gets printed`, () => {
      assert.throws(() => readArguments(argv), says);
    });
  }

  it('refuses a flag it does not have', () => {
    assert.throws(() => readArguments(['--role', 'admin']), /there is no --role/);
  });

  it('refuses a flag with nothing after it, rather than taking the next flag as its value', () => {
    assert.throws(() => readArguments(['--name', '--email', 'a@b.com']), /--name was given nothing/);
  });
});
