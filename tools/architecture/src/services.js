/**
 * What the services page and each service's Deployment tab are drawn from, as data. Two sections of the
 * description file are read here, `deployments` and `serviceMap`, and two things are built from them and from what
 * the rest of the model already holds: each service's environments, one column each (the report's own reading of
 * a Worker config, never a second one), and the services page (who uses each service, how they reach each other,
 * the check that none imports another's code or shares its store, and the badge of lines off the design).
 *
 * Pure: it is handed the file texts and the model's own pieces, and reads nothing itself.
 */

import path from 'node:path';

import { codeOf, importsOf } from './scan.js';

const STORE_KINDS = new Set(['D1 database', 'Durable Object', 'R2 bucket', 'KV namespace']);
const QUEUE_KINDS = new Set(['Queue, producer', 'Queue, consumer']);
/** A name that holds a secret: its value is never drawn, only that it exists. */
export const SECRET_NAME = /SECRET|TOKEN|KEY|SID|PASSWORD/;

const uniq = (list) => [...new Set(list)];
const HTML = /^[a-z0-9][a-z0-9.-]*\.html$/;

// ---- reading the two sections

/**
 * `deployments`: for each service, how its environments are found. A Worker names its config (and the file that
 * declares its bindings, where the names of its secrets are read from); a service that is not a Worker lists its
 * environments by hand. `shippedBy` names, for an environment, the workflows that ship it where the report's own
 * reading of the workflows would credit the wrong ones.
 */
export function parseDeployments(value, { fail, object, array, string }, knownServices) {
  if (value === undefined) return [];
  const seen = new Set();
  return array(value, 'deployments').map((each, index) => {
    const where = `deployments[${index}]`;
    object(each, where);
    const service = string(each.service, `${where}.service`);
    if (!knownServices.includes(service)) fail(`${where}.service ${service} is not a service the file describes`);
    if (seen.has(service)) fail(`${where}.service ${service} is described twice`);
    seen.add(service);
    const text = (name) => (each[name] === undefined ? null : string(each[name], `${where}.${name}`));
    const config = text('config');
    if ((config === null) === (each.environments === undefined)) fail(`${where} names either a Worker \`config\` or its \`environments\` by hand, not both and not neither`);
    const shippedBy = {};
    if (each.shippedBy !== undefined) for (const [name, file] of Object.entries(object(each.shippedBy, `${where}.shippedBy`))) shippedBy[name] = (Array.isArray(file) ? file : [file]).map((one, at) => string(one, `${where}.shippedBy.${name}[${at}]`));
    const environments = each.environments === undefined ? null : array(each.environments, `${where}.environments`).map((env, at) => {
      const here = `${where}.environments[${at}]`;
      object(env, here);
      const workflow = env.workflow === undefined ? null : string(env.workflow, `${here}.workflow`);
      const by = env.by === undefined ? null : string(env.by, `${here}.by`);
      if ((workflow === null) === (by === null)) fail(`${here} says what ships it with either \`workflow\` or \`by\`, not both and not neither`);
      return {
        name: string(env.name, `${here}.name`),
        runsOn: string(env.runsOn, `${here}.runsOn`),
        workflow,
        by,
        settings: env.settings === undefined ? [] : Object.entries(object(env.settings, `${here}.settings`)).map(([key, one]) => [key, string(one, `${here}.settings.${key}`)]),
        secretsFrom: env.secretsFrom === undefined ? null : string(env.secretsFrom, `${here}.secretsFrom`),
        storage: env.storage === undefined ? [] : array(env.storage, `${here}.storage`).map((one, to) => ({ kind: string(object(one, `${here}.storage[${to}]`).kind, `${here}.storage[${to}].kind`), name: string(one.name, `${here}.storage[${to}].name`) })),
      };
    });
    return { service, intro: text('intro') ?? '', config, bindings: text('bindings'), shippedBy, environments };
  });
}

/**
 * `serviceMap`: the services page, written by hand. `clients` are who uses the services, `services` the box each is
 * drawn as (rows of chips, each with the page it opens), `calls` the lines between them, and `owns` the code each
 * service is made of, which the check that none imports another's is made against.
 */
