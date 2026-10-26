/**
 * A minimal, uncompressed zip archive holding one `record.json`, shaped as the answer to GitHub's
 * artifact download: what `readZipJson` reads out again.
 */
export function zipOf(json) {
  const content = Buffer.from(JSON.stringify(json), 'utf8');
  const name = Buffer.from('record.json', 'utf8');
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const localData = Buffer.concat([local, content]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(localData.length, 16);
  const zip = Buffer.concat([localData, central, eocd]);
  return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) };
}
