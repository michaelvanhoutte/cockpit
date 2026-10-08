/**
 * What changed between two models, as data. Pure: two models in, a list of
 * rows out. Both models are drawn by the same generator (see compare.js), so
 * a row is always a change in the repository, never in the drawing.
 *
 * Counts that move with every merge (a file count, a cell's number of
 * importers) are not changes; the set of things a model names is. A row is
 * { type, change: added | removed | changed, text, where, flag }, and a flag
 * with a `tone` of 'call' is one the reader is meant to see first.
 */

const byKey = (list, key) => new Map(list.map((each) => [key(each), each]));

/** Rows for what a list gained, lost and (where `differs` says so) changed, keyed by `key`. */
function compareSets(before, after, key, { added, removed, changed }) {
  const was = byKey(before, key);
  const is = byKey(after, key);
  const rows = [];
  for (const [id, each] of is) {
    if (!was.has(id)) rows.push(...[added?.(each)].flat().filter(Boolean));
    else if (changed) rows.push(...[changed(was.get(id), each)].flat().filter(Boolean));
  }
  for (const [id, each] of was) if (!is.has(id)) rows.push(...[removed?.(each)].flat().filter(Boolean));
  return rows;
}

const row = (type, change, text, where, flag = null) => ({ type, change, text, where, flag: flag ?? { label: change, tone: 'plain' } });
const call = (label) => ({ label, tone: 'call' });
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const areasOf = (model) => model.modules.layers.flatMap((layer) => layer.areas.map((area) => ({ ...area, layer: layer.title })));
const nameOfArea = (model) => new Map(areasOf(model).map((each) => [each.path, each.name]));

// ---- areas and marks -------------------------------------------------------

function areaRows(before, after) {
  const was = areasOf(before);
  const is = areasOf(after);

  const rows = compareSets(was, is, (each) => each.path, {
    added: (area) => row('Area', 'added', `${area.name} is a new area`, [area.path], area.state === 'undescribed' ? call('undescribed') : null),
    removed: (area) => row('Area', 'removed', `${area.name} is no longer an area`, [area.path]),
    changed: (a, b) => {
      const what = [
        a.name !== b.name && 'renamed',
        a.description !== b.description && 'description reworded',
        a.role !== b.role && `role ${a.role} to ${b.role}`,
        a.layer !== b.layer && `moved from ${a.layer ?? 'undescribed'} to ${b.layer ?? 'undescribed'}`,
      ].filter(Boolean);
      const out = what.length ? [row('Area', 'changed', `${b.name}: ${what.join(', ')}`, [b.path])] : [];
      if (a.state !== b.state) out.push(row('Area', 'changed', `${b.name} is now ${b.state}`, [b.path], b.state === 'described' ? null : call(b.state)));
      return out;
    },
  });

  // A mark is one import beyond the SDK in one area, with the files that carry it: a file joining a mark that stands is a new mark to look at too.
  const marks = (areas, field, make) => areas.flatMap((area) => area[field].map((each) => make(area, each)));
  const breachMark = (area, breach) => ({ key: `${area.path}\0${breach.import}`, area, what: breach.import, files: [breach.file] });
  const breaches = (list) => [...list.reduce((byKey, each) => byKey.set(each.key, { ...each, files: [...(byKey.get(each.key)?.files ?? []), ...each.files] }), new Map()).values()];
  const wheres = (mark, files) => files.map((file) => `${mark.area.path}/${file}`);
  const markRows = (list, { named, flag }) =>
    compareSets(list(before), list(after), (each) => each.key, {
      added: (m) => row('Mark', 'added', named.added(m), wheres(m, m.files), call(flag)),
      removed: (m) => row('Mark', 'removed', named.removed(m), wheres(m, m.files)),
      changed: (a, b) => {
        const gained = b.files.filter((file) => !a.files.includes(file));
        const lost = a.files.filter((file) => !b.files.includes(file));
        return [
          gained.length ? row('Mark', 'changed', named.more(b, gained.length), wheres(b, gained), call(flag)) : null,
          lost.length ? row('Mark', 'changed', named.fewer(b, lost.length), wheres(b, lost)) : null,
        ];
      },
    });
  const files = (count) => `${count} more ${count === 1 ? 'file' : 'files'}`;
  const breachRows = markRows((model) => breaches(marks(areasOf(model), 'breaches', breachMark)), {
    flag: 'new breach',
    named: {
      added: (m) => `${m.area.name} imports ${m.what}, beyond the SDK`,
      removed: (m) => `${m.area.name} no longer imports ${m.what}`,
      more: (m, count) => `${m.area.name} imports ${m.what} in ${files(count)}`,
      fewer: (m, count) => `${m.area.name} imports ${m.what} in ${count} fewer files`,
    },
  });
  return [...rows, ...breachRows];
}

