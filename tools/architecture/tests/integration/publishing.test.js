/**
 * The wiring between this generator and nightly.yml and publish.yml, asserted
 * by reading the workflow files rather than by running anything.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const workflow = (name) => parse(readFileSync(path.join(repo, '.github/workflows', name), 'utf8'));
const nightly = workflow('nightly.yml');
const publish = workflow('publish.yml');

describe('The nightly job publishes the page and its model at /architecture/', () => {
  const steps = nightly.jobs.architecture.steps;

  it('writes both the page and the model into one uploaded report', () => {
    const run = steps.find((step) => step.run?.includes('tools/architecture/src/cli.js')).run;
    expect(run).toContain('--out tools/architecture/out/index.html --model tools/architecture/out/model.json');
    expect(steps.find((step) => step.uses?.startsWith('actions/upload-artifact'))).toMatchObject({ with: { name: 'architecture-report', path: 'tools/architecture/out/' } });
  });

  it('gives the job the checkout and nothing else to read with', () => {
    expect(nightly.jobs.architecture.permissions).toEqual({ contents: 'read' });
    expect(JSON.stringify(nightly.jobs.architecture)).not.toContain('secrets.');
  });

  it('is waited on by the publish job', () => {
    expect(nightly.jobs.publish.needs).toContain('architecture');
  });

  it('takes that report into the site\'s /architecture/', () => {
    const take = publish.jobs.publish.steps.find((step) => step.with?.name === 'architecture-report' && step.uses.startsWith('actions/download-artifact'));
    expect(take.with.path).toBe('site/architecture/');
  });

  it('costs only its own page when no architecture report is found', () => {
    const steps = publish.jobs.publish.steps;
    const find = steps.find((step) => step.id === 'architecture');
    const take = steps.find((step) => step.with?.name === 'architecture-report' && step.uses.startsWith('actions/download-artifact'));
    expect(find['continue-on-error']).toBe(true);
    expect(take['continue-on-error']).toBe(true);
    expect(take.if).toContain("steps.architecture.outputs.run-id != ''");
  });
});
