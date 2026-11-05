import { describe, expect, it } from 'vitest';

import { layerCallFailures } from '../../src/layer-calls.js';
import { buildLogical } from '../../src/logical.js';
import { readDescription } from '../support/description.js';

const chip = (id, extra = {}) => ({ id, name: id, ...extra });

/** The API layer may call Business logic only; Data is a Register found by its marker. */
const design = (overrides = {}) => ({
  layers: [
    { id: 'api', title: 'API layer', row: 0, items: [[chip('http', { folders: ['apps/api/src/http'] }), chip('jobs', { folders: ['apps/api/src/jobs'] })]] },
    { id: 'logic', title: 'Business logic', row: 1, items: [[chip('accounts', { folders: ['apps/api/src/accounts'] })]] },
    { id: 'data', title: 'Data', row: 2, items: [[chip('register', { kind: 'store', folders: ['apps/api/src/db'], marker: '\\benv\\.DB\\b', how: 'SQL' })]] },
  ],
  mayCall: { api: ['logic'], logic: ['data'] },
  breaks: { 'api>data': 'The API layer reaches Data directly, past Business logic' },
  callers: [],
  noLine: [],
  rules: [{ rule: 'A layer calls only the layers its calls names', check: 'layer-calls' }],
  ...overrides,
});

const folder = (path, files = {}) => ({ path, package: false, packageName: null, role: 'core', files: Object.entries(files).map(([file, text]) => ({ file: `${path}/${file}`, text })) });

const failuresOf = (files, overrides) =>
  layerCallFailures(
    buildLogical({
      design: readDescription({ design: design(overrides) }).design,
      scan: { extensions: ['.ts'] },
      candidates: ['apps/api/src/http', 'apps/api/src/jobs', 'apps/api/src/accounts', 'apps/api/src/db'].map((path) => folder(path, files[path])),
    }),
  );

const SKIPS = "import { createDb } from '../db/client.js';";
const accepting = (files) => ({ accepted: [{ from: 'http', to: 'register', files, question: 'Should this move behind Business logic?' }] });

describe('the layer-calls check fails on every call the Logical page draws red', () => {
  it('fails an API file that reaches Data directly, naming the file, the line and the rule it breaks', () => {
    expect(failuresOf({ 'apps/api/src/http': { 'route.ts': `// a comment\n${SKIPS}` } })).toEqual([
      'apps/api/src/http/route.ts:2 calls register from http: The API layer reaches Data directly, past Business logic',
    ]);
  });

  it('passes a call the layers allow', () => {
    expect(failuresOf({ 'apps/api/src/http': { 'route.ts': "import { run } from '../accounts/store.js';" } })).toEqual([]);
  });

  it('passes a call an accepted entry covers for every file making it, whether it carries a reason or a question', () => {
    expect(failuresOf({ 'apps/api/src/http': { 'route.ts': SKIPS } }, accepting(['apps/api/src/http/route.ts']))).toEqual([]);
  });

  it('fails a known call spreading to a file its accepted entry does not name, naming only the new file', () => {
    const failures = failuresOf({ 'apps/api/src/http': { 'route.ts': SKIPS, 'other.ts': SKIPS } }, accepting(['apps/api/src/http/route.ts']));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^apps\/api\/src\/http\/other\.ts:1 calls register from http: .*names only apps\/api\/src\/http\/route\.ts, and may not grow$/);
  });

  it('fails an accepted entry naming a file that no longer makes its call, so the list shrinks as the code is fixed', () => {
    expect(failuresOf({ 'apps/api/src/http': { 'route.ts': SKIPS } }, accepting(['apps/api/src/http/route.ts', 'apps/api/src/http/fixed.ts']))).toEqual([
      'accepted entry http -> register: apps/api/src/http/fixed.ts no longer makes this call, remove it from the entry (or the entry, if it names no other file)',
    ]);
  });

  it('fails when no rule in the file has check: layer-calls, so removing the rule cannot switch the check off', () => {
    expect(failuresOf({}, { rules: [] })).toEqual(['docs/architecture.yml: no rule has check: layer-calls']);
  });
});

