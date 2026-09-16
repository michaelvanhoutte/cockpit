//
// Unit tests for what `pnpm duplicates:backfill` decides, run by `node --test`
// from the Scripts step, like the rest of scripts/lib. What a run does to an
// account's rows is apps/api/tests/integration/http/duplicates-backfill.test.ts's.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ACCOUNTS_PATH, backfill, oneBatch, readArguments, readRefusal } from './duplicates-backfill.mjs';
import { needsSayingOutLoud } from './operator.mjs';

/**
 * An environment holding the accounts named, each with the batches it would
 * answer in turn - so a case says what the walk meets rather than how it asks.
 *
 * `breaks` names the account whose Nth batch stops answering, counting from 1.
 */
function environmentWith({ accounts, batches = {}, breaks = {} }) {
  const asked = [];
  const asksPer = {};
  const left = Object.fromEntries(Object.entries(batches).map(([name, all]) => [name, [...all]]));
  return {
    asked,
    async ask(path) {
      asked.push(path);
      if (path === ACCOUNTS_PATH) return { accounts };
      const account = decodeURIComponent(path.slice(`${ACCOUNTS_PATH}/`.length).split('?')[0]);
      asksPer[account] = (asksPer[account] ?? 0) + 1;
      if (breaks[account] === asksPer[account]) throw new Error(`nothing answered for ${account}`);
      const next = left[account]?.shift();
      return next ?? { read: [], couldNotBeRead: [], lastLooked: null, more: false };
    },
  };
}

/** A batch answer, in the shape the route gives one. */
function batch({ read = [], couldNotBeRead = [], more = false, lastLooked = null }) {
  return { read, couldNotBeRead, lastLooked, more };
}

describe('the backfill names its environment every time, and is told how much to read', () => {
  for (const { situation, argv, complaint } of [
    { situation: 'no environment', argv: [], complaint: /--env says which environment/ },
    { situation: 'an environment that does not exist', argv: ['--env', 'prod'], complaint: /no environment prod/ },
    {
      situation: 'a flag it does not have',
      argv: ['--env', 'local', '--everything'],
      complaint: /there is no --everything/,
    },
    {
      situation: 'a batch that is not a number',
      argv: ['--env', 'local', '--batch', 'lots'],
      complaint: /--batch takes a whole number/,
    },
    {
      situation: 'a batch of none',
      argv: ['--env', 'local', '--batch', '0'],
      complaint: /--batch takes a whole number/,
    },
    {
      situation: 'a batch larger than the route would ever answer',
      argv: ['--env', 'local', '--batch', '101'],
      complaint: /--batch takes at most 100 items/,
    },
    {
      situation: 'a stopping point that is not a number',
      argv: ['--env', 'local', '--stop-after', 'a-few'],
      complaint: /--stop-after takes a whole number/,
    },
  ]) {
    it(`refuses ${situation}`, () => {
      assert.throws(() => readArguments(argv), complaint);
    });
  }

  it('takes an environment, one account, a batch and a stopping point', () => {
    assert.deepEqual(
      readArguments(['--env', 'production', '--user', 'tenant-anna', '--batch', '50', '--stop-after', '500']),
      { environment: 'production', user: 'tenant-anna', batch: 50, stopAfter: 500 },
    );
  });

  it('reads everything, in whatever batch the environment prefers, where it was told neither', () => {
    assert.deepEqual(readArguments(['--env', 'local']), {
      environment: 'local',
      user: undefined,
      batch: undefined,
      stopAfter: undefined,
    });
  });
});

describe('reading the notes in a deployed environment is said out loud first', () => {
  // It spends a call to the model per note in an environment holding real data,
  // so the same prompt a restore asks guards it.
  for (const { environment, saidOutLoud } of [
    { environment: 'production', saidOutLoud: true },
    { environment: 'staging', saidOutLoud: true },
    { environment: 'local', saidOutLoud: false },
  ]) {
    it(`${saidOutLoud ? 'asks before reading' : 'reads'} in ${environment}`, () => {
      assert.equal(needsSayingOutLoud(environment), saidOutLoud);
    });
  }
});

describe('a run walks every account to the end, from the environment’s own list', () => {
  it('carries on from where the last batch stopped, until there is no more', async () => {
    const environment = environmentWith({
      accounts: ['tenant-a'],
      batches: {
        'tenant-a': [
          batch({ read: ['one', 'two'], more: true, lastLooked: 'two' }),
          batch({ read: ['three'], more: false, lastLooked: 'three' }),
        ],
      },
    });

    const done = await backfill({ ask: environment.ask });

    assert.deepEqual(done.accounts, [
      { account: 'tenant-a', read: 3, couldNotBeRead: [], finished: true },
    ]);
    assert.equal(done.read, 3);
    assert.deepEqual(environment.asked, [
      ACCOUNTS_PATH,
      `${ACCOUNTS_PATH}/tenant-a`,
      `${ACCOUNTS_PATH}/tenant-a?after=two`,
    ]);
  });

  it('reads one account where it was given one, and refuses a name the environment has not got', async () => {
    const environment = environmentWith({ accounts: ['tenant-a', 'tenant-b'] });

    const done = await backfill({ ask: environment.ask, only: 'tenant-b' });
    assert.deepEqual(
      done.accounts.map((one) => one.account),
      ['tenant-b'],
    );

    await assert.rejects(
      backfill({ ask: environment.ask, only: 'tenant-c' }),
      /no account tenant-c in this environment - it holds tenant-a, tenant-b/,
    );
  });

  it('counts the notes with nothing written on them and names them, rather than passing over them', async () => {
    const environment = environmentWith({
      accounts: ['tenant-a'],
      batches: { 'tenant-a': [batch({ read: ['one'], couldNotBeRead: ['blank-1', 'blank-2'] })] },
    });

    const said = [];
    const done = await backfill({ ask: environment.ask, say: (line) => said.push(line) });

    assert.deepEqual(done.accounts[0].couldNotBeRead, ['blank-1', 'blank-2']);
    assert.match(said[0], /tenant-a: 1 read, 2 with nothing written on them \(blank-1, blank-2\)/);
  });
});

