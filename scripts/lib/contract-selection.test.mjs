//
// Which suites a contract run picks up ("Check each Claude prompt with one call
// in CI, and run its behaviour suite by hand", issue 1476): the real files of
// apps/api/tests/contract/ and the real workflow, since the decision is made
// before any suite calls anything and a run that picked the wrong files would
// show only as spend.
//

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BEHAVIOUR_SUITE,
  claudeSuitesRunBare,
  contractFiles,
  filesRun,
  ONE_CALL_CHECKS,
  promptsWithoutACheck,
  suitesNamed,
} from './contract-selection.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');
const contract = join(repo, 'apps/api/tests/contract');

const files = readdirSync(contract, { recursive: true, encoding: 'utf8' })
  .map((file) => file.split('\\').join('/'))
  .filter((file) => file.endsWith('.test.ts'));
const behaviour = files.filter((file) => BEHAVIOUR_SUITE.test(file));
const free = ['read-what-a-note-means.test.ts', 'transcribe-a-recording.test.ts'];
const prompts = readdirSync(join(repo, 'apps/api/src/ai/prompts'))
  .filter((file) => file.endsWith('.ts'))
  .map((file) => file.replace(/\.ts$/, ''));

/** What `pnpm --filter @cockpit/api test:contract <names>` hands Vitest. */
const commandLine = (...names) => ['node', 'vitest.mjs', 'run', '--config', 'vitest.contract.config.ts', ...names];

/** The workflow's step that runs the API's contract tier, and the Claude key it is given. */
function apiStep() {
  const workflow = readFileSync(join(repo, '.github/workflows/contract.yml'), 'utf8');
  const lines = workflow.split(/\r?\n/);
  const at = lines.findIndex((line) => /^\s*- run: pnpm --filter @cockpit\/api test:contract\b/.test(line));
  assert.notEqual(at, -1, 'contract.yml has no step running @cockpit/api test:contract');
  const run = lines[at].replace(/^.*test:contract/, '').trim();
  const key = lines.slice(at + 1).find((line) => /^\s*ANTHROPIC_API_KEY:/.test(line));
  return { run, key: key?.replace(/^\s*ANTHROPIC_API_KEY:\s*/, '') };
}

describe('Contract runs', () => {
  describe('a contract run that names no suite runs one call per Claude prompt and the free suites, and no behaviour case', () => {
    it('a run naming nothing, in CI on a pull request or by hand, takes every one-call check and free suite and no behaviour suite', () => {
      const run = filesRun(files, suitesNamed(commandLine()));
      assert.deepEqual([...run].sort(), [ONE_CALL_CHECKS, ...free].sort());
      assert.ok(behaviour.length > 0, 'the behaviour suites were not found by name, so none could be left out');
      for (const suite of behaviour) assert.ok(!run.includes(suite), `a bare run picked up ${suite}`);
    });

    it("the weekly run's selection is the same set, with the Claude key present", () => {
      const { run, key } = apiStep();
      assert.deepEqual(suitesNamed(['node', 'vitest.mjs', 'run', ...run.split(/\s+/).filter(Boolean)]), [], `the workflow names a suite: ${run}`);
      assert.equal(key, '${{ secrets.ANTHROPIC_API_KEY }}', 'the weekly run does not carry the Claude key on every trigger');
      assert.deepEqual(filesRun(files, []), filesRun(files, suitesNamed(commandLine())));
    });

    it('a run naming one behaviour suite takes that suite only', () => {
      for (const name of ['clean-up-a-note', 'choose-a-panel', 'propose-for-claude', 'remember-a-sentence', 'resolve-a-place']) {
        const named = suitesNamed(commandLine(name));
        assert.deepEqual(named, [name]);
        assert.deepEqual(
          filesRun(files, named),
          behaviour.filter((suite) => suite.startsWith(`${name}.`)),
        );
        assert.equal(filesRun(files, named).length, 1);
      }
    });

    it('a run naming a free suite takes that suite, and a flag value is not a name', () => {
      assert.deepEqual(filesRun(files, suitesNamed(commandLine('read-what-a-note-means'))), ['read-what-a-note-means.test.ts']);
      assert.deepEqual(suitesNamed(['node', 'vitest.mjs', 'run', '--config', 'x.ts', '-t', 'a case', '--reporter=verbose']), []);
      assert.deepEqual(contractFiles(['a.v1.test.ts', 'b.test.ts'], []), ['b.test.ts']);
    });

    it('a stray value read as a name selects no behaviour suite', () => {
      // `--bail 1`: a flag this module does not know takes its value as a name.
      const named = suitesNamed(commandLine('--bail', '1'));
      assert.deepEqual(named, ['1']);
      for (const suite of behaviour) assert.ok(!filesRun(files, named).includes(suite), `--bail 1 picked up ${suite}`);
    });

    it('a suite in a folder of its own is selected as one beside the others is', () => {
      assert.deepEqual(contractFiles(['area/a.v1.test.ts', 'area/b.test.ts'], []), ['area/b.test.ts']);
      assert.deepEqual(filesRun(['area/a.v1.test.ts', 'b.test.ts'], ['a']), ['area/a.v1.test.ts']);
    });

    it('a Claude prompt with no one-call check fails, naming the prompt', () => {
      assert.deepEqual(promptsWithoutACheck(['one-more.v2', 'resolve-a-place.v1'], "it('resolve-a-place.v1 answers')"), ['one-more.v2']);
      assert.deepEqual(promptsWithoutACheck(['resolve-a-place.v1'], "it('resolve-a-place.v12 answers')"), ['resolve-a-place.v1']);
      assert.deepEqual(promptsWithoutACheck(['resolve-a-place.v1'], '// see resolve-a-place.v1.test.ts'), ['resolve-a-place.v1']);

      const check = readFileSync(join(contract, ONE_CALL_CHECKS), 'utf8');
      assert.ok(prompts.length >= 5, 'the prompts were not found');
      const unchecked = promptsWithoutACheck(prompts, check);
      assert.deepEqual(unchecked, [], `no one-call check in apps/api/tests/contract/${ONE_CALL_CHECKS} for the prompt ${unchecked.join(', ')}`);
    });

    it('a suite that asks Claude without a versioned name would run on a bare run, and fails', () => {
      assert.deepEqual(claudeSuitesRunBare({ 'one-call.test.ts': 'ClaudeAiService', 'a.v3.test.ts': 'ClaudeAiService', 'b.test.ts': 'ClaudeAiService', 'c.test.ts': 'fetch' }), ['b.test.ts']);

      const sources = Object.fromEntries(files.map((file) => [file, readFileSync(join(contract, file), 'utf8')]));
      assert.deepEqual(claudeSuitesRunBare(sources), []);
    });
  });
});
