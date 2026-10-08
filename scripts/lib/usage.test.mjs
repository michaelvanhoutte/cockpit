//
// Unit tests for what `pnpm usage:export` decides, run by `node --test` from the
// Scripts step. Where a file lands is tested against a real temporary
// directory, because refusing one already there is the platform's answer too.
//

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { exportUsage, periodStart, prepareExport, readArguments, toCsv } from './usage.mjs';

const BOM = '﻿';

function record(over = {}) {
  return {
    id: 1,
    at: '2026-10-06T14:01:09.123Z',
    operation: 'clean-up-a-note',
    promptVersion: 'clean-up-a-note.v11',
    triggeredBy: 'captured-in-app',
    userId: 'u1',
    userName: 'Anna',
    provider: 'anthropic',
    model: 'claude-opus-5',
    paidBy: 'cockpit-anthropic-key',
    paidByAccount: 'wrkspc_1',
    paidByKeyEnding: 'WXYZ',
    outcome: 'ok',
    status: null,
    durationMs: 4210,
    tokensIn: 10,
    cacheRead: 0,
    cacheWrite: 5,
    tokensOut: 7,
    itemId: 'item-1',
    ...over,
  };
}

/** The cells of the one row below the header, split the way Excel splits them. */
function cells(csv) {
  const [, row] = csv.replace(BOM, '').split('\r\n');
  return row;
}

describe('each record is one CSV row Excel reads back as written', () => {
  it('writes a header and one row, UTF-8 marked and CRLF ended', () => {
    const csv = toCsv([record()]);
    assert.ok(csv.startsWith(BOM));
    assert.ok(csv.endsWith('\r\n'));
    assert.equal(
      csv.replace(BOM, '').split('\r\n')[0],
      'When (UTC),Operation,Prompt version,Triggered by,User name,User id,Provider,Model,Paid by,Outcome,Duration (ms),Tokens in,Cache read,Cache write,Tokens out,Item id',
    );
    assert.equal(
      cells(csv),
      `2026-10-06T14:01:09Z,clean-up-a-note,clean-up-a-note.v11,captured-in-app,Anna,u1,anthropic,claude-opus-5,"Cockpit's Anthropic key (workspace wrkspc_1, key ending WXYZ)",ok,4210,10,0,5,7,item-1`,
    );
  });

  const situations = [
    { situation: 'a name with a comma', userName: 'Van Houtte, Anna', cell: '"Van Houtte, Anna"' },
    { situation: 'a name with a quote', userName: 'Anna "Ann" V', cell: '"Anna ""Ann"" V"' },
    { situation: 'a name with a line break', userName: 'Anna\nV', cell: '"Anna\nV"' },
    { situation: 'a name Excel would read as a formula', userName: '=HYPERLINK("x")', cell: '"\'=HYPERLINK(""x"")"' },
    { situation: 'a deleted user, who has no name', userName: '', cell: '' },
  ];
  for (const { situation, userName, cell } of situations) {
    it(`keeps ${situation} in one cell`, () => {
      const row = toCsv([record({ userName, userId: 'gone' })]).replace(BOM, '');
      assert.ok(row.includes(`,${cell},gone,anthropic`), row);
    });
  }

  it('says who paid for a Workers AI reading and for a routine on a Claude plan, naming the routine', () => {
    const reading = cells(toCsv([record({ paidBy: 'cloudflare-workers-ai', paidByAccount: null, paidByKeyEnding: null })]));
    assert.ok(reading.includes(',Cloudflare Workers AI,ok,'), reading);
    const routine = cells(toCsv([record({ paidBy: 'claude-plan', paidByAccount: 'trig_01', paidByKeyEnding: null })]));
    assert.ok(routine.includes(`,The person's own Claude plan (routine trig_01),ok,`), routine);
  });

  it('leaves token counts the provider did not report empty, not 0', () => {
    const row = cells(toCsv([record({ tokensIn: null, cacheRead: null, cacheWrite: null, tokensOut: null })]));
    assert.ok(row.endsWith(',ok,4210,,,,,item-1'), row);
  });

  it('says what a failed or timed out attempt was', () => {
    assert.ok(cells(toCsv([record({ outcome: 'error', status: 529 })])).includes(',error 529,'));
    assert.ok(cells(toCsv([record({ outcome: 'timed-out' })])).includes(',timed out,'));
  });
});

