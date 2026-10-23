import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkoutBranch, productionOrigin, recordingVars } from './local-recording.mjs';

const WRANGLER = `{
  "vars": {
    "APP_ORIGIN": "https://cockpit.example.workers.dev"
  },
  "env": { "staging": { "vars": { "APP_ORIGIN": "https://cockpit-staging.example.workers.dev" } } }
}`;

describe('AI usage', () => {
  describe('a local Worker is handed the branch it was started on and where to record its Claude calls', () => {
    it('names production as the place, never staging', () => {
      assert.equal(productionOrigin(WRANGLER), 'https://cockpit.example.workers.dev');
    });

    it('refuses to start with no production address to record to', () => {
      assert.throws(() => productionOrigin('{}'), /APP_ORIGIN/);
    });

    it('hands over the branch, or the commit a checkout is detached at, or nothing', () => {
      const answers = (...replies) => {
        const given = [...replies];
        return () => {
          const next = given.shift();
          if (next instanceof Error) throw next;
          return next;
        };
      };
      assert.equal(checkoutBranch('.', answers('claude/1458-send-usage\n')), 'claude/1458-send-usage');
      assert.equal(checkoutBranch('.', answers('HEAD\n', 'a1b2c3d\n')), 'a1b2c3d');
      assert.equal(checkoutBranch('.', answers(new Error('not a repository'))), null);
    });

    it('points at production unless the shell says otherwise', () => {
      const origin = 'https://cockpit.example.workers.dev';
      assert.deepEqual(recordingVars({ branch: 'main', origin, environment: {} }), [
        'CHECKOUT_BRANCH:main',
        `USAGE_RECORDING_URL:${origin}`,
      ]);
      assert.deepEqual(
        recordingVars({ branch: null, origin, environment: { USAGE_RECORDING_URL: 'http://localhost:8787' } }),
        ['USAGE_RECORDING_URL:http://localhost:8787'],
      );
    });
  });
});
