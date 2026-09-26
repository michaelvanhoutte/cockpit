/**
 * Just enough of the ZIP format to read one file out of the archive GitHub's
 * artifact download endpoint hands back — the record test-record.mjs writes
 * (scripts/lib/test-record.mjs). No dependency earns its weight for one file:
 * the central directory and local file header this reads are a stable part of
 * the format, and Actions artifacts are never encrypted, split across volumes,
 * or big enough to need Zip64.
 *
 * Pure: a `Buffer` in, entries out. `github.js` is the only caller and the
 * only place a network response becomes one of these buffers.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 65535;

/** Deflate (8) and store (0) are the only methods GitHub's own zip writer uses. */
function inflate(method, data) {
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported zip compression method ${method}.`);
}

/**
 * Every entry's name and a `read()` that decompresses it on demand — most
 * callers want one file out of an archive that may hold several, so nothing
 * is inflated until it is asked for.
 *
 * @param {Buffer} buffer
 * @returns {{ name: string, read: () => Buffer }[]}
 */
export function readZipEntries(buffer) {
  const scanFrom = Math.max(0, buffer.length - EOCD_SIZE - MAX_COMMENT);
  let eocd = -1;
  for (let offset = buffer.length - EOCD_SIZE; offset >= scanFrom; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a zip file: no end-of-central-directory record found.');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('Malformed zip: central directory entry missing its signature.');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    entries.push({
      name,
      read: () => readLocalFile(buffer, localHeaderOffset, method, compressedSize),
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readLocalFile(buffer, offset, method, compressedSize) {
  if (buffer.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error('Malformed zip: local file header missing its signature.');
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  return inflate(method, buffer.subarray(dataStart, dataStart + compressedSize));
}

/**
 * `name`'s content, parsed as JSON — matched on the full path or its
 * basename, since an artifact zip nests its file one directory down. `null`
 * where the archive holds no such entry, which the caller reads as "no
 * report" rather than an error: a zip that came back is proof the artifact
 * existed, not proof of what is in it.
 */
export function readZipJson(buffer, name) {
  const entry = readZipEntries(buffer).find((each) => each.name === name || each.name.endsWith(`/${name}`));
  return entry ? JSON.parse(entry.read().toString('utf8')) : null;
}
