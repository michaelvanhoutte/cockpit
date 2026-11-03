import { describe, expect, it } from 'vitest';

import { buildLogical } from '../../src/logical.js';
import { callsSentence, countLine, renderDesignPage, renderDesignPages, renderServicesDesignPage } from '../../src/render/design.js';
import { renderLogicalPage } from '../../src/render/logical.js';
import { readDescription } from '../support/description.js';

const chip = (id, extra = {}) => ({ id, name: id, ...extra });
const drawnFrom = { commit: 'abc1234def5678', repo: 'o/r' };

const AGREED = { reason: 'Everything arrives at an entry point.', agreed: true };
const DRAFTED = { reason: 'Routes are thin adapters.', source: 'Hono + Zod (module layout)', agreed: false };
const QUESTION = { question: 'Is this rule there only so the queue line is allowed?', agreed: false };

/** Clients, API, logic, data and Outside services, with Outside calling nothing. */
const design = (overrides = {}) => ({
  layers: [
    { id: 'clients', title: 'Clients', kind: 'clients', row: 0, items: [[chip('web', { kind: 'client' })]] },
    { id: 'api', title: 'API layer: the entry points', row: 1, items: [[chip('http', { folders: ['apps/api/src/http'] })]] },
    { id: 'logic', title: 'Business logic', row: 2, items: [[chip('accounts', { folders: ['apps/api/src/accounts'] })]] },
    { id: 'data', title: 'Data', row: 3, share: 0.6, items: [[chip('d1', { kind: 'store', folders: ['apps/api/src/db'], marker: '\\benv\\.DB\\b', how: 'SQL' })]] },
    { id: 'outside', title: 'Outside services', kind: 'outside', alignedWith: 'logic', items: [[chip('google', { kind: 'outside', marker: 'google', how: 'HTTPS' })]] },
  ],
  mayCall: { clients: ['api'], api: ['logic'], logic: ['data', 'outside'] },
  reasons: { 'clients>api': AGREED, 'api>logic': DRAFTED, 'logic>data': QUESTION, 'logic>outside': DRAFTED },
  breaks: { 'clients>logic': 'A client reaches past the API layer', 'api>data': 'The API layer reaches Data directly' },
  callers: [{ from: 'web', to: 'http', how: 'REST /v1, a session cookie' }],
  accepted: [{ from: 'http', to: 'd1', files: ['apps/api/src/http/a.ts'], reason: 'It reads the Register directly.', agreed: false }],
  noLine: [],
  ...overrides,
});

function modelOf(overrides) {
  const logical = buildLogical({ design: readDescription({ design: design(overrides) }).design, scan: { extensions: ['.ts'] }, candidates: [] });
  return { logical, drawnFrom, services: [], deployments: [], serviceMap: null };
}

