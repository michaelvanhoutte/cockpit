/**
 * The model: the Worker config's text and each workflow's text in, what
 * Cockpit is deployed as out. A pure function of its arguments (no clock, no
 * filesystem, no git), so the same commit always draws the same model.
 *
 * Wrangler's rules decide what an environment holds. Settings such as the
 * cron triggers and the static assets are *inheritable*: an environment that
 * leaves them out gets the top level's. Bindings (databases, buckets, queues,
 * the AI binding, ...) are *not*: an environment that leaves one out has none,
 * and one that declares it names its own. The top level of the file is the
 * environment Wrangler deploys when no `--env` is given, which this repository
 * calls production.
 */

import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';
import { parseDocument } from 'yaml';

/** A file that could not be read as what it is. Names the file so a failed night says which. */
export class ReadError extends Error {
  constructor(file, reason) {
    super(`${file}: ${reason}`);
    this.name = 'ReadError';
    this.file = file;
  }
}

export const PRODUCTION = 'production';

/** Environment names the generator gives a meaning to. Any other declared name is drawn as itself. */
const ENVIRONMENT_KINDS = { [PRODUCTION]: 'production', staging: 'staging', local: 'local development' };

/**
 * Settings that are not bindings, so never drawn as a resource. A top-level key
 * in neither this list nor KNOWN_BINDINGS, whose value is an object or an
 * array, is a binding kind the generator does not know and is drawn under its
 * raw key rather than dropped.
 */
const SETTINGS = new Set([
  '$schema', 'name', 'main', 'compatibility_date', 'compatibility_flags', 'account_id', 'env', 'vars', 'define',
  'observability', 'triggers', 'preview_urls', 'workers_dev', 'route', 'routes', 'migrations', 'limits', 'placement',
  'minify', 'logpush', 'upload_source_maps', 'keep_vars', 'build', 'tsconfig', 'rules', 'find_additional_modules',
  'no_bundle', 'base_dir', 'site', 'node_compat', 'send_metrics', 'dev', 'jsx_factory', 'jsx_fragment',
  'legacy_env', 'first_party_worker', 'alias', 'keep_names', 'topLevelName', 'deploy_config_path',
]);

/** Inheritable settings that draw as a resource. */
const INHERITED_RESOURCES = ['assets', 'triggers'];

/** Binding kinds with a drawing of their own; each returns the entries one configuration holds. */
const KNOWN_BINDINGS = {
  d1_databases: (list) => list.map((each) => resource('D1 database', each.binding, each.database_name)),
  r2_buckets: (list) => list.map((each) => resource('R2 bucket', each.binding, each.bucket_name)),
  kv_namespaces: (list) => list.map((each) => resource('KV namespace', each.binding, each.id)),
  durable_objects: (value) => (value?.bindings ?? []).map((each) => resource('Durable Object', each.name, each.class_name)),
  queues: (value) => [
    ...(value?.producers ?? []).map((each) => resource('Queue, producer', each.binding, each.queue)),
    ...(value?.consumers ?? []).map((each) => resource('Queue, consumer', null, each.queue)),
  ],
  ai: (value) => (value ? [resource('Workers AI', value.binding, null)] : []),
};

function resource(kind, binding, name) {
  return { kind, binding: binding ?? null, name: name ?? null };
}

const asList = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/** Parse the Worker config, which is JSONC: comments and trailing commas are legal there. */
export function parseWranglerConfig(file, text) {
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new ReadError(file, `not valid JSONC (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset})`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReadError(file, 'expected a JSON object at the top level');
  }
  return value;
}

/** The unknown binding kinds a configuration declares: object or array values under keys nothing else claims. */
function unknownKinds(own) {
  return Object.keys(own)
    .filter((key) => !SETTINGS.has(key) && !(key in KNOWN_BINDINGS) && !INHERITED_RESOURCES.includes(key))
    .filter((key) => own[key] !== null && typeof own[key] === 'object')
    .flatMap((key) =>
      asList(own[key]).map((each) =>
        resource(key, typeof each === 'object' && each ? (each.binding ?? each.name ?? null) : null, typeof each === 'object' && each ? (each.name ?? each.id ?? each.service ?? null) : null),
      ),
    );
}