export function parseServiceMap(value, { fail, object, array, string }, knownServices) {
  if (value === undefined) return null;
  object(value, 'serviceMap');
  const ids = new Set();
  const clients = array(value.clients, 'serviceMap.clients').map((each, index) => {
    const where = `serviceMap.clients[${index}]`;
    object(each, where);
    const id = string(each.id, `${where}.id`);
    if (ids.has(id) || knownServices.includes(id)) fail(`${where}.id ${id} is used twice`);
    ids.add(id);
    return { id, name: string(each.name, `${where}.name`), sub: each.sub === undefined ? '' : string(each.sub, `${where}.sub`) };
  });
  const services = array(value.services, 'serviceMap.services').map((each, index) => {
    const where = `serviceMap.services[${index}]`;
    object(each, where);
    const id = string(each.id, `${where}.id`);
    if (!knownServices.includes(id)) fail(`${where}.id ${id} is not a service the file describes`);
    const short = each.short === undefined ? null : string(each.short, `${where}.short`);
    const share = each.share === undefined ? null : typeof each.share === 'number' && each.share > 0 && each.share < 1 ? each.share : fail(`${where}.share must be a number above 0 and below 1`);
    const items = array(each.items, `${where}.items`).map((row, at) =>
      array(row, `${where}.items[${at}]`).map((chip, to) => {
        const here = `${where}.items[${at}][${to}]`;
        object(chip, here);
        const kind = chip.kind === undefined ? 'component' : ['component', 'store'].includes(chip.kind) ? chip.kind : fail(`${here}.kind must be component or store`);
        const href = chip.href === undefined ? null : HTML.test(String(chip.href)) ? chip.href : fail(`${here}.href must be the file name of a page beside this one`);
        return { name: string(chip.name, `${here}.name`), sub: chip.sub === undefined ? '' : string(chip.sub, `${here}.sub`), kind, href };
      }),
    );
    return { id, short, share, items };
  });
  const lineable = new Set([...ids, ...services.map((each) => each.id)]);
  const calls = array(value.calls, 'serviceMap.calls').map((each, index) => {
    const where = `serviceMap.calls[${index}]`;
    object(each, where);
    const from = string(each.from, `${where}.from`);
    const to = string(each.to, `${where}.to`);
    for (const end of [from, to]) if (!lineable.has(end)) fail(`${where} names ${end}, which is no client or service of serviceMap`);
    return { from, to, how: string(each.how, `${where}.how`), foundBy: each.foundBy === undefined ? null : string(each.foundBy, `${where}.foundBy`) };
  });
  const owns = {};
  for (const [id, own] of Object.entries(object(value.owns, 'serviceMap.owns'))) {
    if (!knownServices.includes(id)) fail(`serviceMap.owns names ${id}, which is not a service the file describes`);
    object(own, `serviceMap.owns.${id}`);
    owns[id] = {
      folders: array(own.folders, `serviceMap.owns.${id}.folders`).map((folder, at) => string(folder, `serviceMap.owns.${id}.folders[${at}]`).replace(/\/+$/, '')),
      packages: own.packages === undefined ? [] : array(own.packages, `serviceMap.owns.${id}.packages`).map((prefix, at) => string(prefix, `serviceMap.owns.${id}.packages[${at}]`)),
    };
  }
  // The rules between services, with their words, kept for the Design tab; the rules file is where they are written.
  const between = Array.isArray(value.between) ? value.between : [];
  return { clients, services, calls, owns, between };
}

// ---- each service's environments

/** The names a file declares as `NAME?: string`, in order: the bindings type of a Worker, whose secrets are among them. */
const declaredNames = (text) => [...text.matchAll(/^\s+([A-Z][A-Z0-9_]*)\??:\s*string\b/gm)].map((each) => each[1]);

