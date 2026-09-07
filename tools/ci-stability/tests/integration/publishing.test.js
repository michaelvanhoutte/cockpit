/**
 * The wiring between this generator and the published site, asserted by reading
 * `ci.yml` rather than by running anything — the same thing the `Scripts` job's
 * own tests do for the conventions no runnable test can reach.
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
const workflow = readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');

describe('the published site, as ci.yml assembles it', () => {
  it('writes the report where the job then uploads it from', () => {
    expect(workflow).toContain('--out tools/ci-stability/out/index.html');
    expect(workflow).toContain('path: tools/ci-stability/out/');
  });

  it('downloads under the name the stability job uploaded, so the artifact is found', () => {
    const uploads = workflow.match(/name: ci-stability-report/g) ?? [];
    // Once where it is uploaded, once where it is taken back.
    expect(uploads).toHaveLength(2);
  });

  it('puts the stability page at /stability/ and the explorer at the root', () => {
    expect(workflow).toContain('path: site/stability/');
    expect(workflow).toContain('path: site/\n');
  });

  it('publishes the assembled directory, not either report alone', () => {
    const upload = workflow.slice(workflow.indexOf('upload-pages-artifact'));
    expect(upload.slice(0, 200)).toContain('path: site/');
  });

  it('lets the stability report fail without taking the site down with it', () => {
    // The explorer is the page; the stability report is allowed to be missing.
    expect(workflow).toContain("needs.test-explorer.result == 'success'");
    expect(workflow).toMatch(/name: ci-stability-report[\s\S]{0,400}?continue-on-error: true|continue-on-error: true[\s\S]{0,400}?name: ci-stability-report/);
  });

  it('grants the stability job no write anywhere, since the report only reads', () => {
    const job = workflow.slice(workflow.indexOf('  stability:'));
    const permissions = job.slice(job.indexOf('permissions:'), job.indexOf('continue-on-error'));
    expect(permissions).toContain('actions: read');
    expect(permissions).not.toContain('write');
  });
});