// ---- connectors ------------------------------------------------------------

/** A connector's code in the core arriving or leaving; a file merely mentioning its name is not one. */
function connectorRows(before, after) {
  // Only a connector declared the same way in both models is compared: declaring a source, or moving its package, changes which files count without any file moving.
  const same = (a, b) => (a.package?.path ?? null) === (b.package?.path ?? null);
  const stable = (model, other) => (model.modules.connectors ?? []).filter((each) => (other.modules.connectors ?? []).some((there) => there.id === each.id && same(there, each)));
  const filesOf = (model, other) =>
    stable(model, other).flatMap((connector) => connector.inCore.flatMap((here) => here.files.map((file) => ({ key: `${connector.id}\0${here.area}/${file}`, name: connector.name, where: `${here.area}/${file}`, area: here.area }))));
  const names = nameOfArea(after);
  const inArea = (each) => names.get(each.area) ?? nameOfArea(before).get(each.area) ?? each.area;
  return compareSets(filesOf(before, after), filesOf(after, before), (each) => each.key, {
    added: (each) => row('Connector', 'added', `${each.name} code arrived in the core: ${each.where.slice(each.area.length + 1)} in ${inArea(each)}`, [each.where], call('connector file in the core')),
    removed: (each) => row('Connector', 'removed', `${each.name} code left the core: ${each.where.slice(each.area.length + 1)} in ${inArea(each)}`, [each.where]),
  });
}

// ---- dependencies ----------------------------------------------------------

function dependencyRows(before, after) {
  const names = new Map([...nameOfArea(before), ...nameOfArea(after)]);
  const label = (path) => names.get(path) ?? path;
  const key = (cell) => `${cell.from}\0${cell.to}`;
  const up = (model) => model.dependencies.cells.filter((each) => each.kind === 'upward');
  const wasUp = new Set(up(before).map(key));
  const isUp = new Set(up(after).map(key));

  // An import that starts or stops pointing up is the change; its files moving is not. Its cycle partner is not listed apart.
  const upRows = compareSets(up(before), up(after), key, {
    added: (cell) => row('Dependency', 'added', `${label(cell.from)} importing ${label(cell.to)} now points up${cell.cycle ? ', closing a cycle' : ''}`, [cell.from, cell.to], call('new upward import')),
    removed: (cell) => row('Dependency', 'removed', `${label(cell.from)} importing ${label(cell.to)} no longer points up`, [cell.from, cell.to]),
  });
  // An import that is not up on either side is still a dependency that arrived or left.
  const cellRows = compareSets(before.dependencies.cells, after.dependencies.cells, key, {
    added: (cell) => (isUp.has(key(cell)) ? null : row('Dependency', 'added', `${label(cell.from)} now imports ${label(cell.to)}`, [cell.from, cell.to])),
    removed: (cell) => (wasUp.has(key(cell)) ? null : row('Dependency', 'removed', `${label(cell.from)} no longer imports ${label(cell.to)}`, [cell.from, cell.to])),
  });
  return [...upRows, ...cellRows];
}

