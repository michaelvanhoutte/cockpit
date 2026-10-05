//
// Unit tests for what `pnpm backup:export` decides, run by `node --test` from
// the Scripts step, like the rest of scripts/lib.
//
// Nothing here reaches an environment. What is worth asserting is the ordering
// - that nothing appears where the backup was asked for until all of it has
// been read - because a half-written backup looks exactly like a whole one, and
// the day that difference matters is the day somebody needs it.
//
// Where a backup lands is tested against a real temporary directory, because
// what a rename or a directory removal does to a folder already there is the
// platform's answer, not ours. An interruption is a disk with one step failing.
//

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  addressOf,
  datedName,
  prepareBackup,
  readArguments,
  readRefusal,
  takeBackup,
} from './backup.mjs';

/** A disk that records what happened to it and never touches a real one. */
function fakeFiles({ failOn } = {}) {
  const written = new Map();
  let settledTo = null;
  return {
    written,
    get settledTo() {
      return settledTo;
    },
    async stage(out) {
      return `${out}.partial`;
    },
    async write(path, contents) {
      if (failOn && path.includes(failOn)) throw new Error(`disk gave out writing ${path}`);
      written.set(path, contents);
    },
    async settle(staged, out) {
      settledTo = { staged, out };
    },
  };
}

const REGISTER = {
  tenants: [{ id: 'tenant-a' }, { id: 'tenant-b' }],
  users: [{ id: 'user-a', account_id: 'tenant-a' }],
  accounts: ['tenant-a', 'tenant-b'],
};

/** An environment answering with a register and an account file each. */
function answering({ register = REGISTER, failOn } = {}) {
  const asked = [];
  return {
    asked,
    ask: async (path) => {
      asked.push(path);
      if (failOn && path.includes(failOn)) throw new Error(`nothing answered for ${path}`);
      if (path === '/v1/operator/backup/register') return register;
      const account = decodeURIComponent(path.split('/').pop());
      return { account, changesApplied: ['0001-account-schema'], tables: { items: [{ id: 'i1' }] } };
    },
  };
}

const at = () => new Date('2026-09-06T09:00:00.000Z');

describe('a backup holds every account in the register, or just the one asked for by name', () => {
  it('walks every account the environment says it has', async () => {
    const env = answering();
    const files = fakeFiles();

    const { accounts } = await takeBackup({
      ask: env.ask,
      files,
      out: 'b',
      environment: 'staging',
      now: at,
    });

    assert.deepEqual(
      accounts.map((a) => a.account),
      ['tenant-a', 'tenant-b'],
    );
    assert.ok(files.written.has('b.partial/accounts/tenant-a.json'));
    assert.ok(files.written.has('b.partial/accounts/tenant-b.json'));
  });

  it('walks only the account asked for', async () => {
    const env = answering();
    const files = fakeFiles();

    await takeBackup({
      ask: env.ask,
      files,
      out: 'b',
      only: 'tenant-b',
      environment: 'staging',
      now: at,
    });

    assert.ok(!files.written.has('b.partial/accounts/tenant-a.json'));
    assert.ok(files.written.has('b.partial/accounts/tenant-b.json'));
  });

  // The list of accounts comes from the environment rather than from whoever
  // typed the command, so a name that is not there is caught before anything
  // is read - and the message says what is there instead.
  it('refuses a name the environment does not have, and says what it does', async () => {
    const env = answering();

    await assert.rejects(
      takeBackup({ ask: env.ask, files: fakeFiles(), out: 'b', only: 'nobody', environment: 'staging' }),
      /no account nobody.*tenant-a, tenant-b/s,
    );
  });
});

