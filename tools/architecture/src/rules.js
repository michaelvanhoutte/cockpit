/**
 * The rules file (`docs/architecture.yml`), read: the services, the calls between them, and for each service what the
 * report draws as its design (layers and their parts, what each layer may call, what is not allowed, the accepted
 * deviations, who reaches it). CI's import check reads the same file for the rules it enforces; this reader is the
 * tool's own, since the nightly run installs the tool alone and imports nothing from the root `scripts/`.
 *
 * Pure: it is handed the file's text. A file that does not parse, or lacks what the report is drawn from, is a
 * ReadError naming the file and the line, which fails the run like any other file the generator needs.
 */

import { parseDocument } from 'yaml';

import { ReadError } from './errors.js';

export const RULES_FILE = 'docs/architecture.yml';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The words a rule carries: why it exists or the question where no reason is written, where the reason was read, and whether the engineer agreed it. */
const noteOf = (each, string, where) => {
  const entry = isObject(each) ? each : {};
  return {
    ...(entry.reason === undefined ? {} : { reason: string(entry.reason, `${where}.reason`) }),
    ...(entry.question === undefined ? {} : { question: string(entry.question, `${where}.question`) }),
    ...(entry.source === undefined ? {} : { source: string(entry.source, `${where}.source`) }),
    agreed: entry.agreed === true,
  };
};

/** @returns {object} the rules file's contents, checked and normalised */
export function parseRules(file, text) {
  const fail = (reason) => {
    throw new ReadError(file, reason);
  };
  const document = parseDocument(text);
  if (document.errors.length > 0) {
    const error = document.errors[0];
    const line = error.linePos?.[0]?.line;
    fail(`not valid YAML${line ? ` at line ${line}` : ''} (${error.message.split('\n')[0]})`);
  }
  const value = document.toJS();
  const object = (each, where) => (isObject(each) ? each : fail(`${where} must be a mapping`));
  const array = (each, where) => (Array.isArray(each) ? each : fail(`${where} must be a list`));
  const string = (each, where) => (typeof each === 'string' && each.trim() !== '' ? each.trim() : fail(`${where} must be a non-empty string`));
  const folders = (each, where) => (each === undefined ? [] : (Array.isArray(each) ? each : [each]).map((one, at) => string(one, `${where}[${at}]`).replace(/\/+$/, '')));
  object(value, 'the file');

  const services = {};
  for (const [id, each] of Object.entries(value.services === undefined ? {} : object(value.services, 'services'))) {
    object(each, `services.${id}`);
    services[id] = { name: string(each.name, `services.${id}.name`), what: each.what === undefined ? '' : string(each.what, `services.${id}.what`), code: folders(each.code, `services.${id}.code`) };
  }

  const between = (value['between services'] === undefined ? [] : array(value['between services'], 'between services')).map((each, index) => {
    const where = `between services[${index}]`;
    object(each, where);
    const from = each.from === undefined ? null : string(each.from, `${where}.from`);
    const to = each.to === undefined ? null : string(each.to, `${where}.to`);
    return { rule: string(each.rule, `${where}.rule`), from, to, ...noteOf(each, string, where) };
  });

  const reachedBy = (list, where) => (list === undefined ? [] : array(list, where)).map((each, index) => {
    const here = `${where}[${index}]`;
    object(each, here);
    return { caller: string(each.caller, `${here}.caller`), at: string(each.at, `${here}.at`), how: string(each.how, `${here}.how`) };
  });

  const sections = {};
  for (const [id, each] of Object.entries(value)) {
    if (id === 'services' || id === 'between services' || !isObject(each)) continue;
    const section = { reachedBy: reachedBy(each['reached by'], `${id}.reached by`), calls: null, callNotes: {}, layers: null, rules: [], accepted: [], sources: [] };

    if (each.layers !== undefined) {
      section.layers = Object.entries(object(each.layers, `${id}.layers`)).map(([layerId, layer]) => {
        const where = `${id}.layers.${layerId}`;
        object(layer, where);
        const parts = Object.entries(layer.parts === undefined ? {} : object(layer.parts, `${where}.parts`)).map(([partId, part]) => {
          object(part, `${where}.parts.${partId}`);
          return { id: partId, name: string(part.name, `${where}.parts.${partId}.name`), what: part.what === undefined ? '' : string(part.what, `${where}.parts.${partId}.what`), code: folders(part.code, `${where}.parts.${partId}.code`), store: part.store === true };
        });
        const callEntries = layer.calls === undefined ? {} : object(layer.calls, `${where}.calls`);
        const calls = Object.keys(callEntries);
        const callNotes = Object.fromEntries(calls.map((to) => [to, noteOf(callEntries[to], string, `${where}.calls.${to}`)]));
        const notAllowed = {};
        for (const [to, sentence] of Object.entries(layer['not allowed'] === undefined ? {} : object(layer['not allowed'], `${where}.not allowed`))) notAllowed[to] = string(sentence, `${where}.not allowed.${to}`);
        return { id: layerId, name: string(layer.name, `${where}.name`), parts, calls, callNotes, notAllowed };
      });
      if (section.layers.length === 0) fail(`${id}.layers must hold at least one layer`);
    }

    // What a service that is not ruled inside keeps: the calls it may make, by the name of what it calls.
    if (each.calls !== undefined) {
      const entries = object(each.calls, `${id}.calls`);
      section.calls = Object.keys(entries);
      section.callNotes = Object.fromEntries(section.calls.map((to) => [to, noteOf(entries[to], string, `${id}.calls.${to}`)]));
    }

    // The rules inside and across the layers: each says what it is and carries its words; how CI checks it is not the report's.
    section.rules = (each.rules === undefined ? [] : array(each.rules, `${id}.rules`)).map((one, index) => {
      object(one, `${id}.rules[${index}]`);
      return { rule: string(one.rule, `${id}.rules[${index}].rule`), ...(one.check === undefined ? {} : { check: string(one.check, `${id}.rules[${index}].check`) }), ...noteOf(one, string, `${id}.rules[${index}]`) };
    });

    section.accepted = (each.accepted === undefined ? [] : array(each.accepted, `${id}.accepted`)).map((one, index) => {
      const where = `${id}.accepted[${index}]`;
      object(one, where);
      return { from: string(one.from, `${where}.from`), to: string(one.to, `${where}.to`), files: array(one.files, `${where}.files`).map((entry, at) => string(entry, `${where}.files[${at}]`)), reason: string(one.reason, `${where}.reason`), ...(one.source === undefined ? {} : { source: string(one.source, `${where}.source`) }), agreed: one.agreed === true };
    });

    // Calls the rules do not allow and nobody accepted, tolerated by CI until fixed: the report still draws them red.
    section.knownBreaches = (each['known breaches'] === undefined ? [] : array(each['known breaches'], `${id}.known breaches`)).map((one, index) => {
      const where = `${id}.known breaches[${index}]`;
      object(one, where);
      return { from: string(one.from, `${where}.from`), to: string(one.to, `${where}.to`), files: array(one.files, `${where}.files`).map((entry, at) => string(entry, `${where}.files[${at}]`)), ...noteOf(one, string, where) };
    });

    if (each.sources !== undefined) section.sources = Object.keys(object(each.sources, `${id}.sources`));
    sections[id] = section;
  }

  return { file, services, between, sections };
}
