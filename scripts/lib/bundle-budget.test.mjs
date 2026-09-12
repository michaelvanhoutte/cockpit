//
// Unit tests for the bundle gate. Run by `node --test` from the Scripts step,
// which installs nothing - so nothing here runs a build: the arithmetic is a
// list of numbers, and the one part that reads a directory is given a temporary
// one shaped like what Vite emits.
//

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { javascriptIn, referencedByTheDocument, whatTheBundleCosts } from './bundle-budget.mjs';

const KB = 1024;

/**
 * What Vite emits, including the two files the PWA plugin writes outside
 * `assets/`: `registerSW.js`, which the document references, and the service
 * worker, which it does not.
 */
const anEntryDocument = `<!doctype html><html><head>
<link rel="modulepreload" href="/assets/shared-abc.js">
<link rel="stylesheet" href="/assets/index-abc.css">
<script type="module" src="/assets/index-abc.js"></script>
<link rel="manifest" href="/manifest.webmanifest">
</head><body><script src="/registerSW.js"></script></body></html>`;

/** A `dist/` shaped like the one Vite and its PWA plugin actually emit. */
function aBuild() {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-budget-test-'));
  mkdirSync(join(dir, 'assets'));
  for (const [path, body] of [
    ['index.html', '<script src="/assets/index-abc.js"></script>'],
    ['assets/index-abc.js', 'entry'],
    ['assets/RichDescription-abc.js', 'editor'],
    ['assets/index-abc.css', 'styles'],
    ['registerSW.js', 'register'],
    ['sw.js', 'worker'],
    ['manifest.webmanifest', '{}'],
  ]) {
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

describe('what a build emitted', () => {
  // Only `assets/` was read once, so `registerSW.js` - which the entry document
  // references, and every cold open therefore fetches - was never measured.
  it('is every JavaScript file under it, wherever it sits', () => {
    assert.deepEqual(javascriptIn(aBuild()), [
      'assets/RichDescription-abc.js',
      'assets/index-abc.js',
      'registerSW.js',
      'sw.js',
    ]);
  });
});

describe('what a cold open fetches', () => {
  const named = referencedByTheDocument(anEntryDocument);

  it('is what the entry document names, and nothing reached only by import()', () => {
    assert.ok(named.has('assets/index-abc.js'));
    assert.ok(named.has('assets/shared-abc.js'));
    assert.ok(!named.has('assets/RichDescription-abc.js'));
  });

  // The registration script sits beside `assets/` rather than inside it, and
  // the document references it, so a gate that read only `assets/` never
  // charged a file every cold open fetches.
  it('includes what the document names outside the assets folder', () => {
    assert.ok(named.has('registerSW.js'));
    assert.ok(!named.has('sw.js'));
  });

  // Named by where it sits, not by what it is called, so two files that differ
  // only by folder stay two files.
  it('keeps the path below the build directory', () => {
    assert.ok(!named.has('index-abc.js'));
  });
});

describe('the two budget lines', () => {
  const named = referencedByTheDocument(anEntryDocument);

  it('adds up the initial bundle and charges each of the rest on its own', () => {
    const report = whatTheBundleCosts(
      [
        { file: 'assets/index-abc.js', bytes: 150 * KB },
        { file: 'assets/shared-abc.js', bytes: 28 * KB },
        { file: 'registerSW.js', bytes: 2 * KB },
        { file: 'assets/RichDescription-abc.js', bytes: 140 * KB },
        { file: 'sw.js', bytes: 12 * KB },
      ],
      named,
      200 * KB,
    );

    assert.equal(report.initialBytes, 180 * KB);
    assert.deepEqual(
      report.separate.map(({ file }) => file),
      ['assets/RichDescription-abc.js', 'sw.js'],
    );
    assert.deepEqual(report.over, []);
  });

  // The whole reason there are two lines: summed, this is 290KB and red, with
  // nothing wrong - the second file is never on the cold-open path.
  it('does not charge a lazy chunk to the entry', () => {
    const report = whatTheBundleCosts(
      [
        { file: 'assets/index-abc.js', bytes: 150 * KB },
        { file: 'assets/RichDescription-abc.js', bytes: 140 * KB },
      ],
      named,
      200 * KB,
    );

    assert.deepEqual(report.over, []);
  });

  it('names the initial bundle when the entry itself is over', () => {
    const report = whatTheBundleCosts(
      [
        { file: 'assets/index-abc.js', bytes: 190 * KB },
        { file: 'assets/shared-abc.js', bytes: 20 * KB },
      ],
      named,
      200 * KB,
    );

    assert.deepEqual(
      report.over.map(({ what }) => what),
      ['the initial bundle'],
    );
  });

  it('names the chunk when a separately fetched one is over on its own', () => {
    const report = whatTheBundleCosts(
      [
        { file: 'assets/index-abc.js', bytes: 10 * KB },
        { file: 'assets/RichDescription-abc.js', bytes: 201 * KB },
      ],
      named,
      200 * KB,
    );

    assert.deepEqual(
      report.over.map(({ what }) => what),
      ['assets/RichDescription-abc.js'],
    );
  });

  it('reports both when both are over', () => {
    const report = whatTheBundleCosts(
      [
        { file: 'assets/index-abc.js', bytes: 260 * KB },
        { file: 'assets/RichDescription-abc.js', bytes: 260 * KB },
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