describe('a run that stops says how far it got', () => {
  it('names the accounts that went in, and how many notes each one read', async () => {
    const environment = environmentWith({
      accounts: ['tenant-a', 'tenant-b', 'tenant-c'],
      batches: { 'tenant-a': [batch({ read: ['one', 'two'] })] },
      // The first call for tenant-b, which is the second account of three.
      breaks: { 'tenant-b': 1 },
    });

    await assert.rejects(backfill({ ask: environment.ask }), (error) => {
      assert.match(error.message, /nothing answered for tenant-b/);
      assert.match(error.message, /Stopped there\. Read so far: tenant-a \(2\)\./);
      // The account it never reached is not reported as having gone in.
      assert.doesNotMatch(error.message, /tenant-c/);
      return true;
    });
  });

  it('says nothing was read where it stopped on the first account', async () => {
    const environment = environmentWith({ accounts: ['tenant-a'], breaks: { 'tenant-a': 1 } });

    await assert.rejects(backfill({ ask: environment.ask }), /Stopped there\. Nothing was read\./);
  });

  it('refuses an answer that is not a batch, rather than reporting a walk that finished', async () => {
    const environment = environmentWith({
      accounts: ['tenant-a'],
      batches: { 'tenant-a': [{ hello: 'from the edge' }] },
    });

    await assert.rejects(
      backfill({ ask: environment.ask }),
      /reading tenant-a got an answer that is not a batch/,
    );
  });

  it('refuses an answer that says there is more with nothing to carry on from, rather than asking for the same batch for ever', async () => {
    const environment = environmentWith({
      accounts: ['tenant-a'],
      batches: { 'tenant-a': [batch({ read: ['one'], more: true, lastLooked: null })] },
    });

    await assert.rejects(
      backfill({ ask: environment.ask }),
      /reading tenant-a got an answer that says there is more with nothing to carry on from/,
    );
  });
});

describe('naming one account is refused rather than quietly reading every account', () => {
  it('refuses an empty --user rather than reading every account in the environment', async () => {
    const environment = environmentWith({ accounts: ['tenant-a', 'tenant-b'] });

    await assert.rejects(
      backfill({ ask: environment.ask, only: '' }),
      /no account  in this environment/,
    );
    // Nothing beyond the account list was asked - an empty name never reads
    // every account the way an absent one does.
    assert.deepEqual(environment.asked, [ACCOUNTS_PATH]);
  });
});

describe('a run stops where it was told to, and says what is left', () => {
  it('stops on the note it was told to rather than at the end of a batch', async () => {
    const environment = environmentWith({
      accounts: ['tenant-a', 'tenant-b'],
      batches: {
        'tenant-a': [
          batch({ read: ['one', 'two'], more: true, lastLooked: 'two' }),
          batch({ read: ['three'], more: true, lastLooked: 'three' }),
        ],
      },
    });

    const done = await backfill({ ask: environment.ask, batch: 2, stopAfter: 3 });

    assert.equal(done.read, 3);
    assert.equal(done.accounts[0].finished, false);
    // The second batch is asked for one note, not two: the cap is what is left,
    // not the batch it happens to fall inside.
    assert.deepEqual(environment.asked, [
      ACCOUNTS_PATH,
      `${ACCOUNTS_PATH}/tenant-a?batch=2`,
      `${ACCOUNTS_PATH}/tenant-a?after=two&batch=1`,
    ]);
    // And the account it never got to is never asked about at all, rather
    // than recorded as though it had been reached and read nothing.
    assert.equal(done.accounts.length, 1);
  });

  it('asks for at most the route\'s own largest batch, where `--stop-after` alone would ask for more', async () => {
    const environment = environmentWith({
      accounts: ['tenant-a'],
      batches: { 'tenant-a': [batch({ read: Array.from({ length: 100 }, (_, at) => `item-${at}`) })] },
    });

    await backfill({ ask: environment.ask, stopAfter: 500 });

    assert.deepEqual(environment.asked, [ACCOUNTS_PATH, `${ACCOUNTS_PATH}/tenant-a?batch=100`]);
  });
});

describe('a batch is asked for by account, cursor and size', () => {
  for (const { situation, given, path } of [
    { situation: 'the first batch', given: ['tenant-a', null, undefined], path: `${ACCOUNTS_PATH}/tenant-a` },
    {
      situation: 'carrying on from a note',
      given: ['tenant-a', 'item-9', undefined],
      path: `${ACCOUNTS_PATH}/tenant-a?after=item-9`,
    },
    {
      situation: 'an account whose name needs escaping',
      given: ['tenant a/b', null, 10],
      path: `${ACCOUNTS_PATH}/tenant%20a%2Fb?batch=10`,
    },
  ]) {
    it(`asks ${situation}`, () => {
      assert.equal(oneBatch(...given), path);
    });
  }
});

describe('a refusal says what to do about it', () => {
  it('says the environment has nothing to read meaning with, and that nothing was read', () => {
    assert.match(
      readRefusal({ status: 409, body: JSON.stringify({ error: 'this environment cannot read what a note means' }) }),
      /refused: this environment cannot read what a note means\. Nothing was read\..*Workers AI binding/s,
    );
  });

  it('says which name was wrong', () => {
    assert.match(
      readRefusal({ status: 404, body: JSON.stringify({ error: 'no account tenant-z' }) }),
      /refused: no account tenant-z/,
    );
  });
});
