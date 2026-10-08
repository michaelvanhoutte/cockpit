/**
 * What changed, end to end: a fixture git repository with real commits, the CLI
 * over it, and the previous report's model from a file or a local server. Each
 * case reads the page's What changed section, which is what a reader sees.
 */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/cli.js';
import { descriptionFile } from '../support/description.js';

const WORKFLOW = 'name: Tests\non:\n  pull_request:\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n';
const CONFIG = '{ "name": "w", "kv_namespaces": [{ "binding": "CACHE", "id": "abc" }] }\n';
const DESCRIPTION = descriptionFile({ layers: [{ title: 'API', note: '', role: 'core', areas: [{ path: 'apps/api/src/http', description: 'The routes' }] }] }).text;

const dirs = [];
const servers = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'architecture-changes-'));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  vi.stubEnv('GITHUB_SHA', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (root, ...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();

/** A repository whose history is `commits`, each a map of files to write (a null removes one); returns the root and each commit's id. */
function repository(commits) {
  const root = tmp();
  git(root, 'init', '-q', '-b', 'main');
  const ids = commits.map((files, index) => {
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(root, name);
      if (text === null) rmSync(file, { force: true });
      else {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `commit ${index}`);
    return git(root, 'rev-parse', 'HEAD');
  });
  return { root, ids };
}

const base = { 'apps/api/wrangler.jsonc': CONFIG, '.github/workflows/tests.yml': WORKFLOW, 'tools/architecture/description.yml': DESCRIPTION, 'apps/api/src/http/app.ts': 'export const a = 1;\n' };

/** The model file the live report would have published for a commit: only its commit matters, so the rest is deliberately as an older generator drew it. */
const published = (commit) => {
  const file = path.join(tmp(), 'model.json');
  writeFileSync(file, JSON.stringify({ drawnFrom: { commit, date: null, repo: null }, deployment: { environments: [], workflows: [] } }));
  return file;
};

/** Runs the CLI over `root` and gives back the What changed section of its page, as text. */
async function whatChanged(root, previous) {
  const out = path.join(tmp(), 'index.html');
  const code = await main(['--root', root, '--out', out, ...(previous ? ['--previous', previous] : [])]);
  expect(code).toBe(0);
  return readFileSync(out, 'utf8')
    .match(/<section id="changes">([\s\S]*?)<\/section>/)[1]
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

const serve = async (handler) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/architecture/model.json`;
};

describe('What changed', () => {
  describe('a change to the generator alone reports nothing', () => {
    it('draws the live report’s commit again rather than trusting the model it published, so a reader the generator did not read before is not a change', async () => {
      const { root, ids } = repository([base, { 'README.md': 'unrelated' }]);
      // The published model of an older generator holds none of what today's reads (no resources, no areas).
      const text = await whatChanged(root, published(ids[0]));
      expect(text).toContain('Nothing changed.');
    });
  });

  describe('the comparison is against the live report’s commit, however long ago', () => {
    it('lists both nights’ changes when the live report is two nights old', async () => {
      const { root, ids } = repository([
        base,
        { 'apps/api/src/http/app.ts': "export const a = 'gmail';\n" },
        { '.github/workflows/deploy.yml': WORKFLOW.replace('Tests', 'Deploy'), 'apps/api/wrangler.jsonc': '{ "name": "w" }\n' },
      ]);
      const text = await whatChanged(root, published(ids[0]));
      expect(text).toContain('http names Gmail');
      expect(text).toContain('new source mark');
      expect(text).toContain('Deploy is a new workflow');
      expect(text).toContain('production loses KV namespace CACHE abc');
      expect(text).toContain(ids[0].slice(0, 7));
      expect(text).toContain(ids[2].slice(0, 7));
    });

    it('says nothing changed when there has been no merge since', async () => {
      const { root, ids } = repository([base, { 'README.md': 'unrelated' }]);
      expect(await whatChanged(root, published(ids[1]))).toContain('Nothing changed.');
    });

    it('draws a commit that has no description file with the current one, and says so', async () => {
      const { ids, root } = repository([{ ...base, 'tools/architecture/description.yml': null }, { 'tools/architecture/description.yml': DESCRIPTION }]);
      const text = await whatChanged(root, published(ids[0]));
      expect(text).toContain('has no description file');
      expect(text).toContain('Nothing changed.');
    });

    it('leaves no checkout of the earlier commit behind', async () => {
      const { root, ids } = repository([base, { 'README.md': 'unrelated' }]);
      await whatChanged(root, published(ids[0]));
      expect(git(root, 'worktree', 'list').split('\n')).toHaveLength(1);
    });
  });

  describe('with nothing to compare against, the page says so and invents nothing', () => {
    it('says this is the first report when there is no live report yet', async () => {
      const { root: repo } = repository([base]);
      expect(await whatChanged(repo, path.join(tmp(), 'no-such-model.json'))).toContain('first report');
      const url = await serve((_, response) => {
        response.statusCode = 404;
        response.end('not found');
      });
      expect(await whatChanged(repo, url)).toContain('first report');
    });

    it.each([
      { situation: 'the model is not JSON', write: 'not json', says: 'not valid JSON' },
      { situation: 'the model names no commit', write: '{"drawnFrom":{}}', says: 'names no commit' },
    ])('says there is nothing to compare when $situation', async ({ write, says }) => {
      const { root: repo } = repository([base]);
      const file = path.join(tmp(), 'm.json');
      writeFileSync(file, write);
      const text = await whatChanged(repo, file);
      expect(text).toContain('There is nothing to compare');
      expect(text).toContain(says);
      expect(text).not.toContain('Nothing changed');
    });

    it('says there is nothing to compare when the live model cannot be fetched', async () => {
      const { root: repo } = repository([base]);
      const failing = await serve((_, response) => {
        response.statusCode = 503;
        response.end('down');
      });
      expect(await whatChanged(repo, failing)).toContain('answered 503');
      const closed = await serve((_, response) => response.end());
      await new Promise((resolve) => servers.pop().close(resolve));
      expect(await whatChanged(repo, closed)).toContain('could not be fetched');
    });

    it('says there is nothing to compare when the live model’s commit is not in the history', async () => {
      const { root: repo } = repository([base]);
      const text = await whatChanged(repo, published('1234567890abcdef1234567890abcdef12345678'));
      expect(text).toContain('There is nothing to compare');
      expect(text).toContain('not in this checkout');
    });

    it('says there is nothing to compare when the earlier commit cannot be drawn', async () => {
      const { root: repo, ids } = repository([{ ...base, 'apps/api/wrangler.jsonc': null }, { 'apps/api/wrangler.jsonc': CONFIG }]);
      expect(await whatChanged(repo, published(ids[0]))).toContain('could not be drawn');
    });

    it('compares with a model fetched from an address', async () => {
      const { root: repo, ids } = repository([base, { 'apps/api/src/http/app.ts': "export const a = 'gmail';\n" }]);
      const url = await serve((_, response) => response.end(readFileSync(published(ids[0]), 'utf8')));
      expect(await whatChanged(repo, url)).toContain('http names Gmail');
    });
  });
});
