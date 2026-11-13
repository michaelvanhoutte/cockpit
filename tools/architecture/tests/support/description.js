/**
 * A drawing file and a rules file in the real ones' shape, small enough to read at a glance; a test overrides what it is about.
 *
 * A test writes the design in one piece (`design`, `otherServices`, `serviceMap`, with the layers, calls and acceptances
 * together) and this splits it the way the repository does: what is drawn goes to the description file, what the design
 * is goes to the rules file. So a test goes through the same join the run does.
 */
import { stringify } from 'yaml';

import { parseDescription } from '../../src/description.js';
import { parseRules } from '../../src/rules.js';

const callerName = (caller) => caller.caller ?? `${caller.from}>${caller.to}`;

/** The rules a design written in one piece holds: its layers and parts, calls, sentences, acceptances and the way it is reached. */
function cockpitRules(design) {
  const layers = {};
  for (const layer of design.layers ?? []) {
    const parts = {};
    for (const chip of layer.items.flat()) if (chip.caller === undefined) parts[chip.id] = { name: chip.name ?? chip.id };
    const calls = Object.fromEntries((design.mayCall?.[layer.id] ?? []).map((to) => [to, design.reasons?.[`${layer.id}>${to}`] ?? { reason: 'r', agreed: false }]));
    const notAllowed = Object.fromEntries(Object.entries(design.breaks ?? {}).filter(([pair]) => pair.startsWith(`${layer.id}>`)).map(([pair, text]) => [pair.split('>')[1], text]));
    layers[layer.id] = { name: layer.title, parts, ...(Object.keys(calls).length > 0 ? { calls } : {}), ...(Object.keys(notAllowed).length > 0 ? { 'not allowed': notAllowed } : {}) };
  }
  return {
    'reached by': (design.callers ?? []).map((caller) => ({ caller: callerName(caller), at: caller.to, how: caller.how })),
    layers,
    ...(design.rules ? { rules: design.rules } : {}),
    ...(design.accepted ? { accepted: design.accepted } : {}),
    ...(design.knownBreaches ? { 'known breaches': design.knownBreaches } : {}),
  };
}

/** The drawing a design written in one piece keeps: everything but the rules, its callers reduced to where each is looked for. */
function drawnDesign(design, { withNames }) {
  const { mayCall: _mayCall, breaks: _breaks, accepted: _accepted, knownBreaches: _knownBreaches, reasons: _reasons, rules: _rules, ...drawn } = design;
  return { ...drawn, callers: (design.callers ?? []).map((caller) => ({ ...(withNames ? { caller: callerName(caller) } : { ...(caller.how ? { how: caller.how } : {}), to: caller.to }), from: caller.from, ...(caller.code ? { code: caller.code } : {}) })) };
}

/** What a service the rules do not rule inside keeps: what its service layer may call, if it has one. */
function serviceRules(service) {
  const own = service.design.layers.find((layer) => layer.kind === 'service');
  return {
    ...(own ? { calls: Object.fromEntries((service.design.mayCall?.[own.id] ?? []).map((to) => [to, service.design.reasons?.[`${own.id}>${to}`] ?? { reason: 'r', agreed: false }])) } : {}),
    ...(service.design.rules ? { rules: service.design.rules } : {}),
    ...(service.design.accepted ? { accepted: service.design.accepted } : {}),
  };
}

/** The two files a test describes: `{ drawing, rules }`. */
export function filesOf(overrides = {}) {
  const { design, otherServices, serviceMap, ...rest } = overrides;
  const drawing = {
    discover: [
      { path: 'apps/web/src', as: 'one', role: 'core' },
      { path: 'apps/api/src', as: 'folders', rootFiles: true, role: 'core' },
      { path: 'packages', as: 'packages', role: 'core' },
      { path: 'packages/connectors', as: 'packages', role: 'connector' },
    ],
    scan: { extensions: ['.ts', '.tsx'], tests: '(^|/)(tests?|__tests__)/|\.(test|spec)\.tsx?$', ignore: ['node_modules'] },
    sources: [
      { id: 'gmail', name: 'Gmail', words: ['gmail'] },
      { id: 'claude-code', name: 'Claude Code', words: ['claude code'] },
    ],
    connectorRule: { sdk: '@cockpit/connector-sdk', scope: '@cockpit/' },
    context: { cockpit: { name: 'Cockpit', summary: 'Unified inbox and dashboards.' }, people: [], services: [] },
    layers: [],
    ...rest,
  };
  const rules = { services: {}, 'between services': [] };

  if (design) {
    drawing.design = drawnDesign(design, { withNames: true });
    rules.cockpit = cockpitRules(design);
  }
  if (otherServices) {
    drawing.otherServices = otherServices.map((service) => ({ ...service, design: drawnDesign(service.design, { withNames: false }) }));
    for (const service of otherServices) rules[service.id] = serviceRules(service);
  }
  if (serviceMap) {
    const names = { cockpit: 'Cockpit', ...Object.fromEntries((otherServices ?? []).map((service) => [service.id, service.name])) };
    const ids = serviceMap.services.map((each) => each.id);
    drawing.serviceMap = { ...serviceMap, owns: Object.fromEntries(Object.entries(serviceMap.owns).map(([id, own]) => [id, { packages: own.packages }])) };
    for (const [id, own] of Object.entries(serviceMap.owns)) rules.services[id] = { name: names[id] ?? id, code: own.folders };
    rules['between services'] = serviceMap.calls.filter((call) => ids.includes(call.from) && ids.includes(call.to)).map((call) => ({ rule: 'r', from: call.from, to: call.to, ...(serviceMap.reasons?.[`${call.from}>${call.to}`] ?? {}) })).concat(serviceMap.between ?? []);
  }
  return { drawing, rules };
}

export const description = (overrides) => filesOf(overrides).drawing;

/** The drawing file as the generator is handed it. */
export const descriptionFile = (overrides) => ({ file: 'tools/architecture/description.yml', text: stringify(description(overrides)) });

/** The rules file as the generator is handed it. */
export const rulesFile = (overrides) => ({ file: 'docs/architecture.yml', text: stringify(filesOf(overrides).rules) });

/** Both files, read together the way a run reads them. */
export const readDescription = (overrides, name = 'd.yml') => parseDescription(name, descriptionFile(overrides).text, parseRules(rulesFile(overrides).file, rulesFile(overrides).text));
