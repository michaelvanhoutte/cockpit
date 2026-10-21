#!/usr/bin/env node
//
// Builds the Teams app package for one environment, the zip uploaded in the
// Teams admin center: packages/connectors/teams/teams-app/manifest.json with
// that environment's bot App ID (teams-app/app-ids.json) and origin
// (apps/api/wrangler.jsonc) filled in, zipped with the two icons beside it.
// The `teams-app-upload` skill runs this and then uploads what it prints.
//
// Usage: node scripts/teams-package.mjs <staging|production>
//
// Writes teams-app/dist/cockpit-teams-<environment>-<version>.zip, which git
// ignores, and prints its path on the last line.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appOrigins, checkIcon, ENVIRONMENTS, filledManifest, packageName, zipOf } from './lib/teams-package.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'packages/connectors/teams/teams-app');

const environment = process.argv[2];
if (!ENVIRONMENTS.includes(environment)) {
  console.error(`Usage: node scripts/teams-package.mjs <${ENVIRONMENTS.join('|')}>`);
  process.exit(2);
}

try {
  const manifest = JSON.parse(readFileSync(join(appDir, 'manifest.json'), 'utf8'));
  let appIds;
  try {
    appIds = JSON.parse(readFileSync(join(appDir, 'app-ids.json'), 'utf8'));
  } catch {
    throw new Error('packages/connectors/teams/teams-app/app-ids.json is missing or not JSON: it maps staging and production to their bot App IDs');
  }
  const origin = appOrigins(readFileSync(join(root, 'apps/api/wrangler.jsonc'), 'utf8'))[environment];
  const filled = filledManifest(manifest, { environment, appId: appIds[environment], origin });

  const icons = {};
  for (const kind of ['color', 'outline']) {
    try {
      icons[kind] = readFileSync(join(appDir, `${kind}.png`));
    } catch {
      throw new Error(`no ${kind}.png in packages/connectors/teams/teams-app/`);
    }
    checkIcon(kind, icons[kind]);
  }

  const zip = zipOf([
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(filled, null, 2)}\n`, 'utf8') },
    { name: 'color.png', data: icons.color },
    { name: 'outline.png', data: icons.outline },
  ]);
  const out = join(appDir, 'dist', packageName(environment, filled.version));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zip);

  console.log(`${filled.name.short} ${filled.version}, bot ${filled.id}, for ${origin}`);
  console.log(out);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
