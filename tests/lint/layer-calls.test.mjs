//
// The layer-calls check over the real tree: no call between layers that docs/architecture.yml does not allow, except
// the accepted calls for the files they name. This is the half that gates; the check itself is the architecture
// report's own (tools/architecture/src/layer-calls.js), tested there, so the report and CI cannot disagree about what is
// a red line. Whether the accepted list grew against the merge base is import-rules.test.mjs's "today's tree".
//
// Here rather than in `scripts/lib`, whose CI job is checkout-only and could not import the report's YAML reader.
//

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { layerCallsOf } from '../../tools/architecture/src/layer-calls.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe("today's tree", () => {
  it('makes no call between layers that the rules file does not allow or accept for that file', () => {
    assert.deepEqual(layerCallsOf(repo), []);
  });
});
