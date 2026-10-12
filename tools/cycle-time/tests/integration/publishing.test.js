/**
 * The wiring between this generator, nightly.yml and publish.yml, asserted by
 * reading the workflow files rather than by running anything.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const nightly = readFileSync(path.join(repo, '.github/workflows/nightly.yml'), 'utf8');
const publish = readFileSync(path.join(repo, '.github/workflows/publish.yml'), 'utf8');

/** The step in `publish.yml` with this name, up to the next step. */
function step(name) {
  const start = publish.indexOf(`- name: ${name}`);
  expect(start, `no step named ${name}`).toBeGreaterThan(-1);
  const next = publish.indexOf('\n      - ', start + 1);
  return publish.slice(start, next === -1 ? undefined : next);
}

describe('the nightly cycle-time job, as nightly.yml assembles it', () => {
  it('writes the report with both --out and --model', () => {
    expect(nightly).toContain('--out tools/cycle-time/out/index.html --model tools/cycle-time/out/model.json');
    expect(nightly).toContain('path: tools/cycle-time/out/');
  });

  it('uploads the page and model as the cycle-time-report artifact', () => {
    expect(nightly).toContain('name: cycle-time-report');
    expect(nightly).not.toContain('lead-time');
  });
});

describe('the cycle-time page, as publish.yml places it', () => {
  it('takes the cycle-time-report artifact into /cycle-time/', () => {
    const take = step('Take the cycle-time page, if there is one');
    expect(take).toContain('name: cycle-time-report');
    expect(take).toContain('path: site/cycle-time/');
  });

  it('lets a missing page cost the page and never the site', () => {
    expect(step('Find the cycle-time page')).toContain('continue-on-error: true');
    expect(step('Take the cycle-time page, if there is one')).toContain('continue-on-error: true');
  });
});

describe('the old /lead-time/ address, as publish.yml keeps it', () => {
  it('writes a page sending the reader to /cycle-time/', () => {
    const old = step('Keep the old /lead-time/ address working');
    expect(old).toContain('site/lead-time/index.html');
    expect(old).toContain('http-equiv="refresh" content="0; url=../cycle-time/"');
    expect(old).toContain('<a href="../cycle-time/">');
  });

  it('serves the same model.json beside it', () => {
    const old = step('Keep the old /lead-time/ address working');
    expect(old).toContain('cp site/cycle-time/model.json site/lead-time/model.json');
  });

  it('is no worse than the new address when the page is missing, and never fails the site', () => {
    const old = step('Keep the old /lead-time/ address working');
    expect(old).toContain('continue-on-error: true');
    expect(old).toMatch(/if \[ -f site\/cycle-time\/model\.json \]/);
    // Written after the page is taken, before the site is uploaded.
    expect(publish.indexOf('Keep the old /lead-time/')).toBeGreaterThan(publish.indexOf('Take the cycle-time page'));
    expect(publish.indexOf('Keep the old /lead-time/')).toBeLessThan(publish.indexOf('upload-pages-artifact'));
  });
});
