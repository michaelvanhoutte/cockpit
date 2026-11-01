/**
 * The services view beside Cockpit's and the Monitor's logical pages: the services page (who uses each service, how
 * they reach each other, the check that none imports another's code or shares its store, what deploys on its own),
 * each service's Deployment tab, a page for each layer of a design (its modules and dependencies, or its stores as
 * cards), all drawn from the model alone. Every path written in prose, and every file listed, opens on GitHub at the
 * commit the page was drawn from.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderDependencies } from './dependencies.js';
import { renderDiagram } from './diagram.js';
import { atNaturalSize } from './html.js';
import { commitLineOf, linkPaths, linksFor } from './links.js';
import { deploymentFile, LOGICAL_FILE, NLEGEND, renderNested, servicesOf } from './logical.js';
import { renderModules } from './modules.js';
import { isOpened } from './parts.js';
import { crumbTrail, prose, SERVICES_TRAIL, switchNav } from './shell.js';
import { esc } from './svg.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVICES_FILE = 'services.html';

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const uniq = (list) => [...new Set(list)];

/** A complete page of the services view: the report's styles, the logical page's, the trail, an optional switch and the commit line. */
function page({ model, title, crumbs, tabs = null, standfirst, body, focus = '' }) {
  const links = linksFor(model.drawnFrom);
  const styles = `${readFileSync(path.join(here, 'styles.css'), 'utf8')}${readFileSync(path.join(here, 'logical.css'), 'utf8')}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Cockpit Architecture &middot; ${esc(title)}</title>
<style>${styles}${focus}</style>
</head>
<body>
<div class="wrap wide">
<header class="masthead"><p class="crumbs">${crumbTrail(crumbs)}</p><h1>${esc(title)}</h1>${switchNav(tabs)}${standfirst ? `<p class="standfirst">${linkPaths(standfirst, links)}</p>` : ''}
<div class="runmeta">${commitLineOf(model.drawnFrom, links)}</div></header>
${linkPaths(body, links)}
</div>
</body>
</html>
`;
}

// ---- the services page

/** A workflow shipping an environment, or the words when nothing does: the workflow's name opens it on GitHub. */
const shippedByCell = (shipped, links) => shipped.map((each) => (each.file ? `${links.file(`.github/workflows/${each.file}`)}${each.starts ? `, ${esc(each.starts)}` : ''}` : esc(each.text))).join('<br>');

/** A workflow by its file name, opening the workflow on GitHub. */
const workflowLink = (file, links) => {
  const href = links.url(`.github/workflows/${file}`);
  return href ? `<a class="gh" href="${esc(href)}" target="_blank" rel="noopener"><code>${esc(file)}</code></a>` : `<code>${esc(file)}</code>`;
};

