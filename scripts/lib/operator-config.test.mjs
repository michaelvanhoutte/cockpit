//
// Unit tests for where the backup commands get a token from, run by
// `node --test` from the Scripts CI job, like the rest of scripts/lib.
//
// Nothing here touches the disk: `readConfig` takes its reader, so the cases
// that matter - no file, a file that is not JSON, a file missing the
// environment asked for - are arranged rather than staged.
//
// What is worth asserting is that naming the environment is the whole of what
// an operator does. There are three environments and one COCKPIT_BACKUP_TOKEN,
// so the variable can only ever be right for one of them at a time; the file
// is what makes `--env production` and `--env staging` both work without
// anything being set between them.
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CONFIG_FILE, readConfig, resolveSubdomain, resolveToken } from './operator-config.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const CONFIG = {
  subdomain: 'someone',
  tokens: { local: 'local-token', staging: 'staging-token', production: 'production-token' },
};

/** A reader standing in for the filesystem. */
function holding(contents) {
  return () => {
    if (contents === undefined) {
      const missing = new Error('no such file');
      missing.code = 'ENOENT';
      throw missing;
    }
    return contents;
  };
}

describe('naming the environment is the whole of what an operator does', () => {
  // The point of the file: one command per environment, nothing set between
  // them, and no chance of last run's token being used for this one.
  it('gives each environment its own token from one file', () => {
    const config = readConfig('/repo', { read: holding(JSON.stringify(CONFIG)) });

    assert.equal(resolveToken('local', { config }), 'local-token');
    assert.equal(resolveToken('staging', { config }), 'staging-token');
    assert.equal(resolveToken('production', { config }), 'production-token');
  });

  it('finds the subdomain a deployed address is built from', () => {
    const config = readConfig('/repo', { read: holding(JSON.stringify(CONFIG)) });

    assert.equal(resolveSubdomain({ config }), 'someone');
  });
});

describe('the environment variable wins where it is set', () => {
  // Which is what CI wants: one environment, one token, nothing on disk.
  it('takes the variable over the file', () => {
    const config = readConfig('/repo', { read: holding(JSON.stringify(CONFIG)) });

    assert.equal(
      resolveToken('production', { config, env: { COCKPIT_BACKUP_TOKEN: 'from-the-variable' } }),
      'from-the-variable',
    );
  });

  it('carries the whole run on its own where there is no file', () => {
    const config = readConfig('/repo', { read: holding(undefined) });

    assert.equal(config, null);
    assert.equal(
      resolveToken('production', { config, env: { COCKPIT_BACKUP_TOKEN: 'from-the-variable' } }),
      'from-the-variable',
    );
    assert.equal(
      resolveSubdomain({ config, env: { CLOUDFLARE_WORKERS_SUBDOMAIN: 'someone' } }),
      'someone',
    );
  });

  // An empty variable is not a value somebody meant to set, and treating it as
  // one would send a blank token at an environment and report the refusal as
  // though the file were wrong.
  it('falls through an empty variable to the file', () => {
    const config = readConfig('/repo', { read: holding(JSON.stringify(CONFIG)) });

    assert.equal(
      resolveToken('production', { config, env: { COCKPIT_BACKUP_TOKEN: '' } }),
      'production-token',
    );
  });
});

describe('the example fails closed on every field somebody has to fill in', () => {
  /**
   * The one test here that reads the real file, because the property is about
   * the artefact that ships rather than about the code: a placeholder that is
   * truthy is *accepted*, so an operator who fills in the tokens and forgets
   * the subdomain would have sent a real bearer token to whoever had
   * registered that name on workers.dev. Empty refuses instead.
   */
  const example = JSON.parse(readFileSync(resolve(REPO_ROOT, 'backup-tokens.example.json'), 'utf8'));

  it('ships the subdomain empty rather than as a placeholder', () => {
    assert.equal(example.subdomain, '');
  });

  for (const environment of ['staging', 'production']) {
    it(`ships ${environment} with no token, so forgetting one refuses`, () => {
      assert.equal(example.tokens[environment], '');
      assert.throws(() => resolveToken(environment, { config: example }), /has no token/);
    });
  }

  // Local is the exception and is meant to be: it ships the value
  // apps/api/.dev.vars.example ships, so copying both gives a working local
  // backup rather than a refusal to debug.
  it('ships local ready to use, matching the Worker’s own example', () => {
    assert.equal(example.tokens.local, 'local-operator-secret');
  });
});

describe('a token that cannot be found says which way to fix it', () => {
  // The two failures are different: somebody in CI has no file to fix, and
  // somebody at a keyboard has no variable they meant to set.
  it('names the file to copy when there is none', () => {
    const config = readConfig('/repo', { read: holding(undefined) });

    assert.throws(() => resolveToken('production', { config }), (error) => {
      assert.match(error.message, /backup-tokens\.example\.json/);
      assert.match(error.message, new RegExp(CONFIG_FILE.replace('.', '\\.')));
      assert.match(error.message, /COCKPIT_BACKUP_TOKEN/);
      return true;
    });
  });

  it('says which environment is missing when the file is there', () => {
    const config = readConfig('/repo', {
      read: holding(JSON.stringify({ tokens: { local: 'local-token' } })),
    });

    assert.throws(() => resolveToken('production', { config }), /has no token for production/);
  });

  it('says an empty token is no token', () => {
    const config = readConfig('/repo', {
      read: holding(JSON.stringify({ tokens: { production: '' } })),
    });

    assert.throws(() => resolveToken('production', { config }), /has no token for production/);
  });

  // A half-written file is likelier than a missing one, since somebody edits
  // this by hand - and "unexpected token" from deep in a command says nothing
  // about which file to look at.
  it('names the file when it is not JSON', () => {
    assert.throws(
      () => readConfig('/repo', { read: holding('{ not json') }),
      new RegExp(`${CONFIG_FILE.replace('.', '\\.')} is not readable as JSON`),
    );
  });
});