describe('a backup refuses what it cannot write down faithfully', () => {
  // An account's name is a register id with no constraint on its shape, and it
  // becomes a file name. Refused rather than mangled: rewriting it would give a
  // file no restore could match back to an account, and leaving it alone would
  // put the file outside the staging directory the whole guarantee rests on.
  //
  // The awkward characters are written as escapes rather than as themselves, so
  // that this file stays text - a raw one makes `grep` call the source binary
  // and skip it, which is the mangling CLAUDE.md records having cost two files.
  for (const { situation, account } of [
    { situation: 'a separator in it', account: 'a/b' },
    { situation: 'a walk upwards', account: '../escaped' },
    { situation: 'nothing but a walk upwards', account: '..' },
    { situation: 'a backslash in it', account: 'a\\b' },
    { situation: 'a space in it', account: 'a b' },
    { situation: 'a null byte in it', account: 'a\0b' },
    { situation: 'a newline in it', account: 'a\nb' },
    { situation: 'nothing in it at all', account: '' },
  ]) {
    it(`refuses an account with ${situation}, before anything is created`, async () => {
      const files = fakeFiles();
      const register = { ...REGISTER, accounts: [account] };

      await assert.rejects(
        takeBackup({ ask: answering({ register }).ask, files, out: 'b', environment: 'staging' }),
        /cannot be written to a file of its own/,
      );

      assert.equal(files.written.size, 0);
      assert.equal(files.settledTo, null);
    });
  }

  // A 200 is not on its own proof that an environment answered - an edge or a
  // proxy can answer with JSON of its own. Without this the first sign is a
  // TypeError from somewhere in the middle, which reads as a bug in this
  // command rather than as an environment answering oddly.
  it('refuses an answer that is not a backup, and says what it suspects', async () => {
    const ask = async (path) =>
      path === '/v1/operator/backup/register' ? REGISTER : { please: 'sign in' };

    await assert.rejects(
      takeBackup({ ask, files: fakeFiles(), out: 'b', environment: 'staging' }),
      /is not a backup - is something in front of this environment/,
    );
  });

  // The register is asked for first, so it is the likeliest of the two to meet
  // something answering in the environment's place - and it was the one call
  // with no guard on it. Both ways in are covered because they fail
  // differently: without `--user` the list is iterated, with it the list is
  // asked whether it holds a name.
  for (const { situation, only } of [
    { situation: 'backing up everything', only: undefined },
    { situation: 'backing up one account', only: 'tenant-a' },
  ]) {
    it(`refuses an answer that is not the register, ${situation}`, async () => {
      const ask = async () => ({ please: 'sign in' });

      await assert.rejects(
        takeBackup({ ask, files: fakeFiles(), out: 'b', only, environment: 'staging' }),
        /is not one - is something in front of this environment/,
      );
    });
  }
});

describe('a backup that did not finish is not left looking finished', () => {
  it('is settled into place only once every account has been read', async () => {
    const files = fakeFiles();

    await takeBackup({
      ask: answering().ask,
      files,
      out: 'b',
      environment: 'staging',
      now: at,
    });

    assert.deepEqual(files.settledTo, { staged: 'b.partial', out: 'b' });
  });

  // A loop rather than a table helper: node:test has no `it.each`, the same
  // reason health.test.mjs gives beside its own.
  for (const { situation, breaking } of [
    { situation: 'an account that never answers', breaking: { failOn: 'tenant-b' } },
    { situation: 'a disk that gives out', breaking: { diskFailOn: 'tenant-b' } },
  ]) {
    it(`leaves nothing settled after ${situation}`, async () => {
      const files = fakeFiles(
        breaking.diskFailOn ? { failOn: breaking.diskFailOn } : undefined,
      );
      const env = answering(breaking.failOn ? { failOn: breaking.failOn } : undefined);

      await assert.rejects(
        takeBackup({ ask: env.ask, files, out: 'b', environment: 'staging', now: at }),
      );

      assert.equal(files.settledTo, null);
      // What it did manage to write is somewhere else entirely, so the path
      // somebody asked for holds nothing at all.
      for (const path of files.written.keys()) {
        assert.ok(path.startsWith('b.partial/'), `${path} was written outside the staging area`);
      }
    });
  }

  it('writes the manifest last, so a directory holding one is a directory that finished', async () => {
    const files = fakeFiles();

    await takeBackup({
      ask: answering().ask,
      files,
      out: 'b',
      environment: 'staging',
      now: at,
    });

    assert.equal([...files.written.keys()].at(-1), 'b.partial/manifest.json');
  });
});

