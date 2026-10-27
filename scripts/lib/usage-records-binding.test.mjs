//
// Unit test over apps/api/wrangler.jsonc: staging sends its usage records to
// production through a service binding to production's Worker ("Send
// staging's usage records to production through a service binding, since its
// workers.dev address refuses them", issue 1618). The platform's refusal
// exists only on Cloudflare's network, so what a test can hold is the
// configuration that avoids it.
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { withoutComments } from './teams-package.mjs';

const wrangler = JSON.parse(withoutComments(readFileSync(new URL('../../apps/api/wrangler.jsonc', import.meta.url), 'utf8')));

describe('AI usage', () => {
  describe("staging's configuration binds production's Worker, and production's binds none", () => {
    it("names production's Worker as a service binding in staging's block", () => {
      assert.ok(wrangler.name && wrangler.name !== wrangler.env.staging.name, "production's Worker has a name of its own");
      const bound = (wrangler.env.staging.services ?? []).filter((service) => service.service === wrangler.name);
      assert.equal(bound.length, 1, "staging's block holds exactly one service binding to production's Worker");
      assert.equal(bound[0].binding, 'PRODUCTION');
    });

    it('has no service binding in production’s block, which writes its own records', () => {
      assert.equal(wrangler.services, undefined);
    });
  });
});
