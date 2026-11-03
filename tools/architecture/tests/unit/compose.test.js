import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { parseDescription } from '../../src/description.js';
import { ReadError } from '../../src/errors.js';
import { buildLogical } from '../../src/logical.js';
import { parseRules } from '../../src/rules.js';
import { description as baseDrawing } from '../support/description.js';

/** The drawing and the rules of a small Cockpit, written apart as the repository keeps them; a test changes the one it is about. */
const drawing = () => ({
  layers: [
    { id: 'clients', kind: 'clients', row: 0, items: [[{ id: 'web' }, { id: 'agents', caller: 'MCP clients', name: 'MCP clients', kind: 'client' }]] },
    { id: 'api', row: 1, items: [[{ id: 'http' }]] },
    { id: 'data', row: 2, items: [[{ id: 'register', marker: '\\benv\\.DB\\b', how: 'SQL' }]] },
  ],
  callers: [{ caller: 'Web app', from: 'web' }, { caller: 'MCP clients', from: 'agents' }],
  noLine: [],
});
const rules = () => ({
  services: {},
  cockpit: {
    'reached by': [{ caller: 'Web app', at: 'http', how: 'REST' }, { caller: 'MCP clients', at: 'http', how: 'MCP over HTTP' }],
    layers: {
      clients: { name: 'Clients', parts: { web: { name: 'Web app', what: 'React', code: 'apps/web/src' } }, calls: { api: { reason: 'r' } } },
      api: { name: 'API layer', parts: { http: { name: 'Application API', code: 'apps/api/src/http' } }, calls: { data: { reason: 'r' } }, 'not allowed': { clients: 'The API layer depends on a client' } },
      data: { name: 'Data', parts: { register: { name: 'Register', what: 'D1', code: 'apps/api/src/db', store: true } } },
    },
  },
});

const read = ({ draw = drawing(), rule = rules() } = {}) => {
  const base = baseDrawing({});
  return parseDescription('d.yml', stringify({ ...base, design: draw }), parseRules('r.yml', stringify(rule)));
};
const folder = (path, files) => ({ path, package: false, packageName: null, role: 'core', files: Object.entries(files).map(([file, text]) => ({ file: `${path}/${file}`, text })) });
const logicalOf = (design, files = {}) => buildLogical({ design, scan: { extensions: ['.ts'] }, candidates: [folder('apps/web/src', files.web ?? {}), folder('apps/api/src/http', files.http ?? {}), folder('apps/api/src/db', files.db ?? {})] });

describe('A part is named by the rules file and placed by the drawing file, with the same id', () => {
  it('reads the parts name, description and folders from the rules, and where it sits from the drawing', () => {
    const { design } = read();
    const register = design.layers[2].items[0][0];
    expect(register).toMatchObject({ id: 'register', name: 'Register', sub: 'D1', kind: 'store', folders: ['apps/api/src/db'], marker: '\\benv\\.DB\\b', how: 'SQL' });
    expect(design.layers.map((layer) => layer.title)).toEqual(['Clients', 'API layer', 'Data']);
  });

  it.each([
    {
      situation: 'a part in the rules has no position in the drawing',
      change: (rule, draw) => { rule.cockpit.layers.api.parts.jobs = { name: 'Jobs' }; return [rule, draw]; },
      message: 'the rules file has the part jobs in the layer api, which design.layers has no chip for',
    },
    {
      situation: 'the drawing positions a part the rules do not have',
      change: (rule, draw) => { draw.layers[1].items[0].push({ id: 'ghost' }); return [rule, draw]; },
      message: 'design layer api has the chip ghost, which the rules file has no part for',
    },
    {
      situation: 'a layer in the rules is not drawn',
      change: (rule, draw) => { rule.cockpit.layers.conn = { name: 'Connectors', parts: {} }; return [rule, draw]; },
      message: 'the rules file has the layer conn, which design.layers does not place',
    },
    {
      situation: 'a layer in the drawing is not in the rules',
      change: (rule, draw) => { draw.layers.push({ id: 'extra', row: 3, items: [[{ id: 'x' }]] }); return [rule, draw]; },
      message: 'design.layers has the layer extra, which the rules file does not have',
    },
    {
      situation: 'the rules say a caller reaches Cockpit and the drawing does not look for it',
      change: (rule, draw) => { rule.cockpit['reached by'].push({ caller: 'Mail senders', at: 'http', how: 'mail' }); return [rule, draw]; },
      message: 'the rules file says Mail senders reaches it, and design.callers has no caller of that name',
    },
    {
      situation: 'the drawing looks for a caller the rules do not have',
      change: (rule, draw) => { draw.callers.push({ caller: 'Ghost', from: 'web' }); return [rule, draw]; },
      message: 'design.callers has the caller Ghost',
    },
  ])('fails the run, naming it, when $situation', ({ change, message }) => {
    const [rule, draw] = change(rules(), drawing());
    expect(() => read({ rule, draw })).toThrow(ReadError);
    expect(() => read({ rule, draw })).toThrow(message);
  });

  it('fails the run, naming the file to give, when the drawing needs the rules and none are given', () => {
    expect(() => parseDescription('d.yml', stringify({ ...baseDrawing({}), design: drawing() }))).toThrow('the rules file docs/architecture.yml was not given');
  });
});

