/**
 * The wiring between this generator and the published site, asserted by reading
 * `ci.yml` and `publish.yml` rather than by running anything — the same thing
 * the `Scripts` job's own tests do for the conventions no runnable test can
 * reach. The upload stays in `ci.yml`, beside the job that builds the report;
 * the download and placement moved to `publish.yml`, the reusable workflow
 * both `ci.yml` and `nightly.yml` call to put a report live ("Publish
 * nightly's reports the same night, and make a manual run go live too", issue
 * 563).
 *
 * It is worth a test because the failure is silent: every path here can be
 * wrong while CI stays green, and the only symptom is a 404 at the URL the tool
 * exists to serve. Nothing else in the suite looks at where the output goes.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ci = readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
const publish = readFileSync(path.join(repo, '.github/workflows/publish.yml'), 'utf8');

describe('the published site, as ci.yml and publish.yml assemble it', () => {
  it('writes the report where the job then uploads it from', () => {
    expect(ci).toContain('--out tools/ci-stability/out/index.html');
    expect(ci).toContain('--model tools/ci-stability/out/model.json');
    expect(ci).toContain('path: tools/ci-stability/out/');
  });

  it('uploads under the name publish.yml downloads it back by', () => {
    expect(ci.match(/name: ci-stability-report/g) ?? []).toHaveLength(1);
    expect(publish.match(/name: ci-stability-report/g) ?? []).toHaveLength(2);
  });

  it('puts the stability page at /stability/ and the explorer at the root', () => {
    expect(publish).toContain('path: site/stability/');
    expect(publish).toContain('path: site/\n');
  });

  it('publishes the assembled directory, not either report alone', () => {
    const upload = publish.slice(publish.indexOf('upload-pages-artifact'));
    expect(upload.slice(0, 200)).toContain('path: site/');
  });

  it('lets the stability report fail without taking the site down with it', () => {
    // The explorer is the page; the stability report is allowed to be missing.
    expect(ci).toContain("needs.test-explorer.result == 'success'");
    expect(publish).toMatch(/name: ci-stability-report[\s\S]{0,400}?continue-on-error: true|continue-on-error: true[\s\S]{0,400}?name: ci-stability-report/);
  });

  it('grants the stability job no write anywhere, since the report only reads', () => {
    const job = ci.slice(ci.indexOf('  stability:'), ci.indexOf('  pages:'));
    const permissions = job.slice(job.indexOf('permissions:'), job.indexOf('continue-on-error'));
    expect(permissions).toContain('actions: read');
    expect(permissions).not.toContain('write');
  });
});
