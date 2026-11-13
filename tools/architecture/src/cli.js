/**
 * The wiring: readCheckout(root) -> buildModel(...) -> the pages -> files.
 *
 * Nothing is written until the model is built and every page rendered: a file
 * that cannot be read fails the run with a non-zero exit and leaves no page and
 * no model, so the previous report stays live rather than being replaced by a
 * drawing with a part missing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compareWithPrevious } from './compare.js';
import { buildModel, ReadError } from './model.js';
import { readCheckout } from './read.js';
import { renderDesignPages } from './render/design.js';
import { renderLogicalPage, servicesOf } from './render/logical.js';
import { renderServicePages, renderWholeAppPages } from './render/services.js';
import { renderTablePages } from './render/tables.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: node src/cli.js [options]

  --out <folder>   where to write the pages and model.json (default ../out)
  --json           write only the model, as model.json in that folder, and no page
  --model <path>   also write the model, as --json would, to this path
  --root <path>    the checkout to draw (default: the repository this tool is in)
  --monitor <url>  the Harness Monitor's address, which the front page links the harness reports at (default: no links)
  --previous <location>  the previous report's model, a file or an address; What changed, at the foot of the front page, compares with the commit it names
  --help
`;

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    // An empty address is the repository variable unset: no links, not a complaint.
    else if (arg === '--monitor') args.monitor = value() ?? '';
    else if (arg === '--out' || arg === '--root' || arg === '--model' || arg === '--previous') {
      const next = value();
      if (!next || next.startsWith('--')) args.invalid ??= `${arg} needs a path`;
      else args[arg.slice(2)] = next;
    } else args.unknown ??= arg;
  }
  return args;
}

const modelJson = (model) => JSON.stringify(model, null, 2);

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.unknown) {
    process.stderr.write(`unknown argument: ${args.unknown}\n\n${USAGE}`);
    return 2;
  }
  if (args.invalid) {
    process.stderr.write(`${args.invalid}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const out = path.resolve(args.out ?? path.join(here, '../out'));

  let model;
  let pages = {};
  try {
    const root = path.resolve(args.root ?? path.join(here, '../../..'));
    const checkout = readCheckout(root);
    model = buildModel(checkout);
    // Only the page shows the comparison, so only the page pays for the second drawing.
    const comparison = args.json ? null : await compareWithPrevious({ root, model, description: checkout.description, rules: checkout.rules, previous: args.previous });
    if (comparison) process.stderr.write(`what changed: ${comparison.state === 'compared' ? `${comparison.changes.length} changes since ${comparison.from.commit.slice(0, 7)}` : comparison.state === 'first' ? 'first report' : comparison.reason}\n`);
    if (!args.json) pages = { ...renderWholeAppPages(model, { comparison }), ...renderTablePages(model), ...renderServicePages(model), ...renderDesignPages(model, { monitor: args.monitor, comparison }), ...Object.fromEntries(servicesOf(model).map((service) => [service.file, renderLogicalPage(model, service)])) };
  } catch (error) {
    if (error instanceof ReadError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const written = [[path.join(out, 'model.json'), modelJson(model)]];
  for (const [name, content] of Object.entries(pages)) written.push([path.join(out, name), content]);
  if (args.model) written.push([path.resolve(args.model), modelJson(model)]);
  for (const [file, content] of written) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  process.stderr.write(`wrote ${written.map(([file]) => file).join(', ')} - ${model.deployment.environments.length} environments, ${model.deployment.workflows.length} workflows\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