describe('a backup records the environment it was taken from and when', () => {
  it('names the environment, the moment, and what each account held', async () => {
    const files = fakeFiles();

    await takeBackup({
      ask: answering().ask,
      files,
      out: 'b',
      environment: 'production',
      now: at,
    });

    assert.deepEqual(files.written.get('b.partial/manifest.json'), {
      takenAt: '2026-09-06T09:00:00.000Z',
      environment: 'production',
      accounts: [
        { account: 'tenant-a', changesApplied: ['0001-account-schema'], rows: 1 },
        { account: 'tenant-b', changesApplied: ['0001-account-schema'], rows: 1 },
      ],
    });
  });

  // The register file holds the register's own rows. Which accounts the command
  // walked is its own working out, and belongs in the manifest instead.
  it('keeps the command’s own working out of the register file', async () => {
    const files = fakeFiles();

    await takeBackup({
      ask: answering().ask,
      files,
      out: 'b',
      environment: 'staging',
      now: at,
    });

    assert.deepEqual(Object.keys(files.written.get('b.partial/register.json')), [
      'tenants',
      'users',
    ]);
  });
});

describe('the command says which environment it is about to read', () => {
  for (const { situation, environment, options, address } of [
    {
      situation: 'production',
      environment: 'production',
      options: { subdomain: 'someone' },
      address: 'https://cockpit.someone.workers.dev',
    },
    {
      situation: 'staging',
      environment: 'staging',
      options: { subdomain: 'someone' },
      address: 'https://cockpit-staging.someone.workers.dev',
    },
    // No port is written down: a linked worktree gets its own pair derived
    // from its path, so the caller asks portsFor and passes what it got.
    {
      situation: 'the application running here',
      environment: 'local',
      options: { apiPort: 8791 },
      address: 'http://localhost:8791',
    },
  ]) {
    it(`reads ${situation} at its own address`, () => {
      assert.equal(addressOf(environment, options), address);
    });
  }

  for (const { situation, environment, options, complaint } of [
    {
      situation: 'an environment that does not exist',
      environment: 'wherever',
      options: { subdomain: 'someone' },
      complaint: /no environment wherever/,
    },
    {
      situation: 'a deployed environment with no subdomain to find it by',
      environment: 'production',
      options: {},
      complaint: /CLOUDFLARE_WORKERS_SUBDOMAIN/,
    },
    {
      situation: 'the local one with no port',
      environment: 'local',
      options: {},
      complaint: /port pnpm dev is on/,
    },
  ]) {
    it(`refuses ${situation}`, () => {
      assert.throws(() => addressOf(environment, options), complaint);
    });
  }
});

describe('the command refuses what it cannot act on, and says why', () => {
  for (const { situation, argv, complaint } of [
    { situation: 'no environment', argv: ['--out', 'b'], complaint: /--env/ },
    { situation: 'nowhere to write', argv: ['--env', 'staging'], complaint: /--out/ },
    {
      situation: 'a flag it does not have',
      argv: ['--env', 'staging', '--out', 'b', '--everything'],
      complaint: /there is no --everything/,
    },
    {
      situation: 'a flag with nothing after it',
      argv: ['--env', 'staging', '--out'],
      complaint: /--out was given nothing/,
    },
    // Otherwise this backs up an account called `--out`, having silently taken
    // the next flag as a value.
    {
      situation: 'a flag whose value is the next flag',
      argv: ['--user', '--out', 'b'],
      complaint: /--user was given nothing/,
    },
    // Said rather than taking the last quietly: the two deployed environments
    // differ in exactly the way that makes being surprised expensive.
    {
      situation: 'an environment given twice',
      argv: ['--env', 'staging', '--env', 'production', '--out', 'b'],
      complaint: /--env was given twice/,
    },
    // Checked here rather than left to whatever looks the name up first. Both
    // the token and the address are keyed by it, so a typo reaching either is
    // answered in terms of what that one wanted: `--env prod` once produced
    // "no token for prod", which sends somebody to add one for an environment
    // that does not exist.
    {
      situation: 'an environment that does not exist',
      argv: ['--env', 'prod', '--out', 'b'],
      complaint: /no environment prod - it is one of local, staging, production/,
    },
    {
      situation: '--force with --dated',
      argv: ['--env', 'staging', '--out', 'b', '--force', '--dated'],
      complaint: /a dated folder is new every run/,
    },
    // A switch takes no value, so a word after one is not quietly ignored.
    {
      situation: 'a word after --dated',
      argv: ['--env', 'staging', '--out', 'b', '--dated', 'x'],
      complaint: /there is no x/,
    },
  ]) {
    it(`refuses ${situation}`, () => {
      assert.throws(() => readArguments(argv), complaint);
    });
  }

  for (const { situation, argv, read } of [
    {
      situation: 'no flags',
      argv: ['--env', 'production', '--out', 'b', '--user', 'anna'],
      read: { environment: 'production', out: 'b', user: 'anna', dated: false, force: false },
    },
    {
      situation: '--dated',
      argv: ['--env', 'production', '--out', 'b', '--dated'],
      read: { environment: 'production', out: 'b', user: undefined, dated: true, force: false },
    },
    // A switch must not swallow the word after it.
    {
      situation: '--force followed by --out',
      argv: ['--env', 'production', '--force', '--out', 'x'],
      read: { environment: 'production', out: 'x', user: undefined, dated: false, force: true },
    },
  ]) {
    it(`reads what it was asked to do, with ${situation}`, () => {
      assert.deepEqual(readArguments(argv), read);
    });
  }
});

