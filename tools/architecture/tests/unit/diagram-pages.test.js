import { describe, expect, it } from 'vitest';

import { buildModel } from '../../src/model.js';
import { renderDiagramPages, renderHtml } from '../../src/render/html.js';
import { descriptionFile } from '../support/description.js';

const wrangler = JSON.stringify({ name: 'cockpit', d1_databases: [{ binding: 'DB', database_name: 'cockpit' }] });
const model = (drawnFrom = { commit: 'abc1234def5678', date: '2026-10-08T13:03:04+02:00', repo: 'o/r' }) =>
  buildModel({
    wrangler: { file: 'w.jsonc', text: wrangler },
    workflows: [],
    description: descriptionFile({ layers: [{ title: 'Layer', note: '', role: 'core', areas: [{ path: 'apps/api/src/a', description: 'a does its job' }] }] }),
    candidates: [{ path: 'apps/api/src/a', package: false, role: 'core', files: [{ file: 'apps/api/src/a/x.ts', text: '' }] }],
    ...drawnFrom,
  });

const PAGES = { Context: 'context.html', Modules: 'modules.html', Deployment: 'deployment.html' };

describe('Architecture diagrams', () => {
  describe('each diagram on the report opens, in a new tab, a page of its own carrying that diagram', () => {
    const report = renderHtml(model());
    const section = (id, next) => report.slice(report.indexOf(`id="${id}"`), report.indexOf(`id="${next}"`));

    it.each([
      { diagram: 'Context', id: 'context', next: 'modules' },
      { diagram: 'Modules', id: 'modules', next: 'deps' },
      { diagram: 'Deployment', id: 'deployment', next: null },
    ])('$diagram is a link to its own page, opening in a new tab', ({ diagram, id, next }) => {
      const html = next ? section(id, next) : report.slice(report.indexOf(`id="${id}"`));
      const opened = html.match(/<a class="open" href="([^"]+)" target="_blank" rel="noopener"><svg/);
      expect(opened?.[1]).toBe(PAGES[diagram]);
      expect(html).toContain(`<a class="openfull" href="${PAGES[diagram]}" target="_blank" rel="noopener">Open full size`);
    });

    it('leaves the Dependencies matrix and What changed without such a link', () => {
      expect(section('changes', 'context')).not.toContain('target="_blank"');
      expect(section('deps', 'deployment')).not.toContain('class="open');
    });

    it('still fits each diagram in the page to the column, with no script', () => {
      expect(report).toMatch(/\.diagram svg \{ display: block; width: 100%; height: auto; \}/);
      expect(report).not.toContain('<script');
    });
  });

  describe('a diagram page draws the diagram at its natural size', () => {
    const pages = renderDiagramPages(model());

    it.each(Object.entries(PAGES))('%s is drawn at the width and height of its own viewBox, in a box that scrolls', (title, file) => {
      const html = pages[file];
      const [, width, height] = html.match(/<svg viewBox="0 0 ([\d.]+) ([\d.]+)" style="width:([\d.]+)px;height:([\d.]+)px"/).slice(0, 3);
      expect(html).toContain(`style="width:${width}px;height:${height}px"`);
      expect(html).not.toContain('min-width');
      expect(html).toMatch(/\.diagram\.full \{[^}]*overflow: auto/);
    });

    it('keeps the tooltip of a box that has a description', () => {
      expect(pages['modules.html']).toMatch(/<title>[^<]*a does its job[^<]*<\/title>/);
    });
  });

  describe('a diagram page is a page of the report', () => {
    const page = (drawnFrom) => renderDiagramPages(model(drawnFrom))['modules.html'];

    it('names the commit and date it was drawn from, as the report does, and links back to it', () => {
      const html = page();
      expect(html).toContain('<b>abc1234</b>');
      expect(html).toContain('https://github.com/o/r/commit/abc1234def5678');
      expect(html).toContain('<b>2026-10-08</b>');
      expect(html).toContain('<a href="index.html">');
    });

    it('carries the note and legend the diagram is read with on the report', () => {
      const report = renderHtml(model());
      const legend = report.slice(report.indexOf('<div class="legend">'), report.indexOf('</div>', report.indexOf('<div class="legend">')));
      expect(legend).toContain('Connector code living in the core');
      expect(page()).toContain(legend);
      expect(renderDiagramPages(model())['deployment.html']).toContain('<em>inherited</em> marks a setting');
    });

    it('says the commit is not known rather than leaving the line out', () => {
      const html = page({ commit: null, date: null, repo: null });
      expect(html).toContain('commit <b>not known</b>');
      expect(html).toContain('commit dated <b>not known</b>');
    });

    it('carries the report\'s styles inline, light and dark, and no script', () => {
      const html = page();
      expect(html).toContain('<meta name="color-scheme" content="light dark">');
      expect(html).toContain('@media (prefers-color-scheme: dark)');
      expect(html).toContain('--card:');
      expect(html).not.toContain('<script');
      expect(html).not.toMatch(/<link[^>]+href=/);
    });
  });
});
