//
// Unit tests for the bundle gate's arithmetic. Run by `node --test` from the
// Scripts CI job, which installs nothing - so the file it tests reads no
// filesystem and runs no build, and everything here is a list of numbers.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { referencedByTheDocument, whatTheBundleCosts } from './bundle-budget.mjs';

const KB = 1024;

const anEntryDocument = `<!doctype html><html><head>
<link rel="modulepreload" href="/assets/shared-abc.js">
<link rel="stylesheet" href="/assets/index-abc.css">
<script type="module" src="/assets/index-abc.js"></script>
</head><body></body></html>`;

describe('what a cold open fetches', () => {
  it('is what the entry document names, and nothing reached only by import()', () => {
    const named = referencedByTheDocument(anEntryDocument);

    assert.ok(named.has('index-abc.js'));
    assert.ok(named.has('shared-abc.js'));
    assert.ok(!named.has('RichDescription-abc.js'));
  });
});

describe('the two budget lines', () => {
  const named = referencedByTheDocument(anEntryDocument);

  it('adds up the initial bundle and charges each lazy chunk on its own', () => {
    const report = whatTheBundleCosts(
      [
        { file: 'index-abc.js', bytes: 150 * KB },
        { file: 'shared-abc.js', bytes: 30 * KB },
        { file: 'RichDescription-abc.js', bytes: 140 * KB },
      ],
      named,
      200 * KB,
    );

    assert.equal(report.initialBytes, 180 * KB);
    assert.deepEqual(
      report.lazy.map(({ file }) => file),
      ['RichDescription-abc.js'],
    );
    assert.deepEqual(report.over, []);
  });

  // The whole reason there are two lines: summed, this is 290KB and red, with
  // nothing wrong - the second file is never on the cold-open path.
  it('does not charge a lazy chunk to the entry', () => {
    const report = whatTheBundleCosts(
      [
        { file: 'index-abc.js', bytes: 150 * KB },
        { file: 'RichDescription-abc.js', bytes: 140 * KB },
      ],
      named,
      200 * KB,
    );

    assert.deepEqual(report.over, []);
  });

  it('names the initial bundle when the entry itself is over', () => {
    const report = whatTheBundleCosts(
      [
        { file: 'index-abc.js', bytes: 190 * KB },
        { file: 'shared-abc.js', bytes: 20 * KB },
      ],
      named,
      200 * KB,
    );

    assert.deepEqual(
      report.over.map(({ what }) => what),
      ['the initial bundle'],
    );
  });

  it('names the chunk when a lazy one is over on its own', () => {
    const report = whatTheBundleCosts(
      [
        { file: 'index-abc.js', bytes: 10 * KB },
        { file: 'RichDescription-abc.js', bytes: 201 * KB },
      ],
      named,
      200 * KB,
    );

    assert.deepEqual(
      report.over.map(({ what }) => what),
      ['RichDescription-abc.js'],
    );
  });

  it('reports both when both are over', () => {
    const report = whatTheBundleCosts(
      [
        { file: 'index-abc.js', bytes: 260 * KB },
        { file: 'RichDescription-abc.js', bytes: 260 * KB },
      ],
      named,
      200 * KB,
    );

    assert.equal(report.over.length, 2);
  });

  // Zero is under budget, so this alone would pass a build that emitted
  // nothing. Refusing an empty build is the runner's job, not the arithmetic's.
  it('charges nothing where nothing was built', () => {
    const report = whatTheBundleCosts([], named, 200 * KB);

    assert.equal(report.initialBytes, 0);
    assert.deepEqual(report.over, []);
  });
});