describe('Cockpit\'s lines are judged by what the rules file allows', () => {
  it('draws a call the rules allow grey', () => {
    const logical = logicalOf(read().design, { http: { 'a.ts': 'await env.DB.prepare(q);' } });
    expect(logical.bad).toEqual([]);
    expect(logical.ok.map((each) => [each.a, each.b])).toEqual([['api', 'data']]);
  });

  it('draws a call a layer\'s `not allowed` names red, with the sentence the rules give', () => {
    const logical = logicalOf(read().design, { http: { 'a.ts': "import '../../../web/src/x.js';" } });
    expect(logical.bad.map((each) => [each.from, each.to, each.why])).toEqual([['http', 'web', 'The API layer depends on a client']]);
  });

  it('draws a call no rule allows or names red, with a sentence of its own', () => {
    const logical = logicalOf(read().design, { web: { 'w.ts': "import '../../api/src/db/x.js';" }, db: { 'x.ts': '' } });
    expect(logical.bad.map((each) => [each.from, each.to, each.why])).toEqual([['web', 'register', 'Clients → Data: not a line the design draws']]);
  });

  it('accepts an accepted call from the files it names, and keeps it red from any other file', () => {
    const rule = rules();
    rule.cockpit.layers.api.calls = {};
    rule.cockpit.accepted = [{ from: 'http', to: 'register', files: ['apps/api/src/http/a.ts'], reason: 'Because.' }];
    const { design } = read({ rule });
    expect(logicalOf(design, { http: { 'a.ts': 'await env.DB.prepare(q);' } }).accepted.map((each) => each.accepted.reason)).toEqual(['Because.']);
    const other = logicalOf(design, { http: { 'a.ts': 'await env.DB.prepare(q);', 'b.ts': 'await env.DB.prepare(q);' } });
    expect(other.accepted).toEqual([]);
    expect(other.bad[0].newFiles).toEqual(['apps/api/src/http/b.ts']);
  });

  it('draws a caller the rules say reaches it as a caller, never as a break', () => {
    const logical = logicalOf(read().design, { web: { 'w.ts': 'fetch("/v1/items");' } });
    expect(logical.bad).toEqual([]);
    expect(logical.callers.map((caller) => [caller.from, caller.to, caller.how, caller.status])).toEqual([['web', 'http', 'REST', 'elsewhere'], ['agents', 'http', 'MCP over HTTP', 'elsewhere']]);
  });
});