function servicesPage(model) {
  const links = linksFor(model.drawnFrom);
  const map = model.serviceMap;
  const clientId = (id) => `s-${id}`;
  const clients = map.clients.map((each) => ({ id: clientId(each.id), name: each.name, sub: each.sub, kind: 'client', folders: [] }));
  const boxes = map.boxes.map((box) => ({
    id: `S-${box.id}`,
    title: box.name,
    kind: 'service',
    href: box.file,
    frac: box.share ?? undefined,
    badge: box.off > 0 ? { text: `${box.off} off the design`, href: `${box.file}#off` } : undefined,
    items: box.items.map((row, r) => row.map((chip, i) => ({ id: `c-${box.id}-${r}-${i}`, name: chip.name, sub: chip.sub, kind: chip.kind === 'store' ? 'store' : 'component', href: chip.href, folders: [] }))),
  }));
  const side = { id: 'S-out', title: 'Outside', kind: 'outside', items: [map.outside.map((each) => ({ id: `o-${each.id}`, name: each.name, sub: each.sub, kind: 'outside', href: null, folders: [] }))] };
  const nameOf = new Map(map.boxes.map((each) => [each.id, each.name]));
  const shortOf = new Map(map.boxes.map((each) => [each.id, each.short]));
  const endOf = (id) => (nameOf.has(id) ? `S-${id}` : clientId(id));

  const lines = [
    ...map.calls.map((call) => (call.state === 'declared'
      ? { from: endOf(call.from), to: endOf(call.to), kind: 'decl', declared: true, label: call.how, toName: shortOf.get(call.to), title: `${call.from} → ${call.to}: ${call.how}` }
      : { from: endOf(call.from), to: endOf(call.to), kind: call.state === 'found' ? 'ok' : 'miss', label: call.how, title: call.state === 'found' ? `In the design, and in the code:\n${call.files.join('\n')}` : `${call.how}: the design draws it; no file does it` })),
    ...map.reaches.map((each) => (each.to === 'all'
      ? { from: `S-${each.from}`, to: 'S-out', kind: 'ok', label: plural(each.files.length, 'file'), title: `${nameOf.get(each.from)} calls outside services` }
      : { from: `S-${each.from}`, to: `o-${each.to}`, kind: 'ok', title: `${nameOf.get(each.from)} → ${map.outside.find((one) => one.id === each.to)?.name}` })),
    ...map.cross.imports.map((each, at) => ({ from: `S-${each.from}`, to: `S-${each.to}`, kind: 'bad', n: at + 1, id: `x-${at + 1}`, href: '#cross', title: `Imports another service's code: ${each.file}` })),
  ];
  const drawing = renderNested({ label: 'The services', rows: [[{ id: 'S-clients', title: 'Who uses them', kind: 'clients', items: [clients] }], boxes], side, sideRow: 1, lines, laneStart: 30, gap: 170 }, links);

  const { imports, shared } = map.cross;
  const importFiles = uniq(imports.map((each) => each.file));
  const importLis = imports.length
    ? `<span class="bad">${plural(importFiles.length, 'file')} import${importFiles.length === 1 ? 's' : ''} another service's code:</span> ${imports.map((each, at) => `<span class="num">${at + 1}</span> ${links.file(each.file, each.line)} <span class="dim">(${esc(map.boxes.find((box) => box.id === each.from)?.name ?? each.from)} → ${esc(map.boxes.find((box) => box.id === each.to)?.name ?? each.to)})</span>`).join(', ')}`
    : '<span class="ok">No file imports another service\'s code.</span>';
  const sharedLi = shared.length ? `<span class="bad">Shared stores: ${shared.map((each) => `${esc(each.kind)} ${esc(each.name)}`).join(', ')}</span>` : '<span class="ok">No store is used by two services.</span>';

  const services = servicesOf(model);
  const rows = model.deployments.map((deployment) => {
    const service = services.find((each) => each.id === deployment.service);
    const label = service ? `<a href="${esc(service.file)}">${esc(service.name)}${isOpened(service.logical) ? ', part of Cockpit' : ''}</a>` : esc(deployment.service);
    const shipped = uniq(deployment.environments.filter((env) => env.name !== 'local').flatMap((env) => env.shippedBy.map((each) => (each.file ? workflowLink(each.file, links) : esc(each.text.split(',')[0]))))).join('<br>');
    const stores = uniq(deployment.environments.flatMap((env) => env.stores.map((each) => `${each.kind} ${each.name ?? ''}`.trim()))).map((each) => `<span class="chip">${esc(each)}</span>`).join('');
    return `<tr><td>${label}</td><td>${shipped}</td><td>${deployment.environments.map((env) => esc(env.name)).join(', ')}</td><td>${stores}</td></tr>`;
  });

  return page({
    model,
    title: 'Services',
    crumbs: [SERVICES_TRAIL[0], ['Services']],
    standfirst: 'What deploys on its own, who uses it, and how the services reach each other. Click a service for its layers.',
    focus: drawing.focus,
    body: `${NLEGEND}<div class="diagram">${drawing.svg}</div>
<h2 id="cross">Between services</h2><p class="sectionnote">The design: a service reaches another only through its API, never by importing its code or using its store.</p>
<ul><li>${importLis}</li>
<li>${sharedLi}</li></ul>
<h2>What deploys on its own</h2><div class="scroll"><table class="flows"><tr><th>Service</th><th>Shipped by</th><th>Environments</th><th>Its stores</th></tr>${rows.join('')}</table></div>`,
  });
}

// ---- each service's Deployment tab

function deploymentTable(deployment, links) {
  const targets = deployment.environments;
  const chip = (resource, cls) => `<span class="chip${cls ? ` ${cls}` : ''}">${esc(resource.kind)}${resource.binding ? ` ${esc(resource.binding)}` : ''}${resource.name ? ` → ${esc(resource.name)}` : ''}</span>`;
  const row = (label, cell) => `<tr><th class="row">${label}</th>${targets.map((each) => `<td>${cell(each) || '<span class="dim">none</span>'}</td>`).join('')}</tr>`;
  return `<div class="scroll"><table class="flows"><tr><th></th>${targets.map((each) => `<th>${esc(each.name)}</th>`).join('')}</tr>
${row('Runs on', (each) => esc(each.where))}
${row('Shipped by', (each) => shippedByCell(each.shippedBy, links))}
${row('Settings', (each) => (each.settings.length ? `<ul>${each.settings.map(([key, value]) => `<li><code>${esc(key)}</code> ${esc(String(value).slice(0, 80))}</li>`).join('')}</ul>` : ''))}
${row('Secrets, by name', (each) => each.secrets.map((name) => `<span class="chip s">${esc(name)}</span>`).join(''))}
${row('Storage', (each) => each.stores.map((resource) => chip(resource, '')).join(''))}
${row('Queues', (each) => each.queues.map((resource) => chip(resource, 'q')).join(''))}
${row('Other bindings', (each) => each.other.map((resource) => chip(resource, 'o')).join(''))}
</table></div>`;
}

