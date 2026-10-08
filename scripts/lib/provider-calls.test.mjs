//
// The provider rule ("Record every paid provider call through one gateway, and
// export the records as CSV", issue 902): nothing reaches a provider except
// through the gateway. The functions over a small declaration written here,
// then the same check over the real tree, which is the half that gates.
//

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkTree, readSources, strayCallsIn, strayCalls, withoutComments } from './provider-calls.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');

const rules = {
  scan: ['apps/api/src'],
  holders: ['apps/api/src/gateway/', 'apps/api/src/ai/index.ts'],
  sdks: ['@anthropic-ai/', 'openai'],
  addresses: ['api.openai.com'],
  bindings: ['AI'],
};

const elsewhere = 'apps/api/src/jobs/enrichment.ts';

describe('nothing reaches a provider except through the gateway', () => {
  it('fails a provider SDK imported outside the gateway, naming the file', () => {
    const [failure, ...rest] = strayCallsIn(elsewhere, "import Anthropic from '@anthropic-ai/sdk';", rules);
    assert.match(failure, /^apps\/api\/src\/jobs\/enrichment\.ts: imports the provider SDK @anthropic-ai\/sdk$/);
    assert.deepEqual(rest, []);
    assert.equal(strayCallsIn(elsewhere, "const { default: o } = await import('openai/index.js');", rules).length, 1);
    assert.equal(strayCallsIn(elsewhere, "const o = require('openai');", rules).length, 1);
  });

  it('fails the AI binding used outside the gateway, naming the file', () => {
    const [failure] = strayCallsIn(elsewhere, 'const out = await env.AI.run(model, input);', rules);
    assert.match(failure, /enrichment\.ts: uses the AI binding$/);
    assert.equal(strayCallsIn(elsewhere, "env['AI'].run(model, input);", rules).length, 1);
  });

  it("fails a provider's address outside the gateway, naming the file", () => {
    const [failure] = strayCallsIn(elsewhere, "await fetch('https://api.openai.com/v1/embeddings');", rules);
    assert.match(failure, /enrichment\.ts: names the provider address api\.openai\.com$/);
  });

  it('passes the gateway itself, and the files it lists as holding provider code', () => {
    const everything = "import Anthropic from '@anthropic-ai/sdk'; env.AI.run(m, i); fetch('https://api.openai.com/');";
    assert.deepEqual(strayCallsIn('apps/api/src/gateway/attempts.ts', everything, rules), []);
    assert.deepEqual(strayCallsIn('apps/api/src/ai/index.ts', everything, rules), []);
    assert.equal(strayCallsIn('apps/api/src/ai/note-texts.ts', everything, rules).length, 3);
  });

  it('leaves a sentence about a provider, a similar package and a similar word alone', () => {
    const text = [
      '// the Anthropic SDK, api.openai.com and env.AI are only named here',
      '/* import x from "openai"; */',
      "import { paid } from './openai-notes.js';",
      "import { said } from 'openai-compatible-thing';",
      'const AIRPORT = env.AIRPORT;',
    ].join('\n');
    assert.deepEqual(strayCallsIn(elsewhere, text, rules), []);
  });

  it('fails a holder that no longer exists, since nothing would be guarding it', () => {
    const failures = strayCalls([], rules, (path) => path.startsWith('apps/api/src/gateway'));
    assert.deepEqual(failures, ['scripts/provider-rules.json: holder apps/api/src/ai/index.ts does not exist, remove it']);
  });

  it('does not take a URL for a comment', () => {
    assert.match(withoutComments("fetch('https://api.openai.com/x'); // then"), /api\.openai\.com.*\); {0,2}$/);
  });
});

describe('the check over a tree', () => {
  /** @param {Record<string, string>} files */
  const treeOf = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-calls-'));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts/provider-rules.json'), JSON.stringify({ ...rules, holders: ['apps/api/src/gateway/'] }));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };

  it('fails a new provider call added beside the gateway, and passes once it goes through it', () => {
    const dir = treeOf({
      'apps/api/src/gateway/openai.ts': "import OpenAI from 'openai';",
      'apps/api/src/jobs/transcribe.ts': "import OpenAI from 'openai';",
      'apps/api/tests/unit/fake.test.ts': "import OpenAI from 'openai';",
    });
    try {
      assert.deepEqual(checkTree(dir), ['apps/api/src/jobs/transcribe.ts: imports the provider SDK openai']);
      writeFileSync(join(dir, 'apps/api/src/jobs/transcribe.ts'), "import { transcribe } from '../gateway/openai.js';");
      assert.deepEqual(checkTree(dir), []);
      assert.equal(readSources(dir, rules).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("today's tree", () => {
  it('has no provider reached from outside the gateway', () => {
    assert.deepEqual(checkTree(repo), []);
  });
});
