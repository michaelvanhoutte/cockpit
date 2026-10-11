#!/usr/bin/env node
//
// Start the Harness Monitor locally: `pnpm dev:harness`.
//
// Applies the local D1 migrations (idempotent), then runs the Worker on this
// checkout's own port (scripts/lib/ports.mjs, `harnessMonitor`) and prints the
// address. Ctrl+C stops it. The local database is apps/harness-monitor/.wrangler
// and is yours; nothing here touches Cockpit's.
//
// The write key is a local-only value passed as a variable, so no .dev.vars file
// is left behind. Production never comes through this file.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { howToFreeThePort, isLinkedWorktree, portsFor } from './lib/ports.mjs';
import { paint, run, start, supervise } from './lib/processes.mjs';
import { assertPortFree } from './lib/stack.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_WRITE_KEY = 'local-harness-write-key';

let ports;
try {
  ports = portsFor(root, { linked: isLinkedWorktree(root), env: process.env });
  await assertPortFree(ports.harnessMonitor, 'Harness Monitor', () =>
    howToFreeThePort('harnessMonitor', ports.harnessMonitor),
  );
  await run(['--filter', '@harness-monitor/worker', 'db:migrate:local'], 'applying migrations', root);
} catch (error) {
  console.error(paint('31', `\n${error.message}`));
  process.exit(1);
}

console.log(
  `\n${paint('36', 'harness-monitor')} http://localhost:${ports.harnessMonitor}   write key: ${LOCAL_WRITE_KEY}   (Ctrl+C to stop)\n`,
);

supervise([
  start(
    [
      '--filter',
      '@harness-monitor/worker',
      'exec',
      'wrangler',
      'dev',
      '--port',
      String(ports.harnessMonitor),
      '--var',
      `HARNESS_WRITE_KEY:${LOCAL_WRITE_KEY}`,
    ],
    'harness-monitor',
    '36',
    root,
  ),
]);