describe('a refusal says which of the things somebody typed was wrong', () => {
  for (const { situation, answer, says } of [
    {
      situation: 'the secret was not accepted',
      answer: { status: 401, body: '{"error":"not allowed"}' },
      says: /BACKUP_TOKEN/,
    },
    {
      // The other 401, and the reason the two are read apart: an environment
      // promoted before the operator routes moved answers the *sign-in* gate's
      // refusal, and calling that a rejected secret sends somebody to rotate
      // BACKUP_TOKEN when the fix is to promote.
      situation: 'the environment is older than this checkout',
      answer: { status: 401, body: '{"error":"sign in to continue"}' },
      says: /older than this checkout/,
    },
    {
      situation: 'no such account',
      answer: { status: 404, body: '{"error":"no account nobody"}' },
      says: /no account nobody/,
    },
    {
      situation: 'the store holds somebody else’s rows',
      answer: { status: 409, body: '{"error":"workspaces holds a row belonging to \\"other\\""}' },
      says: /workspaces holds a row/,
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

describe('a dated folder is named for the environment, the user, and the UTC moment the run started', () => {
  for (const { situation, user, startedAt, name } of [
    {
      situation: 'a whole environment',
      user: undefined,
      startedAt: new Date('2026-10-05T14:32:07.456Z'),
      name: 'production-2026-10-05T14-32-07Z',
    },
    {
      situation: 'one user',
      user: 'tenant-anna',
      startedAt: new Date('2026-10-05T14:32:07.456Z'),
      name: 'production-tenant-anna-2026-10-05T14-32-07Z',
    },
    {
      situation: 'a clock read two hours ahead of UTC',
      user: undefined,
      startedAt: new Date('2026-10-05T16:32:07+02:00'),
      name: 'production-2026-10-05T14-32-07Z',
    },
  ]) {
    it(`names ${situation}`, () => {
      assert.equal(datedName('production', user, startedAt), name);
    });
  }
});

// The rest run against a real temporary directory.
const scratches = [];
after(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-backup-test-'));
  scratches.push(dir);
  return dir;
}

const STARTED = new Date('2026-10-05T14:32:07.000Z');

/** What the command does: decide where, then take the backup there. */
async function backUpInto(out, { dated, force, ask = answering().ask, disk } = {}) {
  const place = await prepareBackup({
    out,
    dated,
    force,
    environment: 'production',
    startedAt: STARTED,
    disk,
  });
  const taken = await takeBackup({
    ask,
    files: place.files,
    out: place.target,
    environment: 'production',
    now: at,
  });
  return { ...taken, target: place.target };
}

/** An earlier backup, with an account the new one will not have. */
function earlierBackup(dir) {
  mkdirSync(join(dir, 'accounts'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), '{"takenAt":"earlier"}');
  writeFileSync(join(dir, 'register.json'), '{}');
  writeFileSync(join(dir, 'accounts', 'gone.json'), '{}');
  return dir;
}

const isTheEarlierBackup = (dir) =>
  readFileSync(join(dir, 'manifest.json'), 'utf8') === '{"takenAt":"earlier"}' &&
  existsSync(join(dir, 'accounts', 'gone.json'));

const isTheNewBackup = (dir) =>
  JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).takenAt === at().toISOString();

/** Every file and folder under `dir` and what each file holds, to tell untouched from touched. */
function contentsOf(dir) {
  const found = {};
  const walk = (here) => {
    for (const name of readdirSync(here)) {
      const path = join(here, name);
      const named = relative(dir, path).replaceAll('\\', '/');
      if (statSync(path).isDirectory()) {
        found[`${named}/`] = '';
        walk(path);
      } else found[named] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return found;
}

/** A disk with one step failing where `when` says, and every other step real. */
function failing(step, when = () => true) {
  return {
    ...fsp,
    [step]: async (...args) => {
      if (when(...args)) throw Object.assign(new Error(`${step} gave out`), { code: 'EBUSY' });
      return fsp[step](...args);
    },
  };
}

/** An environment that puts a file in `dir` while it is being read. */
function writingInto(dir) {
  const env = answering();
  return async (path) => {
    if (path.includes('tenant-b')) writeFileSync(join(dir, 'notes.txt'), 'mine');
    return env.ask(path);
  };
}

describe('a backup lands where it is asked for, and a folder already holding anything is refused unless a flag says otherwise', () => {
  it('writes into a folder that is not there yet', async () => {
    const out = join(scratch(), 'b');
    await backUpInto(out);
    assert.ok(isTheNewBackup(out));
  });

  it('writes into a folder that is there and empty', async () => {
    const out = scratch();
    await backUpInto(out);
    assert.ok(isTheNewBackup(out));
  });

  it('refuses a folder holding a file, naming --dated and --force, and leaves it alone', async () => {
    const out = scratch();
    writeFileSync(join(out, 'notes.txt'), 'mine');
    const env = answering();

    await assert.rejects(backUpInto(out, { ask: env.ask }), /--dated.*--force/s);

    assert.deepEqual(contentsOf(out), { 'notes.txt': 'mine' });
    assert.equal(env.asked.length, 0);
  });

  it('creates the folder --dated writes into, and puts the backup in a dated folder inside it', async () => {
    const out = join(scratch(), 'backups');
    const { target } = await backUpInto(out, { dated: true });
    assert.equal(target, join(out, 'production-2026-10-05T14-32-07Z'));
    assert.ok(isTheNewBackup(target));
  });

  it('leaves what else is in the folder --dated writes into alone', async () => {
    const out = scratch();
    writeFileSync(join(out, 'notes.txt'), 'mine');
    const { target } = await backUpInto(out, { dated: true });
    assert.ok(isTheNewBackup(target));
    assert.equal(readFileSync(join(out, 'notes.txt'), 'utf8'), 'mine');
  });

  it('refuses a dated folder taken in the same second as already there', async () => {
    const out = scratch();
    await backUpInto(out, { dated: true });
    await assert.rejects(backUpInto(out, { dated: true }), /already there - a dated backup was taken this same second/);
  });

  it('refuses an empty folder that something is put in during the run, and leaves that alone', async () => {
    const out = scratch();

    await assert.rejects(backUpInto(out, { ask: writingInto(out) }), /no longer empty/);

    assert.deepEqual(contentsOf(out), { 'notes.txt': 'mine' });
  });
});

describe('--force replaces an earlier backup and nothing else', () => {
  it('replaces an earlier backup, leaving nothing of it behind', async () => {
    const out = earlierBackup(join(scratch(), 'b'));

    const { warning } = await backUpInto(out, { force: true });

    assert.ok(isTheNewBackup(out));
    assert.ok(!existsSync(join(out, 'accounts', 'gone.json')));
    assert.ok(!existsSync(`${out}.replaced`));
    assert.ok(!existsSync(`${out}.partial`));
    assert.equal(warning, undefined);
  });

  for (const { situation, arrange } of [
    {
      situation: 'an earlier backup with one other file beside it',
      arrange: (out) => writeFileSync(join(earlierBackup(out), 'notes.txt'), 'mine'),
    },
    {
      situation: 'files but no manifest',
      arrange: (out) => {
        mkdirSync(out);
        writeFileSync(join(out, 'register.json'), '{}');
      },
    },
    {
      situation: 'an earlier backup whose accounts hold a file that is not one',
      arrange: (out) => writeFileSync(join(earlierBackup(out), 'accounts', 'notes.txt'), 'mine'),
    },
    {
      situation: 'an earlier backup whose accounts hold a folder',
      arrange: (out) => mkdirSync(join(earlierBackup(out), 'accounts', 'nested')),
    },
  ]) {
    it(`refuses ${situation} before anything is read, and leaves it alone`, async () => {
      const out = join(scratch(), 'b');
      arrange(out);
      const before = contentsOf(out);
      const env = answering();

      await assert.rejects(backUpInto(out, { force: true, ask: env.ask }), /not only an earlier backup/);

      assert.deepEqual(contentsOf(out), before);
      assert.equal(env.asked.length, 0);
    });
  }

  it('writes into a folder that is not there yet, as without it', async () => {
    const out = join(scratch(), 'b');
    await backUpInto(out, { force: true });
    assert.ok(isTheNewBackup(out));
  });

  it('refuses an earlier backup that a file is put beside during the run, and leaves both alone', async () => {
    const out = earlierBackup(join(scratch(), 'b'));

    await assert.rejects(backUpInto(out, { force: true, ask: writingInto(out) }), /not only an earlier backup/);

    assert.ok(isTheEarlierBackup(out));
    assert.equal(readFileSync(join(out, 'notes.txt'), 'utf8'), 'mine');
  });
});

describe('an interrupted replacement never loses the earlier backup', () => {
  it('leaves the earlier backup in place, and what was read beside it, when reading stops partway', async () => {
    const out = earlierBackup(join(scratch(), 'b'));

    await assert.rejects(backUpInto(out, { force: true, ask: answering({ failOn: 'tenant-b' }).ask }));

    assert.ok(isTheEarlierBackup(out));
    assert.ok(existsSync(`${out}.partial`));
  });

  it('leaves the earlier backup in place when it cannot be set aside', async () => {
    const out = earlierBackup(join(scratch(), 'b'));
    const disk = failing('rename', (_from, to) => to.endsWith('.replaced'));

    await assert.rejects(backUpInto(out, { force: true, disk }));

    assert.ok(isTheEarlierBackup(out));
    assert.ok(isTheNewBackup(`${out}.partial`));
  });

  it('keeps both whole when the new one cannot be moved into place, and says where each is', async () => {
    const out = earlierBackup(join(scratch(), 'b'));
    const disk = failing('rename', (from) => from.endsWith('.partial'));

    await assert.rejects(
      backUpInto(out, { force: true, disk }),
      (error) =>
        error.message.includes(`the earlier one is in ${out}.replaced`) &&
        error.message.includes(`the new one in ${out}.partial`),
    );

    assert.ok(isTheEarlierBackup(`${out}.replaced`));
    assert.ok(isTheNewBackup(`${out}.partial`));
  });

  it('finishes with a warning naming the earlier backup when it cannot be removed', async () => {
    const out = earlierBackup(join(scratch(), 'b'));

    const { warning } = await backUpInto(out, { force: true, disk: failing('rm') });

    assert.ok(isTheNewBackup(out));
    assert.ok(warning.includes(`remove ${out}.replaced`), warning);
  });

  for (const force of [false, true]) {
    const flag = force ? 'with --force' : 'without --force';

    it(`refuses a run that finds an earlier backup set aside, ${flag}, naming it and the new one`, async () => {
      const out = join(scratch(), 'b');
      earlierBackup(`${out}.replaced`);
      earlierBackup(`${out}.partial`);
      const env = answering();

      await assert.rejects(
        backUpInto(out, { force, ask: env.ask }),
        (error) =>
          error.message.includes(`${out}.replaced is already there: the earlier backup`) &&
          error.message.includes(`${out}.partial is the new one`),
      );
      assert.ok(isTheEarlierBackup(`${out}.replaced`));
      assert.equal(env.asked.length, 0);
    });

    it(`refuses a run that finds a backup that did not finish, ${flag}`, async () => {
      const out = earlierBackup(join(scratch(), 'b'));
      mkdirSync(`${out}.partial`);

      await assert.rejects(backUpInto(out, { force }), /\.partial is already there, left by a run that did not finish/);
      assert.ok(isTheEarlierBackup(out));
    });
  }
});