/** The secret names a workflow reads, as `secrets.NAME`; the token every run is given is not one of ours. */
const secretsIn = (text) => uniq([...text.matchAll(/secrets\.([A-Z_0-9]+)/g)].map((each) => each[1]).filter((name) => name !== 'GITHUB_TOKEN'));

/**
 * Every service's environments. A Worker's come from the report's own reading of its config (`parseConfig`,
 * `environmentsOf`); what ships an environment is the workflows the report's own reading of them credits with
 * deploying it, unless the description names them. Secrets are names, never values.
 * @param {{ entries: object[], files: Record<string, string|null>, workflows: { file: string, text: string }[], read: { file: string, starts: { text: string }[] }[], deployedBy: (environment: string) => string[] }} input
 * @param {{ parseConfig: Function, environmentsOf: Function }} reading
 */
export function buildDeployments({ entries, files, workflows, read, deployedBy }, { parseConfig, environmentsOf }) {
  const starts = (file) => read.find((workflow) => workflow.file === file)?.starts.map((each) => each.text).join(', ') ?? '';
  const textOf = (file) => workflows.find((workflow) => workflow.file === file)?.text ?? '';
  const shipped = (file) => ({ file, starts: starts(file) });
  const out = [];
  for (const entry of entries) {
    if (entry.environments) {
      out.push({
        service: entry.service,
        intro: entry.intro,
        source: null,
        environments: entry.environments.map((env) => ({
          name: env.name,
          where: env.runsOn,
          shippedBy: env.workflow ? [shipped(env.workflow)] : [{ text: env.by }],
          settings: env.settings,
          secrets: env.secretsFrom ? secretsIn(textOf(env.secretsFrom)) : [],
          stores: env.storage.map((each) => ({ kind: each.kind, binding: null, name: each.name })),
          queues: [],
          other: [],
        })),
      });
      continue;
    }
    // An earlier commit drawn for What changed may predate a config: its service is left out, not guessed at.
    const text = files[entry.config];
    if (text == null) continue;
    const parsed = parseConfig(entry.config, text);
    const names = declaredNames(files[entry.bindings] ?? '');
    out.push({
      service: entry.service,
      intro: entry.intro,
      source: entry.config,
      environments: environmentsOf(parsed).map((env) => {
        const own = env.name === 'production' ? parsed : parsed.env?.[env.name] ?? {};
        const vars = own.vars ?? {};
        const local = env.name === 'local';
        return {
          name: env.name,
          where: local ? 'your machine, pnpm dev' : `Cloudflare Worker ${env.worker}`,
          shippedBy: local ? [{ text: 'pnpm dev' }] : (entry.shippedBy[env.name] ?? deployedBy(env.name)).map(shipped),
          // A setting is not a secret, but one named like one never shows its value.
          settings: [['compatibility date', own.compatibility_date ?? parsed.compatibility_date], ...Object.entries(vars).map(([key, value]) => [key, value === '' ? '(empty)' : SECRET_NAME.test(key) ? '(set)' : String(value)])].filter(([, value]) => value),
          secrets: local ? [] : names.filter((name) => SECRET_NAME.test(name) && !(name in vars)),
          stores: env.resources.filter((each) => STORE_KINDS.has(each.kind)),
          queues: env.resources.filter((each) => QUEUE_KINDS.has(each.kind)),
          other: env.resources.filter((each) => !STORE_KINDS.has(each.kind) && !QUEUE_KINDS.has(each.kind)),
        };
      }),
    });
  }
  return out;
}

// ---- the services page

const lineOfImport = (text, specifier) => {
  const at = codeOf(text).split('\n').findIndex((line) => ['\'', '"', '`'].some((quote) => line.includes(`${quote}${specifier}${quote}`)));
  return at < 0 ? null : at + 1;
};

/**
 * Each source file importing another service's code: a relative path that lands in a folder another service owns,
 * or a package another service is imported by. One entry per file and import, with the line that writes it.
 */
