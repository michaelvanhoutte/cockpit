//
// Unit tests for what `pnpm backup:restore` decides, run by `node --test` from
// the Scripts CI job, like the rest of scripts/lib.
//
// Nothing here reaches an environment or the disk. What is worth asserting is
// the ordering and the refusals, because this is the half that destroys
// something: which environments have to be named out loud before they are
// written to, that the register is never touched before the accounts, and that
// a run which stops partway says how far it got.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  needsSayingOutLoud,
  putBack,
  readArguments,
  readBackup,
  readRefusal,
} from './restore.mjs';

const AT = '2026-09-06T09:00:00.000Z';

function backupOf({ accounts = ['tenant-a', 'tenant-b'] } = {}) {
  return {
    manifest: { takenAt: AT, environment: 'production', accounts: accounts.map((a) => ({ account: a })) },
    register: {
      tenants: accounts.map((id) => ({ id, name: id, created_at: AT })),
      users: accounts.map((id) => ({ id: `user-${id}`, account_id: id, created_at: AT })),
    },
    accounts: Object.fromEntries(
      accounts.map((id) => [id, { changesApplied: ['0001-account-schema'], tables: {} }]),
    ),
  };
}

/** An environment that accepts everything, recording the order it was asked. */
function accepting({ failOn } = {}) {
  const asked = [];
  return {
    asked,
    ask: async (path, body) => {
      asked.push({ path, body });
      if (failOn && path.includes(failOn)) throw new Error(`refused: ${failOn} would not take it`);
      if (path === '/v1/operator/restore/register') return { accountsCreated: 1, usersCreated: 1 };
      return { tablesWritten: 1, rowsWritten: 3 };
    },
  };
}

describe('restoring puts the accounts back before the register', () => {
  // A user in the register points at a store. One that exists before their
  // store does is somebody who can sign in to an account that is not there.
  it('writes every account before it writes the register', async () => {
    const env = accepting();

    await putBack({ ask: env.ask, backup: backupOf(), force: false });

    assert.deepEqual(
      env.asked.map((one) => one.path),
      [
        '/v1/operator/restore/accounts/tenant-a',
        '/v1/operator/restore/accounts/tenant-b',
        '/v1/operator/restore/register',
      ],
    );
  });

  it('never reaches the register when an account will not go in', async () => {
    const env = accepting({ failOn: 'tenant-b' });

    await assert.rejects(putBack({ ask: env.ask, backup: backupOf(), force: false }));

    assert.ok(!env.asked.some((one) => one.path.includes('register')));
  });

  // A run across several accounts is not one transaction, so what did go in has
  // to be named. Reporting only the last error leaves somebody to work out how
  // far it got against a backup they can no longer trust.
  it('says which accounts went in when it stops partway', async () => {
    const env = accepting({ failOn: 'tenant-b' });

    await assert.rejects(putBack({ ask: env.ask, backup: backupOf(), force: false }), (error) => {
      assert.match(error.message, /Restored: tenant-a\./);
      assert.match(error.message, /register was not touched/);
      return true;
    });
  });

  /**
   * The moment the report matters most: every account has already been replaced
   * and cannot be put back, so a refusal saying only what the register objected
   * to leaves somebody holding an environment they cannot describe. It is also
   * the guarantee docs/deployment.md makes - "a run that stops partway names the
   * accounts that went in".
   */
  it('says which accounts are already in when the register refuses', async () => {
    const env = accepting({ failOn: 'register' });

    await assert.rejects(putBack({ ask: env.ask, backup: backupOf(), force: false }), (error) => {
      assert.match(error.message, /Restored: tenant-a, tenant-b\./);
      assert.match(error.message, /cannot be put back/);
      assert.match(error.message, /register was not written/);
      return true;
    });
  });

  it('says nothing was restored when the first account refuses', async () => {
    const env = accepting({ failOn: 'tenant-a' });

    await assert.rejects(putBack({ ask: env.ask, backup: backupOf(), force: false }), (error) => {
      assert.match(error.message, /Nothing was restored\./);
      return true;
    });
  });
});