describe('A service the rules do not rule inside is drawn by its boundary', () => {
  const SRC = 'apps/svc/src';
  const patterned = (id, files, extra = {}) => ({ id, name: id, in: SRC, files, ...extra });
  const monitor = () => ({
    id: 'harness-monitor',
    name: 'Harness Monitor',
    design: {
      layers: [
        { id: 'clients', title: 'Clients', kind: 'clients', row: 0, items: [[{ id: 'hook', name: 'Hook', kind: 'client' }]] },
        { id: 'routes', title: 'Routes', row: 1, items: [[patterned('entry', ['worker.*'])]] },
        { id: 'reports', title: 'Reports', row: 2, items: [[patterned('cycle', ['cycle*'])]] },
        { id: 'data', title: 'Data', row: 3, items: [[{ id: 'mdb', name: 'db', kind: 'store', marker: '\\.prepare\\(', how: 'SQL' }]] },
      ],
      callers: [{ caller: 'Claude Code sessions', from: 'hook', to: 'entry' }],
      noLine: [],
    },
  });
  const monitorRules = (extra = {}) => ({ services: {}, 'harness-monitor': { 'reached by': [{ caller: 'Claude Code sessions', at: 'routes', how: 'POST /v1/usage, the write key' }], ...extra } });
  const compose = (service = monitor(), rule = monitorRules()) => parseDescription('d.yml', stringify({ ...baseDrawing({}), otherServices: [service] }), parseRules('r.yml', stringify(rule))).otherServices[0];
  const run = (files) => buildLogical({ design: compose().design, scan: { extensions: ['.ts'] }, candidates: [], designFiles: { [SRC]: Object.entries(files).map(([name, text]) => ({ file: `${SRC}/${name}`, text })) } });

  it('draws a report importing a route grey, not red', () => {
    const logical = run({ 'worker.ts': '', 'cycle-time.ts': "import { x } from './worker.js';\ndb.prepare(q);" });
    expect(logical.bad).toEqual([]);
    expect(logical.ok.map((each) => [each.a, each.b]).sort()).toEqual([['reports', 'data'], ['reports', 'routes']]);
    expect(logical.miss).toEqual([]);
  });

  it('draws each caller at the routes, with the words the rules give', () => {
    const [caller] = run({ 'worker.ts': '', 'cycle-time.ts': '' }).callers;
    expect(caller).toMatchObject({ from: 'hook', to: 'entry', how: 'POST /v1/usage, the write key' });
  });

  it('fails, naming it, when the rules say a caller reaches it at a part the drawing draws it at another', () => {
    const rule = monitorRules({ 'reached by': [{ caller: 'Claude Code sessions', at: 'reports', how: 'x' }] });
    expect(() => compose(monitor(), rule)).toThrow('reaches harness-monitor at reports, and the drawing draws it at entry');
  });

  it('draws the widget by its two calls, to Cockpit and the phone', () => {
    const widget = {
      id: 'android-widget',
      name: 'Android widget',
      design: {
        layers: [
          { id: 'widget', title: 'Android widget', kind: 'service', row: 0, items: [[patterned('ui', ['A.kt'])]] },
          { id: 'cockpit', title: 'Cockpit', kind: 'context', row: 1, items: [[{ id: 'ctx', name: 'API', folders: ['apps/api/src/mcp'] }]] },
          { id: 'phone', title: 'Phone', kind: 'outside', alignedWith: 'widget', items: [[{ id: 'browser', name: 'Browser', kind: 'outside' }]] },
        ],
        callers: [],
        noLine: [],
      },
    };
    const calls = { services: {}, 'android-widget': { calls: { cockpit: { reason: 'r' }, phone: { reason: 'r' } } } };
    expect(compose(widget, calls).design.mayCall).toEqual([['widget', 'cockpit'], ['widget', 'phone']]);
    expect(compose(widget, calls).design.unruled).toBe(false);
    expect(() => compose(widget, { services: {}, 'android-widget': { calls: { cockpit: { reason: 'r' } } } })).toThrow('places phone, which the rules file does not say android-widget calls');
  });
});