const pageOf = (overrides, service = {}) => renderDesignPage(modelOf(overrides), service);
const body = (html) => html.slice(html.indexOf('<body>')).replace(/<svg[\s\S]*?<\/svg>/g, '');
const textOf = (html) => body(html).replace(/<\/(p|h\d|div|li|tr)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ');
const numbers = (html, pattern) => [...html.matchAll(pattern)].map((each) => Number(each[1]));

describe('Each Design tab draws one numbered arrow per allowed call and one card per rule under the same number', () => {
  it('numbers Cockpit\'s arrows, cards and jumps alike, each jump leading to its card', () => {
    const html = pageOf();
    expect(numbers(html, /<text class="nl-num-t[^>]*>(\d+)<\/text>/g)).toEqual([1, 2, 3, 4]);
    expect(numbers(html, /<div class="rule" id="rule-(\d+)"/g)).toEqual([1, 2, 3, 4]);
    expect(numbers(html, /<a href="#rule-(\d+)"/g)).toEqual([1, 2, 3, 4]);
  });

  it('opens no group for a layer that calls nothing', () => {
    const text = textOf(pageOf());
    expect(text).toContain('Clients call API layer, and nothing else.');
    expect(text).not.toContain('Outside services call');
    expect(text).not.toContain('Outside services calls');
  });

  it('draws two arrows and two cards for the widget, which may call Cockpit and the phone', () => {
    const widget = design({
      layers: [
        { id: 'widget', title: 'Android widget', kind: 'service', row: 0, items: [[chip('client', { folders: ['apps/w'] })]] },
        { id: 'cockpit', title: 'Cockpit: API layer', kind: 'context', row: 1, items: [[chip('ctx-mcp', { folders: ['apps/api/src/mcp'] })]] },
        { id: 'phone', title: 'On the phone', kind: 'outside', alignedWith: 'widget', items: [[chip('browser', { kind: 'outside' })]] },
      ],
      mayCall: { widget: ['cockpit', 'phone'] },
      reasons: { 'widget>cockpit': DRAFTED, 'widget>phone': DRAFTED },
      breaks: {},
      callers: [{ from: 'client', to: 'ctx-mcp', how: 'Bearer' }],
      accepted: [],
    });
    const html = pageOf(widget, {});
    expect(numbers(html, /<text class="nl-num-t[^>]*>(\d+)<\/text>/g)).toEqual([1, 2]);
    expect(numbers(html, /<div class="rule" id="rule-(\d+)"/g)).toEqual([1, 2]);
  });

  it('draws no layers for a service the rules do not rule inside, only how it is reached and its rule', () => {
    const monitor = design({
      layers: [
        { id: 'clients', title: 'Clients', kind: 'clients', row: 0, items: [[chip('hook', { kind: 'client' })]] },
        { id: 'routes', title: 'Routes', row: 1, items: [[chip('entry', { folders: ['apps/m/src'] })]] },
      ],
      mayCall: {},
      reasons: {},
      breaks: {},
      rules: [{ rule: 'Every caller arrives at the routes', ...DRAFTED }],
      callers: [{ from: 'hook', to: 'entry', how: 'POST /v1/usage, the write key' }],
      accepted: [],
      unruled: true,
    });
    const html = pageOf(monitor, { name: 'Harness Monitor' });
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('id="rule-1"');
    const text = textOf(html);
    expect(text).toContain('Every caller arrives at the routes');
    expect(text).toContain('hook entry POST /v1/usage, the write key');
    expect(text).toContain('1 rule, 0 agreed, 1 drafted, 0 questions');
  });
});

describe('Each rule shows its mark, and the count line totals the marks', () => {
  const three = { mayCall: { clients: ['api'], api: ['logic'], logic: ['data'] }, reasons: { 'clients>api': AGREED, 'api>logic': DRAFTED, 'logic>data': QUESTION }, accepted: [], breaks: {} };

  it('marks agreed, drafted with its source, and a question with its question', () => {
    const html = pageOf(three);
    const cards = body(html).split('<div class="rule" ').slice(1);
    expect(cards[0]).toContain('mark agreed');
    expect(cards[1]).toContain('mark drafted');
    expect(cards[1]).toContain('From docs/architecture.md: Hono + Zod (module layout)');
    expect(cards[2]).toContain('mark question');
    expect(cards[2]).toContain('Is this rule there only so the queue line is allowed?');
  });

  it('totals the marks in one line', () => {
    expect(textOf(pageOf(three))).toContain('3 rules, 1 agreed, 1 drafted, 1 question');
    expect(countLine([AGREED, DRAFTED, QUESTION])).toBe('3 rules, 1 agreed, 1 drafted, 1 question');
    expect(countLine([AGREED])).toBe('1 rule, 1 agreed, 0 drafted, 0 questions');
  });

  it('counts a rule with neither a reason nor a question as a question', () => {
    expect(countLine([{ agreed: false }, undefined])).toBe('2 rules, 0 agreed, 0 drafted, 2 questions');
  });
});

describe('Each group opens with one sentence naming every layer its start layer may call, then "and nothing else"', () => {
  it.each([
    { situation: 'one call', from: 'Clients', targets: ['the API layer'], expected: 'Clients call the API layer, and nothing else.' },
    { situation: 'a singular start layer', from: 'Business logic', targets: ['Data'], expected: 'Business logic calls Data, and nothing else.' },
    { situation: 'three calls', from: 'Business logic', targets: ['Data', 'Connectors', 'Outside services'], expected: 'Business logic calls Data, Connectors and Outside services, and nothing else.' },
    { situation: 'two calls', from: 'Android widget', targets: ['Cockpit', 'On the phone'], expected: 'Android widget calls Cockpit and On the phone, and nothing else.' },
  ])('$situation', ({ from, targets, expected }) => {
    expect(callsSentence(from, targets)).toBe(expected);
  });

  it('names a layer by its title up to the colon', () => {
    expect(textOf(pageOf())).toContain('Business logic calls Data and Outside services, and nothing else.');
    expect(textOf(pageOf())).toContain('API layer calls Business logic, and nothing else.');
  });
});

describe('What is not allowed, the accepted deviations and the callers each read as the page shows them', () => {
  it('writes one sentence for each thing not allowed, the last "Anything else the drawing does not draw."', () => {
    const items = [...body(pageOf()).matchAll(/<li>([^<]*)<\/li>/g)].map((each) => each[1]);
    expect(items).toEqual(['A client reaches past the API layer.', 'The API layer reaches Data directly.', 'Anything else the drawing does not draw.']);
  });

  it('shows an accepted deviation with its reason, its files and its mark', () => {
    const text = textOf(pageOf());
    expect(text).toContain('http → d1');
    expect(text).toContain('It reads the Register directly.');
    expect(text).toContain('apps/api/src/http/a.ts');
    expect(body(pageOf())).toContain('mark drafted');
  });

  it('lists one row for each caller: who, at which part, how', () => {
    expect(textOf(pageOf())).toContain('web http REST /v1, a session cookie');
  });
});

describe('The services page\'s Design tab draws the services and the calls allowed between them', () => {
  const map = {
    clients: [{ id: 'people', name: 'People', sub: 'a browser' }],
    boxes: [
      { id: 'harness-monitor', name: 'Harness Monitor', short: 'Monitor', file: 'service-harness-monitor.html', off: 0, share: 0.4, items: [[{ name: 'Routes', sub: '', kind: 'component', href: null }]] },
      { id: 'cockpit', name: 'Cockpit', short: 'Cockpit', file: 'service-cockpit.html', off: 2, share: 0.6, items: [[{ name: 'API layer', sub: '', kind: 'component', href: null }]] },
    ],
    calls: [{ from: 'people', to: 'cockpit', how: 'web app', state: 'declared' }, { from: 'harness-monitor', to: 'cockpit', how: 'its API', state: 'found', files: [], at: {} }],
    outside: [],
    reaches: [],
    cross: { imports: [], shared: [] },
    between: [
      { rule: 'The Monitor shares no code with Cockpit', from: null, to: null, reason: 'It is meant to be lifted out.', agreed: true },
      { rule: 'The Monitor reads Cockpit only through its API', from: 'harness-monitor', to: 'cockpit', reason: 'The copy holds no user data.', source: 'The Harness Monitor', agreed: false },
    ],
  };
  const html = renderServicesDesignPage({ serviceMap: map, drawnFrom, services: [], deployments: [] });

  it('draws one numbered arrow and one card for the call between two services, and a dotted card for a rule about all of them', () => {
    expect(numbers(html, /<text class="nl-num-t[^>]*>(\d+)<\/text>/g)).toEqual([1]);
    expect(numbers(html, /<div class="rule" id="rule-(\d+)"/g)).toEqual([1]);
    const text = textOf(html);
    expect(text).toContain('Harness Monitor calls Cockpit, and nothing else.');
    expect(text).toContain('The Monitor reads Cockpit only through its API');
    expect(text).toContain('Between every pair of services');
    expect(text).toContain('The Monitor shares no code with Cockpit');
    expect(text).toContain('2 rules, 1 agreed, 1 drafted, 0 questions');
  });

  it('shows how the people outside reach a service, and opens each service on its Design tab', () => {
    expect(textOf(html)).toContain('People Cockpit web app');
    expect(html).toContain('<a href="service-cockpit-design.html"><text class="nb-t link"');
  });
});

describe('The services page and every service open on Design, with tabs Design, Logical and Deployment', () => {
  const model = { ...modelOf(), deployments: [{ service: 'cockpit' }] };

  it('puts Design first and marks it as the page shown, with Deployment only where the service has one', () => {
    expect(renderDesignPage(model, {})).toContain('<nav class="switch"><span class="on">Design</span><a href="service-cockpit.html">Logical</a><a href="service-cockpit-deployment.html">Deployment</a></nav>');
    expect(renderDesignPage(modelOf(), {})).toContain('<nav class="switch"><span class="on">Design</span><a href="service-cockpit.html">Logical</a></nav>');
  });

  it('links Design from the Logical tab, which no longer carries the design table', () => {
    const html = renderLogicalPage(model, {});
    expect(html).toContain('<nav class="switch"><a href="service-cockpit-design.html">Design</a><span class="on">Logical</span><a href="service-cockpit-deployment.html">Deployment</a></nav>');
    expect(html).not.toContain('The design it is compared against');
  });

  it('writes a Design page for the services page and for each service', () => {
    const pages = renderDesignPages({ ...model, services: [], serviceMap: null });
    expect(Object.keys(pages)).toEqual(['service-cockpit-design.html']);
  });
});

describe('A reason holding markup is shown as written, never as markup', () => {
  it('escapes <, & and quotes in a reason, a source, a question and a rule', () => {
    const nasty = '<script>alert("x")</script> & \'q\'';
    const html = pageOf({
      reasons: { 'clients>api': { reason: nasty, source: nasty, agreed: false }, 'api>logic': { question: nasty, agreed: false }, 'logic>data': DRAFTED, 'logic>outside': DRAFTED },
      rules: [{ rule: nasty, reason: nasty, agreed: false }],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp;');
  });
});