export function crossImports({ owns, files, extensions }) {
  // The longest folder that holds the path wins, and a path that is the folder itself is inside it.
  const ownerOf = (file) => {
    let best = null;
    for (const [id, own] of Object.entries(owns)) for (const folder of own.folders) if ((file === folder || file.startsWith(`${folder}/`)) && (best === null || folder.length > best.length)) best = { id, length: folder.length };
    return best?.id ?? null;
  };
  const isPackage = (specifier, prefix) => (prefix.endsWith('/') ? specifier.startsWith(prefix) : specifier === prefix || specifier.startsWith(`${prefix}/`));
  const found = [];
  for (const { file, text } of files) {
    if (text == null || !extensions.some((extension) => file.endsWith(extension))) continue;
    const from = ownerOf(file);
    if (from === null) continue;
    for (const specifier of importsOf(text)) {
      let to = null;
      if (specifier.startsWith('.')) to = ownerOf(path.posix.join(path.posix.dirname(file), specifier));
      else to = Object.entries(owns).find(([, own]) => own.packages.some((prefix) => isPackage(specifier, prefix)))?.[0] ?? null;
      if (to !== null && to !== from) found.push({ from, to, file, line: lineOfImport(text, specifier), specifier });
    }
  }
  return found.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/** A store two services' configs both bind, by its kind and name: what the services page names in red. */
export function sharedStores(deployments) {
  const by = new Map();
  for (const deployment of deployments) {
    for (const store of deployment.environments.flatMap((env) => env.stores)) {
      if (!store.name) continue;
      const key = `${store.kind}\0${store.name}`;
      by.set(key, { kind: store.kind, name: store.name, services: uniq([...(by.get(key)?.services ?? []), deployment.service]) });
    }
  }
  return [...by.values()].filter((each) => each.services.length > 1);
}

/**
 * @param {{ map: object, logical: object|null, services: { id: string, name: string, file: string, logical: object }[], deployments: object[], files: { file: string, text: string|null }[], extensions: string[] }} input
 * `services` holds every service with a page, Cockpit first.
 */
export function buildServiceMap({ map, logical, services, deployments, files, extensions }) {
  const byId = new Map(services.map((each) => [each.id, each]));
  const boxes = map.services.filter((each) => byId.has(each.id)).map((each) => ({ ...each, name: byId.get(each.id).name, short: each.short ?? byId.get(each.id).name, file: byId.get(each.id).file, off: byId.get(each.id).logical.bad.length }));
  const cockpitCallers = logical?.callers ?? [];

  const calls = map.calls.map((call) => {
    const found = call.foundBy === null ? null : cockpitCallers.find((each) => each.from === call.foundBy);
    return { from: call.from, to: call.to, how: call.how, state: found == null ? 'declared' : found.status === 'found' ? 'found' : 'notFound', files: found?.files ?? [], at: found?.at ?? {} };
  });

  // The outside services any box reaches, each once; a chip that is really another service's page is not one.
  const outside = [];
  const reaches = [];
  const filesToOutside = (design) => uniq([...design.ok, ...design.bad, ...design.accepted].filter((each) => each.b === 'outside').flatMap((each) => each.files));
  // Cockpit's outside services come first, then those only the others reach.
  for (const box of services.map((each) => boxes.find((one) => one.id === each.id)).filter(Boolean)) {
    const design = byId.get(box.id).logical;
    const chips = design.layers.filter((layer) => layer.kind === 'outside').flatMap((layer) => layer.items.flat()).filter((chip) => chip.href === null);
    for (const chip of chips) if (!outside.some((each) => each.name === chip.name)) outside.push({ id: chip.id, name: chip.name, sub: chip.sub });
    // A service reaching many outside services is one line to all of them, labelled with the files that make it.
    if (chips.length > 3) reaches.push({ from: box.id, to: 'all', files: filesToOutside(design) });
    else for (const chip of chips) reaches.push({ from: box.id, to: outside.find((each) => each.name === chip.name).id, files: null });
  }

  const imports = crossImports({ owns: map.owns, files, extensions });
  return {
    clients: map.clients,
    boxes,
    calls,
    outside,
    reaches,
    between: map.between ?? [],
    cross: { imports, shared: sharedStores(deployments) },
  };
}