function deploymentPage(model, service, deployment) {
  const links = linksFor(model.drawnFrom);
  const opened = isOpened(service.logical);
  const trail = [...SERVICES_TRAIL, ...(opened ? [['Cockpit', LOGICAL_FILE]] : []), [service.name]];
  // Cockpit's tab opens on the report's own drawing of where it runs, then lists the same environments by column.
  const drawing = deployment.service === 'cockpit' ? `<div class="diagram full">${atNaturalSize(renderDiagram(model))}</div>
<h2>Each environment</h2><p class="sectionnote">One column per environment, read from <code>${esc(deployment.source)}</code>.</p>` : '';
  return page({
    model,
    title: service.name,
    crumbs: trail,
    tabs: [['Logical', service.file, false], ['Deployment', deploymentFile(service.file), true]],
    standfirst: prose(deployment.intro),
    body: `${drawing}${deploymentTable(deployment, links)}`,
  });
}

// ---- a layer's page

/** The model cut to some areas: the Modules and Dependencies views draw it as they draw the whole, and an import out of the cut is not there. */
export function cutTo(model, paths) {
  const keep = new Set(paths);
  const inside = (list) => list.filter((each) => keep.has(each.path));
  return {
    ...model,
    modules: { ...model.modules, layers: model.modules.layers.map((layer) => ({ ...layer, areas: inside(layer.areas) })).filter((layer) => layer.areas.length > 0), connectors: [], releasedOnItsOwn: [], workers: [] },
    dependencies: {
      ...model.dependencies,
      areas: inside(model.dependencies.areas),
      cells: model.dependencies.cells.filter((cell) => keep.has(cell.from) && keep.has(cell.to)),
      undecidedPairs: model.dependencies.undecidedPairs.filter(([a, b]) => keep.has(a) && keep.has(b)),
    },
  };
}

/** A layer's folders: those its components name that the report has as areas, in the report's order. */
const foldersOf = (layer, model) => {
  const named = new Set(layer.items.flat().flatMap((chip) => chip.folders));
  return model.dependencies.areas.map((area) => area.path).filter((area) => named.has(area));
};

const dependenciesFile = (file) => file.replace(/\.html$/, '-dependencies.html');

function layerPages(model, service) {
  const links = linksFor(model.drawnFrom);
  const pages = {};
  // A layer of the design that names a page of its own; a dotted box that opens another service's page is not one.
  for (const layer of service.logical.layers.filter((each) => each.href && each.kind === 'layer')) {
    const crumbs = [...SERVICES_TRAIL, [service.name, service.file], [layer.title]];
    const stores = layer.items.flat().filter((chip) => chip.kind === 'store');
    if (stores.length > 0) {
      const nameOf = new Map(service.logical.layers.flatMap((each) => each.items.flat()).map((chip) => [chip.id, chip.name]));
      const card = (chip) => {
        const used = uniq((service.logical.usedBy?.[chip.id] ?? []).map((id) => nameOf.get(id) ?? id));
        const meta = `${chip.href ? 'Open its tables. ' : ''}Used by ${used.length ? esc(used.join(', ')) : 'no component the code names'}`;
        return `<${chip.href ? `a href="${esc(chip.href)}"` : 'div'} class="card"><h4>${esc(chip.name)}</h4><p>${esc(chip.sub)}</p><p class="meta">${meta}</p></${chip.href ? 'a' : 'div'}>`;
      };
      pages[layer.href] = page({ model, title: layer.title, crumbs, standfirst: 'Each store, and who uses it. Click a database for its tables.', body: `<div class="cards">${stores.map(card).join('')}</div>` });
      continue;
    }
    const cut = cutTo(model, foldersOf(layer, model));
    const tabs = (on) => [['Modules', layer.href, on === 'Modules'], ['Dependencies', dependenciesFile(layer.href), on === 'Dependencies']];
    const modules = renderModules(cut, { links });
    pages[layer.href] = page({
      model,
      title: layer.title,
      crumbs,
      tabs: tabs('Modules'),
      standfirst: 'Its modules and which imports which. A number on a line counts the files doing the importing; red is an import back up.',
      body: `<div class="diagram">${modules}</div>`,
    });
    pages[dependenciesFile(layer.href)] = page({
      model,
      title: layer.title,
      crumbs,
      tabs: tabs('Dependencies'),
      standfirst: 'The same imports as a matrix: each cell counts the files in the row\'s module importing the column\'s. A red cell is an import back up.',
      body: `<div class="diagram">${renderDependencies(cut)}</div>`,
    });
  }
  return pages;
}

/**
 * Every page of the services view that is not a service's logical page: the services page, the Deployment tab of each
 * service that has one, and a page for each layer a design gives a page of its own.
 * @returns {Record<string, string>} the file name to the complete HTML document; empty when the description has no `serviceMap`
 */
export function renderServicePages(model) {
  const pages = {};
  if (model.serviceMap) pages[SERVICES_FILE] = servicesPage(model);
  const services = servicesOf(model);
  for (const deployment of model.deployments ?? []) {
    const service = services.find((each) => each.id === deployment.service);
    if (service) pages[deploymentFile(service.file)] = deploymentPage(model, service, deployment);
  }
  for (const service of services) Object.assign(pages, layerPages(model, service));
  return pages;
}
