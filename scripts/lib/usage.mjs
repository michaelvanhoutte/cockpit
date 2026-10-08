//
// Everything `pnpm usage:export` decides, with the fetching and the file
// injected, like backup.mjs: the CSV a record becomes, the period a number of
// days means, and the refusal to write over a file. The runner
// (scripts/usage-export.mjs) supplies a real `ask` and a real `write`.
//

import * as fsp from 'node:fs/promises';
import { dirname } from 'node:path';

import { readEnvironment, readFlags } from './operator.mjs';

/** The most days a run can ask for: the records are kept for twelve months. */
export const MAX_DAYS = 365;

/** What the command was asked to do. */
export function readArguments(argv) {
  const args = readFlags(argv, { takes: { '--env': 'environment', '--days': 'days', '--out': 'out' } });
  if (!args.environment) throw new Error('--env says which environment to export');
  readEnvironment(args.environment);
  if (!args.days) throw new Error('--days says how many days back to export');
  if (!/^[1-9]\d*$/.test(args.days) || Number(args.days) > MAX_DAYS) {
    throw new Error(`--days is a whole number of days from 1 to ${MAX_DAYS} - the records are kept for twelve months`);
  }
  if (!args.out) throw new Error('--out says which file to write');
  return { ...args, days: Number(args.days) };
}

/** The start of the period, as the route reads it. */
export function periodStart(days, now) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

const PAID_BY = Object.freeze({
  'cockpit-anthropic-key': "Cockpit's Anthropic key",
  'cloudflare-workers-ai': 'Cloudflare Workers AI',
  'claude-plan': "The person's own Claude plan",
});

/** What a kind's `paidByAccount` names: the Anthropic workspace, or the routine fired. */
const ACCOUNT_IS = Object.freeze({ 'claude-plan': 'routine' });

/** The columns, in the order Excel shows them, each reading one record. */
const COLUMNS = Object.freeze([
  ['When (UTC)', (r) => r.at.replace(/\.\d+Z$/, 'Z')],
  ['Operation', (r) => r.operation],
  ['Prompt version', (r) => r.promptVersion],
  ['Triggered by', (r) => r.triggeredBy],
  ['User name', (r) => r.userName],
  ['User id', (r) => r.userId],
  ['Provider', (r) => r.provider],
  ['Model', (r) => r.model],
  ['Paid by', paidBy],
  ['Outcome', outcomeOf],
  ['Duration (ms)', (r) => r.durationMs],
  ['Tokens in', (r) => r.tokensIn],
  ['Cache read', (r) => r.cacheRead],
  ['Cache write', (r) => r.cacheWrite],
  ['Tokens out', (r) => r.tokensOut],
  ['Item id', (r) => r.itemId],
]);

function paidBy(record) {
  const details = [
    record.paidByAccount && `${ACCOUNT_IS[record.paidBy] ?? 'workspace'} ${record.paidByAccount}`,
    record.paidByKeyEnding && `key ending ${record.paidByKeyEnding}`,
  ].filter(Boolean);
  const who = PAID_BY[record.paidBy] ?? record.paidBy;
  return details.length ? `${who} (${details.join(', ')})` : who;
}

function outcomeOf(record) {
  if (record.outcome === 'timed-out') return 'timed out';
  if (record.outcome === 'error') return record.status ? `error ${record.status}` : 'error';
  return record.outcome;
}

/**
 * One cell. Nothing reported is an empty cell rather than 0, which is the
 * difference between "no tokens" and "the provider does not say".
 *
 * Text that Excel would read as a formula (a name Google lets somebody set to
 * `=HYPERLINK(...)`) is led by an apostrophe, which Excel does not show, so it
 * stays a cell of text.
 */
function cell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The header row, and one row per record, as the file holds them. */
export function toCsv(records) {
  const header = COLUMNS.map(([name]) => cell(name)).join(',');
  const rows = records.map((record) => COLUMNS.map(([, read]) => cell(read(record))).join(','));
  // The mark that tells Excel the file is UTF-8, without which a name with an
  // accent opens as noise; CRLF is the line break it expects.
  return `﻿${[header, ...rows].join('\r\n')}\r\n`;
}

/**
 * Reads every page of the period and writes the file.
 *
 * **The file is created only after every page is read**, and never over one
 * already there (`write` creates it exclusively), so a run that stops partway
 * leaves nothing that reads as a complete export, and an earlier export is
 * never lost to a later one.
 */
export async function exportUsage({ ask, write, days, now = new Date() }) {
  const since = encodeURIComponent(periodStart(days, now));
  const records = [];
  let after = 0;
  for (;;) {
    const page = await ask(`/v1/operator/usage/records?since=${since}&after=${after}`);
    if (!page || !Array.isArray(page.records)) {
      throw new Error('reading the records got an answer that is not one - is something in front of this environment?');
    }
    records.push(...page.records);
    if (page.next === null || page.next === undefined) break;
    // A page that does not move on would be asked for forever.
    if (!Number.isInteger(page.next) || page.next <= after) {
      throw new Error('reading the records got a page that does not continue - is something in front of this environment?');
    }
    after = page.next;
  }
  await write(toCsv(records));
  return { records: records.length };
}

/**
 * Where the file goes: refused before anything is fetched if something is
 * already there, and written exclusively so one that appears during the run is
 * refused too. `disk` is `node:fs/promises` unless a test hands it another.
 */
export async function prepareExport({ out, disk = fsp }) {
  const there = new Error(`${out} is already there. An export is not written over: name a file that is new.`);
  try {
    await disk.lstat(out);
    throw there;
  } catch (error) {
    if (error === there) throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  // `usage/` is gitignored, so it is not there in a fresh checkout: make it now,
  // not after every page has been read.
  await disk.mkdir(dirname(out), { recursive: true });
  return {
    async write(text) {
      try {
        await disk.writeFile(out, text, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        throw error.code === 'EEXIST' ? there : error;
      }
    },
  };
}
