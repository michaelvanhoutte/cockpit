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

  describe('the deployment is drawn as a diagram', () => {
    it('draws an environment per column with its resources, and an arrow from the workflow that deploys it', () => {
      const html = page();
      expect(html).toContain('<svg');
      expect(html).toContain('>staging</text>');
      expect(html).toContain('cockpit-staging');
      expect(html).toMatch(/class="t-hl"[^>]*>deploy-staging\.yml/);
      expect(html).toContain('marker-end="url(#arrow)"');
    });

    it('lays out a further environment as a further column, clear of the one before it', () => {
      const three = JSON.stringify({ name: 'w', d1_databases: [{ binding: 'DB', database_name: 'a' }], env: { staging: {}, qa: { vectorize: [{ binding: 'V', name: 'idx' }] } } });
      const html = renderHtml(buildModel({ wrangler: { file: 'w.jsonc', text: three }, workflows: [{ file: 'd.yml', text: deploy.replace('staging', 'qa') }], commit: null, date: null }));
      const columns = [...html.matchAll(/<rect class="worker" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)].map((each) => [Number(each[1]), Number(each[2])]);
      expect(columns).toHaveLength(3);
      for (let i = 1; i < columns.length; i += 1) expect(columns[i][0]).toBeGreaterThanOrEqual(columns[i - 1][0] + columns[i - 1][1]);
      expect(html).toContain('>vectorize</text>');
    });

    it('draws GitHub Pages with each published report at its path, and not at all without a Pages deploy', () => {
      const publish = 'name: Publish\non:\n  workflow_call:\njobs:\n  p:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/download-artifact@v4\n        with:\n          name: architecture-report\n          path: site/architecture/\n      - uses: actions/upload-pages-artifact@v3\n        with:\n          path: site/\n      - uses: actions/deploy-pages@v4\n';
      const draw = (workflows) => renderHtml(buildModel({ wrangler: { file: 'w.jsonc', text: wrangler }, workflows, commit: null, date: null }));
      const html = draw([{ file: 'publish.yml', text: publish }]);
      expect(html).toContain('GitHub Pages');
      expect(html).toContain('>/architecture/</text>');
      expect(html).toContain('>architecture-report</text>');
      expect(page()).not.toContain('GitHub Pages');
    });

    it('draws local development from the local environment, below GitHub', () => {
      const html = renderHtml(buildModel({ wrangler: { file: 'w.jsonc', text: JSON.stringify({ name: 'w', env: { local: { name: 'w-local', d1_databases: [{ binding: 'DB', database_name: 'dev' }] } } }) }, workflows: [{ file: 'd.yml', text: deploy }], commit: null, date: null }));
      expect(html).toContain('Local development');
      expect(html).toContain('>dev</text>');
    });
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
