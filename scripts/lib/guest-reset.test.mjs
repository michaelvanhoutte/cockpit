//
// Unit tests for what `pnpm guest:reset` decides, run by `node --test` from the
// Scripts CI job, like the rest of scripts/lib. What the reset does to an
// account is apps/api/tests/integration/accounts/guest-reset.test.ts's.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readArguments } from './guest-reset.mjs';

describe('resetting the guest account names its environment every time', () => {
  it('refuses to guess an environment it was not given', () => {
    assert.throws(() => readArguments([]), /--env says which environment/);
  });

  it('refuses an environment that does not exist', () => {
    assert.throws(() => readArguments(['--env', 'prod']), /no environment prod/);
  });

  it('takes the one it was given', () => {
    assert.deepEqual(readArguments(['--env', 'production']), { environment: 'production' });
  });
});