describe('restoring one account brings back that account and nobody else', () => {
  it('writes only the account asked for', async () => {
    const env = accepting();

    await putBack({ ask: env.ask, backup: backupOf(), only: 'tenant-b', force: false });

    assert.deepEqual(
      env.asked.map((one) => one.path),
      ['/v1/operator/restore/accounts/tenant-b', '/v1/operator/restore/register'],
    );
  });

  // Restoring one person into a shared environment should not bring everybody
  // else's register row along with them.
  it('sends only that account’s register rows', async () => {
    const env = accepting();

    await putBack({ ask: env.ask, backup: backupOf(), only: 'tenant-b', force: false });

    const sent = env.asked.at(-1).body;
    assert.deepEqual(sent.tenants.map((row) => row.id), ['tenant-b']);
    assert.deepEqual(sent.users.map((row) => row.id), ['user-tenant-b']);
  });

  it('refuses a name the backup does not hold, and says what it does', async () => {
    await assert.rejects(
      putBack({ ask: accepting().ask, backup: backupOf(), only: 'nobody', force: false }),
      /no account nobody.*tenant-a, tenant-b/s,
    );
  });
});

describe('restoring reads only a backup that finished', () => {
  // The manifest is written last for exactly this reason, so a directory
  // without one is a run that stopped rather than a backup to restore from.
  for (const { situation, parts, complaint } of [
    {
      situation: 'no manifest at all',
      parts: { manifest: undefined, register: { tenants: [], users: [] }, accounts: {} },
      complaint: /did not finish/,
    },
    {
      situation: 'a manifest that is not one',
      parts: { manifest: { takenAt: AT }, register: { tenants: [], users: [] }, accounts: {} },
      complaint: /did not finish/,
    },
    {
      situation: 'no register',
      parts: { manifest: { accounts: [] }, register: undefined, accounts: {} },
      complaint: /no register in it/,
    },
    {
      situation: 'an account the manifest names but the directory does not hold',
      parts: {
        manifest: { accounts: [{ account: 'tenant-a' }, { account: 'tenant-gone' }] },
        register: { tenants: [], users: [] },
        accounts: { 'tenant-a': {} },
      },
      complaint: /tenant-gone, which is not in it/,
    },
  ]) {
    it(`refuses ${situation}`, () => {
      assert.throws(() => readBackup(parts), complaint);
    });
  }

  it('reads a backup that has all of its parts', () => {
    const whole = backupOf();
    assert.deepEqual(readBackup(whole), whole);
  });
});

describe('restoring names the environment it is about to change', () => {
  // Both deployed environments hold real data nothing re-seeds or wipes, so a
  // restore into either destroys something nobody can put back.
  for (const { environment, saidOutLoud } of [
    { environment: 'production', saidOutLoud: true },
    { environment: 'staging', saidOutLoud: true },
    { environment: 'local', saidOutLoud: false },
  ]) {
    it(`${saidOutLoud ? 'asks before writing to' : 'writes to'} ${environment}`, () => {
      assert.equal(needsSayingOutLoud(environment), saidOutLoud);
    });
  }
});

describe('restoring refuses what it cannot act on, and says why', () => {
  for (const { situation, argv, complaint } of [
    { situation: 'no environment', argv: ['--from', 'b'], complaint: /--env/ },
    { situation: 'no backup to read', argv: ['--env', 'local'], complaint: /--from/ },
    {
      situation: 'a flag it does not have',
      argv: ['--env', 'local', '--from', 'b', '--everything'],
      complaint: /there is no --everything/,
    },
    {
      situation: 'a flag with nothing after it',
      argv: ['--env', 'local', '--from'],
      complaint: /--from was given nothing/,
    },
    {
      situation: 'an environment given twice',
      argv: ['--env', 'local', '--env', 'production', '--from', 'b'],
      complaint: /--env was given twice/,
    },
    // The same check as the backup command's, and it matters more here: a typo
    // that got past this would be answered by whatever looked the name up
    // first, in that thing's terms rather than in terms of the name being wrong.
    {
      situation: 'an environment that does not exist',
      argv: ['--env', 'prod', '--from', 'b'],
      complaint: /no environment prod - it is one of local, staging, production/,
    },
  ]) {
    it(`refuses ${situation}`, () => {
      assert.throws(() => readArguments(argv), complaint);
    });
  }

  it('reads what it was asked to do', () => {
    assert.deepEqual(readArguments(['--env', 'staging', '--from', 'b', '--user', 'a', '--force']), {
      environment: 'staging',
      from: 'b',
      user: 'a',
      force: true,
    });
  });

  it('leaves force off unless it was asked for', () => {
    assert.equal(readArguments(['--env', 'local', '--from', 'b']).force, false);
  });
});

