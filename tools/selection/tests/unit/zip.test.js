import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { readZipEntries, readZipJson } from '../../src/zip.js';

/** A minimal, valid zip archive — just enough of the format to round-trip through src/zip.js's own reader. */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, content, method = 0 } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const uncompressed = Buffer.from(content, 'utf8');
    const data = method === 8 ? deflateRawSync(uncompressed) : uncompressed;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const localData = Buffer.concat(localParts);
  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localData.length, 16);

  return Buffer.concat([localData, centralDir, eocd]);
}

describe('readZipEntries', () => {
  it('reads a stored (uncompressed) entry back out', () => {
    const zip = buildZip([{ name: 'record.json', content: '{"a":1}' }]);
    const entries = readZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('record.json');
    expect(entries[0].read().toString('utf8')).toBe('{"a":1}');
  });

  it('reads a deflated entry back out', () => {
    const content = JSON.stringify({ packages: [1, 2, 3], long: 'x'.repeat(500) });
    const zip = buildZip([{ name: 'record.json', content, method: 8 }]);
    expect(readZipEntries(zip)[0].read().toString('utf8')).toBe(content);
  });

  it('reads several entries at their own offsets', () => {
    const zip = buildZip([
      { name: 'a.txt', content: 'first' },
      { name: 'b.txt', content: 'second', method: 8 },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt']);
    expect(entries[0].read().toString('utf8')).toBe('first');
    expect(entries[1].read().toString('utf8')).toBe('second');
  });

  it('refuses a buffer with no end-of-central-directory record', () => {
    expect(() => readZipEntries(Buffer.from('not a zip'))).toThrow(/end-of-central-directory/);
  });

  it('refuses an unsupported compression method', () => {
    const zip = buildZip([{ name: 'a.txt', content: 'x', method: 99 }]);
    expect(() => readZipEntries(zip)[0].read()).toThrow(/Unsupported zip compression method 99/);
  });
});

describe('readZipJson', () => {
  it('parses the named entry as JSON', () => {
    const zip = buildZip([{ name: 'record.json', content: '{"ok":true}' }]);
    expect(readZipJson(zip, 'record.json')).toEqual({ ok: true });
  });

  it('finds the entry nested a directory down, as an artifact archive holds it', () => {
    const zip = buildZip([{ name: 'test-record/record.json', content: '{"ok":true}' }]);
    expect(readZipJson(zip, 'record.json')).toEqual({ ok: true });
  });

  it('returns null where the archive holds no such entry', () => {
    const zip = buildZip([{ name: 'other.json', content: '{}' }]);
    expect(readZipJson(zip, 'record.json')).toBeNull();
  });
});