/** What one environment holds, given its own block and the top level it may inherit from. */
function environmentOf(name, own, top, isTop) {
  const resources = [];
  const bindingKeys = Object.keys(KNOWN_BINDINGS);
  for (const key of bindingKeys) {
    if (own[key] !== undefined) {
      for (const entry of KNOWN_BINDINGS[key](own[key])) resources.push({ ...entry, inherited: false });
    }
  }
  for (const entry of unknownKinds(own)) resources.push({ ...entry, inherited: false });

  // Inheritable settings: the environment's own, else the top level's.
  const inherits = (key) => (own[key] !== undefined ? { value: own[key], inherited: false } : { value: top[key], inherited: !isTop && top[key] !== undefined });
  const assets = inherits('assets');
  if (assets.value && typeof assets.value === 'object') {
    resources.push({ ...resource('Static assets', assets.value.binding, assets.value.directory), inherited: assets.inherited });
  }
  const triggers = inherits('triggers');
  for (const cron of triggers.value?.crons ?? []) {
    resources.push({ ...resource('Cron trigger', null, cron), inherited: triggers.inherited });
  }

  return {
    name,
    kind: ENVIRONMENT_KINDS[name] ?? 'environment',
    worker: isTop ? (top.name ?? null) : (own.name ?? (top.name ? `${top.name}-${name}` : null)),
    resources,
  };
}

/** Every environment the config declares, the top level first, then each under `env` in the order written. */
export function environmentsOf(config) {
  const declared = config.env && typeof config.env === 'object' ? config.env : {};
  return [
    environmentOf(PRODUCTION, config, config, true),
    ...Object.entries(declared).map(([name, own]) => environmentOf(name, own ?? {}, config, false)),
  ];
}

// ---- workflows -------------------------------------------------------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A cron in words where it is a plain daily or weekly time, else the expression itself. */
export function describeCron(expression) {
  const match = String(expression).trim().match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|\d)$/);
  if (!match) return `on schedule ${expression}`;
  const time = `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')} UTC`;
  if (match[3] === '*') return `every night at ${time}`;
  return `every ${WEEKDAYS[Number(match[3]) % 7]} at ${time}`;
}

function startsOf(on) {
  const events = typeof on === 'string' ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((each) => [each, null])) : (on ?? {});
  const starts = [];
  for (const [event, config] of Object.entries(events)) {
    const branches = asList(config?.branches);
    if (event === 'push') {
      const tagsOnly = branches.length === 0 && asList(config?.tags).length > 0;
      starts.push({ event, text: branches.length === 1 && branches[0] === 'main' ? 'every merge' : branches.length ? `a push to ${branches.join(', ')}` : tagsOnly ? 'a tag push' : 'every push' });
    } else if (event === 'pull_request') {
      starts.push({ event, text: 'every pull request' });
    } else if (event === 'schedule') {
      for (const entry of asList(config)) starts.push({ event, text: describeCron(entry?.cron), cron: entry?.cron ?? null });
    } else if (event === 'workflow_dispatch') {
      const inputs = Object.keys(config?.inputs ?? {});
      starts.push({ event, text: 'by hand', inputs });
    } else if (event === 'workflow_call') {
      starts.push({ event, text: 'called by other workflows' });
    } else {
      starts.push({ event, text: event.replace(/_/g, ' ') });
    }
  }
  return starts;
}

const ENV_FLAG = /--env(?:\s+|=)(?:"([^"]*)"|'([^']*)'|(\S+))/;

/** The Wrangler environment a step deploys, or null when it deploys none. `--env=""` and no flag are both the top level. */
function deployedBy(step) {
  const wranglerAction = typeof step.uses === 'string' && step.uses.startsWith('cloudflare/wrangler-action');
  const command = wranglerAction ? step.with?.command : step.run;
  if (typeof command !== 'string') return null;
  const deploy = command.match(wranglerAction ? /^\s*(?:wrangler\s+)?deploy\b/ : /\bwrangler\s+deploy\b/);
  if (!deploy) return null;
  // Only this command's own flag: a later command on the same line is not its environment.
  const flag = command.slice(deploy.index).split(/&&|\|\||;|\n/)[0].match(ENV_FLAG);
  const name = flag ? (flag[1] ?? flag[2] ?? flag[3]) : wranglerAction && typeof step.with?.environment === 'string' ? step.with.environment : '';
  return name === '' ? PRODUCTION : name;
}