describe('the export holds every record in the period, read a page at a time', () => {
  it('asks for the period from the number of days back, and continues after each page', async () => {
    const asked = [];
    const pages = [
      { records: [record({ id: 1 }), record({ id: 2 })], next: 2 },
      { records: [record({ id: 3 })], next: null },
    ];
    let written;
    const result = await exportUsage({
      ask: async (path) => {
        asked.push(path);
        return pages.shift();
      },
      write: async (text) => {
        written = text;
      },
      days: 30,
      now: new Date('2026-10-08T00:00:00.000Z'),
    });
    const since = encodeURIComponent('2026-09-08T00:00:00.000Z');
    assert.deepEqual(asked, [
      `/v1/operator/usage/records?since=${since}&after=0`,
      `/v1/operator/usage/records?since=${since}&after=2`,
    ]);
    assert.equal(result.records, 3);
    assert.equal(written.replace(BOM, '').split('\r\n').length, 5);
  });

  it('writes nothing but the header where there are no records', async () => {
    let written;
    await exportUsage({
      ask: async () => ({ records: [], next: null }),
      write: async (text) => {
        written = text;
      },
      days: 7,
    });
    assert.equal(written.replace(BOM, '').split('\r\n').length, 2);
  });

  it('writes no file when a page cannot be read', async () => {
    let written = false;
    await assert.rejects(
      exportUsage({
        ask: async () => {
          throw new Error('refused');
        },
        write: async () => {
          written = true;
        },
        days: 7,
      }),
      /refused/,
    );
    assert.equal(written, false);
  });

  it('stops rather than ask forever for a page that does not move on', async () => {
    await assert.rejects(
      exportUsage({
        ask: async () => ({ records: [record()], next: 0 }),
        write: async () => {},
        days: 7,
      }),
      /does not continue/,
    );
  });

  it('counts back whole days from now', () => {
    assert.equal(periodStart(1, new Date('2026-10-08T12:00:00.000Z')), '2026-10-07T12:00:00.000Z');
  });
});

describe('the command never writes over a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-export-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a file already there and leaves it untouched', async () => {
    const out = join(dir, 'there.csv');
    writeFileSync(out, 'earlier');
    await assert.rejects(prepareExport({ out }), /already there/);
    assert.equal(readFileSync(out, 'utf8'), 'earlier');
  });

  it('refuses a file that appears during the run', async () => {
    const out = join(dir, 'appears.csv');
    const place = await prepareExport({ out });
    writeFileSync(out, 'earlier');
    await assert.rejects(place.write('new'), /already there/);
    assert.equal(readFileSync(out, 'utf8'), 'earlier');
  });

  it('makes the folder the file goes in when it is not there', async () => {
    const out = join(dir, 'fresh', 'folder', 'new.csv');
    await (await prepareExport({ out })).write('rows');
    assert.equal(readFileSync(out, 'utf8'), 'rows');
  });

  it('writes a new file', async () => {
    const out = join(dir, 'new.csv');
    await (await prepareExport({ out })).write('rows');
    assert.equal(readFileSync(out, 'utf8'), 'rows');
  });
});

describe('the command says what it was asked for', () => {
  it('reads an environment, a number of days and a file', () => {
    assert.deepEqual(readArguments(['--env', 'staging', '--days', '30', '--out', 'u.csv']), {
      environment: 'staging',
      days: 30,
      out: 'u.csv',
    });
  });

  for (const [situation, argv, message] of [
    ['no environment', ['--days', '30', '--out', 'u.csv'], /--env/],
    ['an unknown environment', ['--env', 'prod', '--days', '30', '--out', 'u.csv'], /no environment prod/],
    ['no days', ['--env', 'staging', '--out', 'u.csv'], /--days/],
    ['days that are not a number', ['--env', 'staging', '--days', 'many', '--out', 'u.csv'], /whole number/],
    ['more days than are kept', ['--env', 'staging', '--days', '366', '--out', 'u.csv'], /1 to 365/],
    ['no file', ['--env', 'staging', '--days', '30'], /--out/],
  ]) {
    it(`refuses ${situation}`, () => {
      assert.throws(() => readArguments(argv), message);
    });
  }
});
