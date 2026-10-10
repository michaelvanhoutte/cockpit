/**
 * The wiring: readCheckout(root) -> buildModel(...) -> renderHtml(model) -> files.
 *
 * Nothing is written until the model is built and the page rendered: a file
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
import { renderDiagramPages, renderHtml } from './render/html.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: node src/cli.js [options]

  --out <path>     where to write (default ../out/index.html, or model.json with --json); the diagram pages go beside it
  --json           write the model instead of the page (and the diagram pages)
  --model <path>   also write the model, as --json would, to this path
  --root <path>    the checkout to draw (default: the repository this tool is in)
  --previous <location>  the previous report's model, a file or an address; What changed compares with the commit it names
  --help
`;

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
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

  const out = path.resolve(args.out ?? path.join(here, '../out', args.json ? 'model.json' : 'index.html'));
  if (args.model && path.resolve(args.model) === out) {
    process.stderr.write(`--model and --out cannot be the same path\n\n${USAGE}`);
    return 2;
  }

  let model;
  let page;
  let diagramPages = {};
  try {
    const root = path.resolve(args.root ?? path.join(here, '../../..'));
    const checkout = readCheckout(root);
    model = buildModel(checkout);
    // Only the page shows the comparison, so only the page pays for the second drawing.
    const comparison = args.json ? null : await compareWithPrevious({ root, model, description: checkout.description, previous: args.previous });
    if (comparison) process.stderr.write(`what changed: ${comparison.state === 'compared' ? `${comparison.changes.length} changes since ${comparison.from.commit.slice(0, 7)}` : comparison.state === 'first' ? 'first report' : comparison.reason}\n`);
    page = args.json ? modelJson(model) : renderHtml(model, { comparison });
    if (!args.json) diagramPages = renderDiagramPages(model);
  } catch (error) {
    if (error instanceof ReadError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const written = [[out, page]];
  for (const [name, content] of Object.entries(diagramPages)) written.push([path.join(path.dirname(out), name), content]);
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
