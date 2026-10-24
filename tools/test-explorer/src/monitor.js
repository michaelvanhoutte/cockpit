/**
 * The Harness Monitor, and nothing else: sending a model to it, `main`'s or an
 * open pull request's, as the documents it stores (apps/harness-monitor/src/tests.ts). `fetchImpl` is a
 * parameter so the tests can stand in for the Monitor.
 *
 * A send is the tree, then each area's source lines, then the switch that
 * shows them, each its own request. A send cut short leaves the parts already
 * sent stored under the commit and never shown: the Monitor keeps showing the
 * snapshot before until a switch lands, and the next send deletes them.
 */

import { gzipSync } from 'node:zlib';

import { walkTree } from './model.js';

export class MonitorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MonitorError';
  }
}

/**
 * The model as the Monitor stores it: the tree with every `context` taken out,
 * and each area's source lines keyed `file:line`. A file:line always has the
 * same lines around it (analyze/index.js reads them once per file), so one key
 * serves every rule, case and gap pointing at it.
 *
 * @param {import('./model.js').Model} model
 * @returns {{ commit: string, tree: object, areas: { key: string, lines: Record<string, import('./model.js').ContextLine[]> }[] }}
 */
export function snapshotParts(model) {
  const areas = [];
  for (const node of walkTree(model.tree)) {
    const lines = {};
    const keep = (ref) => {
      if (ref.context) lines[`${ref.file}:${ref.line}`] = ref.context;
    };
    for (const rule of node.rules) {
      keep(rule);
      rule.cases.forEach(keep);
      rule.todoCases.forEach(keep);
    }
    node.filesNothingRuns.forEach(keep);
    (node.branchesNothingTakes ?? []).forEach(keep);
    areas.push({ key: node.key, lines });
  }
  const tree = JSON.parse(JSON.stringify(model, (key, value) => (key === 'context' ? undefined : value)));
  return { commit: model.commit, tree, areas };
}

const gzip = (value) => gzipSync(JSON.stringify(value));

/** A commit as the explorer writes it, short or whole: anything else is refused before a request carries it. */
const COMMIT = /^[0-9a-f]{7,40}$/;

/** Whose tests a send is, in a sentence: `main`'s, or a pull request's. */
export const whose = (pullRequest) => (pullRequest === null ? "main's tests" : `pull request ${pullRequest}'s tests`);

/**
 * Sends a model as `main`'s tests, or with `pullRequest` as that pull
 * request's: the tree, each area in the tree's order, then the switch,
 * stopping at the first part the Monitor does not take and naming it, so a
 * refused part is never followed by a switch. The pull request is the caller's,
 * never the model's: a pull request's model is its author's to write.
 *
 * @param {{ url: string, key: string, model: import('./model.js').Model, pullRequest?: number | null, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ commit: string, areas: number, treeBytes: number, largestArea: { key: string, bytes: number } | null }>}
 */
export async function sendSnapshot({ url, key, model, pullRequest = null, fetchImpl = globalThis.fetch }) {
  if (pullRequest !== null && !(Number.isSafeInteger(pullRequest) && pullRequest > 0)) throw new MonitorError(`${JSON.stringify(pullRequest)} is not a pull request number; nothing was sent.`);
  const { commit, tree, areas } = snapshotParts(model);
  if (typeof commit !== 'string' || !COMMIT.test(commit)) throw new MonitorError(`The model's commit ${JSON.stringify(commit)} is not one; nothing was sent.`);
  // An address resolves `.` and `..` as steps up, which would send that area's lines somewhere other than its own part.
  const stepping = areas.find((area) => area.key === '.' || area.key === '..');
  if (stepping) throw new MonitorError(`The model names an area ${JSON.stringify(stepping.key)}, which no address can carry; nothing was sent.`);
  const snapshot = pullRequest === null ? 'main' : `pr-${pullRequest}`;
  const base = `${url.replace(/\/+$/, '')}/v1/tests/${snapshot}/${commit}`;
  const headers = { authorization: `Bearer ${key}` };
  const before = `Nothing was shown; ${whose(pullRequest)} before this send still are.`;

  const request = async (name, address, init) => {
    let res;
    try {
      res = await fetchImpl(address, { ...init, headers: { ...headers, ...init.headers } });
    } catch (error) {
      throw new MonitorError(`Could not reach the Harness Monitor with ${name}: ${error.message}. ${before}`);
    }
    if (!res.ok) {
      const reason = await res
        .json()
        .then((body) => body?.error)
        .catch(() => null);
      throw new MonitorError(`The Harness Monitor refused ${name} (${res.status}${reason ? `: ${reason}` : ''}). ${before}`);
    }
  };
  const put = (name, address, value) => {
    const body = gzip(value);
    return request(name, address, { method: 'PUT', headers: { 'content-type': 'application/gzip' }, body }).then(() => body.byteLength);
  };

  const treeBytes = await put('the tree', `${base}/tree`, tree);
  let largestArea = null;
  for (const [index, area] of areas.entries()) {
    const bytes = await put(`area ${index + 1} of ${areas.length} (${area.key})`, `${base}/areas/${encodeURIComponent(area.key)}`, area.lines);
    if (!largestArea || bytes > largestArea.bytes) largestArea = { key: area.key, bytes };
  }
  await request('the switch', `${base}/current`, { method: 'POST', headers: {} });
  return { commit, areas: areas.length, treeBytes, largestArea };
}