// ---- deployment ------------------------------------------------------------

const resourceName = (each) => [each.kind, each.binding, each.name].filter(Boolean).join(' ');

function deploymentRows(before, after) {
  const was = before.deployment;
  const is = after.deployment;
  const resourceKey = (each) => `${each.kind}\0${each.binding ?? ''}\0${each.name ?? ''}`;

  const environments = compareSets(was.environments, is.environments, (each) => each.name, {
    added: (each) => row('Environment', 'added', `${each.name} is a new environment (${each.kind})`, [each.name]),
    removed: (each) => row('Environment', 'removed', `${each.name} is no longer an environment`, [each.name]),
    changed: (a, b) => {
      const what = [a.worker !== b.worker && `Worker ${a.worker ?? 'unnamed'} to ${b.worker ?? 'unnamed'}`, !sameList(a.deployedBy, b.deployedBy) && `deployed by ${b.deployedBy.join(', ') || 'nothing'}`].filter(Boolean);
      const resources = compareSets(a.resources, b.resources, resourceKey, {
        added: (each) => row('Resource', 'added', `${b.name} gains ${resourceName(each)}${each.inherited ? ' (inherited)' : ''}`, [b.name]),
        removed: (each) => row('Resource', 'removed', `${b.name} loses ${resourceName(each)}`, [b.name]),
        changed: (x, y) => (x.inherited !== y.inherited ? row('Resource', 'changed', `${b.name}: ${resourceName(y)} is ${y.inherited ? 'now inherited' : 'now its own'}`, [b.name]) : null),
      });
      return [what.length ? row('Environment', 'changed', `${b.name}: ${what.join(', ')}`, [b.name]) : null, ...resources];
    },
  });

  const workflows = compareSets(was.workflows, is.workflows, (each) => each.file, {
    added: (each) => row('Workflow', 'added', `${each.name} is a new workflow`, [`.github/workflows/${each.file}`]),
    removed: (each) => row('Workflow', 'removed', `${each.name} is no longer a workflow`, [`.github/workflows/${each.file}`]),
    changed: (a, b) => {
      const starts = (workflow) => workflow.starts.map((each) => each.text);
      const deploys = (workflow) => workflow.deploys.map((each) => each.environment);
      const what = [
        a.name !== b.name && `renamed to ${b.name}`,
        !sameList(starts(a), starts(b)) && `now starts ${starts(b).join(', ') || 'never'}`,
        !sameList(deploys(a), deploys(b)) && `now deploys ${deploys(b).join(', ') || 'nothing'}`,
      ].filter(Boolean);
      return what.length ? row('Workflow', 'changed', `${b.name}: ${what.join('; ')}`, [`.github/workflows/${b.file}`]) : null;
    },
  });

  const reports = (model) => model.deployment.pages?.reports ?? [];
  const pages = compareSets(reports(before), reports(after), (each) => each.artifact, {
    added: (each) => row('Workflow', 'added', `GitHub Pages gains the ${each.artifact} at ${each.path}`, [each.path]),
    removed: (each) => row('Workflow', 'removed', `GitHub Pages loses the ${each.artifact}`, [each.path]),
    changed: (a, b) => (a.path !== b.path ? row('Workflow', 'changed', `GitHub Pages moves the ${b.artifact} to ${b.path}`, [b.path]) : null),
  });
  return [...environments, ...workflows, ...pages];
}

/** Every row, in the order a reader should meet them: call-outs first, then by view. */
export function diffModels(before, after) {
  const rows = [...areaRows(before, after), ...connectorRows(before, after), ...dependencyRows(before, after), ...deploymentRows(before, after)];
  return rows.map((each, index) => ({ each, index })).sort((a, b) => Number(b.each.flag.tone === 'call') - Number(a.each.flag.tone === 'call') || a.index - b.index).map(({ each }) => each);
}