describe('a refusal to restore says which of the things somebody typed was wrong', () => {
  for (const { situation, answer, says, path, never } of [
    {
      situation: 'the secret was not accepted',
      answer: { status: 401, body: '{"error":"not allowed"}' },
      says: /BACKUP_TOKEN/,
    },
    {
      // A restore meets this the same way an export does, and it matters more
      // here: this command writes, so an operator who believes the secret was
      // rejected rotates it and tries again against an environment that was
      // never going to answer.
      situation: 'the environment is older than this checkout',
      answer: { status: 401, body: '{"error":"sign in to continue"}' },
      says: /older than this checkout/,
    },
    // The one refusal with a way forward, so it carries it.
    {
      situation: 'the account already holds data',
      answer: { status: 409, body: '{"error":"already holds data"}' },
      says: /--force to replace/,
    },
    {
      situation: 'a backup from a newer version',
      answer: { status: 400, body: '{"error":"taken from a newer version"}' },
      says: /newer version/,
    },
    {
      situation: 'nothing answered at all',
      answer: { status: 0, body: '' },
      says: /is the environment up/,
    },
    // Both routes answer 409 and they mean different things. A register that
    // disagrees about who somebody is has no force and no flag, and telling
    // somebody to re-run with --force is worse than unhelpful: accounts go in
    // first, so following it replaces their data past the guard that was
    // protecting it and then meets the identical refusal.
    {
      situation: 'the register disagrees about who somebody is',
      answer: { status: 409, body: '{"error":"the address is already in the register"}' },
      path: '/v1/operator/restore/register',
      says: /already in the register/,
      never: /--force/,
    },
    {
      situation: 'something nobody planned for',
      answer: { status: 500, body: 'gateway fell over' },
      says: /answered 500: gateway fell over/,
    },
  ]) {
    it(`says so when ${situation}`, () => {
      const said = readRefusal(answer, path ?? '/v1/operator/restore/accounts/tenant-a');
      assert.match(said, says);
      if (never) assert.doesNotMatch(said, never);
    });
  }

  it('offers --force on an account that already holds data, where it is the answer', () => {
    assert.match(
      readRefusal(
        { status: 409, body: '{"error":"already holds data"}' },
        '/v1/operator/restore/accounts/tenant-a',
      ),
      /--force to replace/,
    );
  });
});

describe('restoring says when an account is in but not yet up to date', () => {
  // The rows are committed by the time this can be reported, so it is a
  // success carrying a warning. Reporting it as a failure would send somebody
  // to re-run believing the account untouched, when it has been replaced.
  it('names the account and what is still pending', async () => {
    const ask = async (path) =>
      path === '/v1/operator/restore/register'
        ? { accountsCreated: 0, usersCreated: 0 }
        : { tablesWritten: 1, rowsWritten: 3, notUpToDate: 'change 0009 failed: no such column' };
    const said = [];

    const done = await putBack({
      ask,
      backup: backupOf({ accounts: ['tenant-a'] }),
      force: false,
      say: (line) => said.push(line),
    });

    assert.equal(done.accounts.length, 1);
    assert.ok(said.some((line) => /not yet brought up to date/.test(line)));
    assert.ok(said.some((line) => /no such column/.test(line)));
  });
});
