import { describe, expect, it } from 'vitest';

import { buildModel } from '../../src/model.js';
import { renderHtml } from '../../src/render/html.js';

const wrangler = JSON.stringify({ name: 'cockpit', d1_databases: [{ binding: 'DB', database_name: 'cockpit' }], env: { staging: { d1_databases: [{ binding: 'DB', database_name: 'cockpit-staging' }] } } });
const deploy = 'name: Deploy staging\non:\n  push:\n    branches: [main]\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm wrangler deploy --env staging\n';
const page = (drawnFrom = { commit: 'abc1234def5678', date: '2026-10-08T13:03:04+02:00', repo: 'o/r' }) =>
  renderHtml(buildModel({ wrangler: { file: 'w.jsonc', text: wrangler }, workflows: [{ file: 'deploy-staging.yml', text: deploy }], ...drawnFrom }));

describe('The architecture page', () => {
  describe('the page names the commit and date it was drawn from', () => {
    it('states the commit, linked, and the date of that commit', () => {
      const html = page();
      expect(html).toContain('<b>abc1234</b>');
      expect(html).toContain('https://github.com/o/r/commit/abc1234def5678');
      expect(html).toContain('<b>2026-10-08</b>');
    });

    it('says so, rather than leaving the line out, when the checkout had no commit', () => {
      const html = page({ commit: null, date: null, repo: null });
      expect(html).toContain('commit <b>not known</b>');
      expect(html).toContain('commit dated <b>not known</b>');
    });
  });

  it('draws each environment with its resources and each workflow with the environment it deploys', () => {
    const html = page();
    expect(html).toContain('id="env-staging"');
    expect(html).toContain('cockpit-staging');
    expect(html).toMatch(/Deploy staging[\s\S]*every merge[\s\S]*&rarr; staging/);
  });

  it('opens from disk: styles inline, no script, no remote address but links a reader follows', () => {
    const html = page();
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<link[^>]+href=/);
  });

  it('escapes what the repository wrote before putting it on the page', () => {
    const html = renderHtml({
      drawnFrom: { commit: null, date: null, repo: null },
      deployment: { environments: [{ name: 'x', kind: 'environment', worker: '<b>w</b>', resources: [], deployedBy: [] }], workflows: [] },
    });
    expect(html).toContain('&lt;b&gt;w&lt;/b&gt;');
  });

  it('follows the reader\'s light or dark setting', () => {
    expect(page()).toContain('prefers-color-scheme: light');
  });
});