/** One workflow's text read: its name, what starts it, the environments it deploys and the workflows it calls. */
export function parseWorkflow(file, text) {
  const document = parseDocument(text);
  if (document.errors.length > 0) throw new ReadError(file, `not valid YAML (${document.errors[0].message.split('\n')[0]})`);
  const value = document.toJS();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ReadError(file, 'expected a mapping at the top level');
  if (value.on === undefined) throw new ReadError(file, 'has no `on:` to say what starts it');
  if (value.jobs === null || typeof value.jobs !== 'object') throw new ReadError(file, 'has no `jobs:`');

  const deploys = new Set();
  const calls = new Set();
  const steps = [];
  for (const job of Object.values(value.jobs)) {
    if (typeof job?.uses === 'string' && job.uses.startsWith('./.github/workflows/')) calls.add(job.uses.slice('./.github/workflows/'.length));
    for (const step of asList(job?.steps)) {
      if (step === null || typeof step !== 'object') continue;
      steps.push(step);
      const environment = deployedBy(step);
      if (environment !== null) deploys.add(environment);
    }
  }
  return { file, name: typeof value.name === 'string' ? value.name : file, starts: startsOf(value.on), deploys: [...deploys], calls: [...calls], pages: pagesOf(steps) };
}

const usesAction = (step, action) => typeof step.uses === 'string' && step.uses.startsWith(`${action}@`);
const slashes = (value) => String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * The reports a workflow puts on GitHub Pages: null unless it deploys Pages
 * (`actions/deploy-pages`). Each `actions/download-artifact` step whose path
 * lies inside the directory `actions/upload-pages-artifact` publishes is one
 * report, with the address it lands at: the directory itself is the site's
 * root, `<directory>/stability/` is `/stability/`.
 */
function pagesOf(steps) {
  if (!steps.some((step) => usesAction(step, 'actions/deploy-pages'))) return null;
  const site = slashes(steps.find((step) => usesAction(step, 'actions/upload-pages-artifact'))?.with?.path ?? '.');
  const reports = [];
  for (const step of steps) {
    if (!usesAction(step, 'actions/download-artifact') || typeof step.with?.name !== 'string') continue;
    const target = slashes(step.with.path ?? '.');
    const inside = site === '.' ? target : target === site ? '' : target.startsWith(`${site}/`) ? target.slice(site.length + 1) : null;
    if (inside === null) continue;
    reports.push({ artifact: step.with.name, path: inside === '' || inside === '.' ? '/' : `/${inside}/` });
  }
  return { reports };
}

/**
 * @param {{ wrangler: { file: string, text: string }, workflows: { file: string, text: string }[], commit: string|null, date: string|null, repo?: string|null }} input
 */
export function buildModel({ wrangler, workflows, commit, date, repo = null }) {
  const environments = environmentsOf(parseWranglerConfig(wrangler.file, wrangler.text));
  const declared = new Set(environments.map((each) => each.name));
  const parsed = workflows.map((each) => parseWorkflow(each.file, each.text)).sort((a, b) => a.file.localeCompare(b.file));

  const read = parsed.map((workflow) => {
    const calledBy = parsed.filter((other) => other.calls.includes(workflow.file)).map((other) => other.file);
    const starts = workflow.starts.map((start) => (start.event === 'workflow_call' && calledBy.length ? { ...start, text: `called by ${calledBy.join(', ')}` } : start));
    return {
      file: workflow.file,
      name: workflow.name,
      starts,
      calledBy,
      deploys: workflow.deploys.map((name) => ({ environment: name, declared: declared.has(name) })),
    };
  });

  const publisher = parsed.find((workflow) => workflow.pages);

  return {
    drawnFrom: { commit, date, repo },
    deployment: {
      pages: publisher ? { workflow: publisher.file, reports: publisher.pages.reports } : null,
      environments: environments.map((environment) => ({
        ...environment,
        deployedBy: read.filter((workflow) => workflow.deploys.some((each) => each.environment === environment.name)).map((workflow) => workflow.file),
      })),
      workflows: read,
    },
  };
}

