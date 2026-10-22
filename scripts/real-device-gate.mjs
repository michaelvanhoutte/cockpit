#!/usr/bin/env node
//
// The I/O around scripts/lib/real-device.mjs, which holds the decision.
// /build runs this with the pull request number before `gh pr ready` and does
// not mark the pull request ready on a refusal.
//
// Usage: node scripts/real-device-gate.mjs <pull request number>
//
// Exit 0: no real-device line is missing its result. Exit 1: refused, with
// each line quoted - or with the reason the body could not be read.
//

import { spawnSync } from 'node:child_process';

import { realDeviceGate } from './lib/real-device.mjs';

const number = process.argv[2];
if (!/^\d+$/.test(number ?? '')) {
  console.error('Usage: node scripts/real-device-gate.mjs <pull request number>');
  process.exit(2);
}

const read = spawnSync('gh', ['pr', 'view', number, '--json', 'body', '-q', '.body'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const body = read.error || read.status !== 0 ? null : read.stdout;
const { ok, refusals } = realDeviceGate(body);
if (!ok) {
  for (const refusal of refusals) console.error(`Not ready: ${refusal}`);
  if (body === null) console.error((read.stderr ?? '').trim() || String(read.error ?? ''));
  process.exit(1);
}
console.log('Real-device gate: no real-device line is missing its result.');
