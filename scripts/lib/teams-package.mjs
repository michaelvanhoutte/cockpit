// The Teams app package for one environment: the manifest in
// packages/connectors/teams/teams-app/ with that environment's bot App ID and
// origin filled in, zipped with its two icons. Pure, so its test needs no
// file; scripts/teams-package.mjs does the reading and writing.

import { crc32, deflateRawSync } from 'node:zlib';

export const ENVIRONMENTS = ['staging', 'production'];

const PLACEHOLDER_APP_ID = 'REPLACE_WITH_THE_AZURE_BOT_APP_ID';
const PLACEHOLDER_ORIGIN = 'REPLACE_WITH_APP_ORIGIN';

/** An Azure Bot's Microsoft App ID is a GUID; anything else is a value not yet filled in. */
const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What Teams requires of each icon, in pixels. */
export const ICON_SIZES = { color: 192, outline: 32 };

/**
 * Each environment's `APP_ORIGIN`, read from apps/api/wrangler.jsonc, so the
 * origin is said in one place: production's from the top-level `vars`,
 * staging's from `env.staging.vars`.
 */
export function appOrigins(wranglerJsonc) {
  const config = JSON.parse(withoutComments(wranglerJsonc));
  const origins = {
    production: config.vars?.APP_ORIGIN,
    staging: config.env?.staging?.vars?.APP_ORIGIN,
  };
  for (const environment of ENVIRONMENTS) {
    if (typeof origins[environment] !== 'string' || !origins[environment].startsWith('https://')) {
      throw new Error(`apps/api/wrangler.jsonc gives ${environment} no https APP_ORIGIN`);
    }
  }
  return origins;
}

/**
 * JSONC as JSON: comments and trailing commas out, strings left exactly as
 * they are, so a `//` inside a URL survives.
 */
export function withoutComments(text) {
  const comments = outsideStrings(text, (from) => {
    if (text.startsWith('//', from)) {
      const end = text.indexOf('\n', from);
      return (end === -1 ? text.length : end) - from;
    }
    if (text.startsWith('/*', from)) {
      const end = text.indexOf('*/', from + 2);
      if (end === -1) throw new Error('an unclosed /* comment');
      return end + 2 - from;
    }
    return 0;
  });
  const trailing = /,\s*[}\]]/y;
  return outsideStrings(comments, (from) => {
    trailing.lastIndex = from;
    return trailing.test(comments) ? 1 : 0;
  });
}

/** `text` with the characters `skip(at)` counts from each position cut out, never from inside a string. */
function outsideStrings(text, skip) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const cut = skip(i);
    if (cut) {
      i += cut;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

/**
 * The manifest Teams is given for one environment: every placeholder replaced,
 * and staging named apart, so the admin center never shows two apps called
 * "Cockpit". Refuses an App ID that is not a GUID, and a manifest with a
 * placeholder this does not know, rather than build a package Teams refuses
 * or one that points nowhere.
 */
export function filledManifest(manifest, { environment, appId, origin }) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(`no environment called "${environment}": choose ${ENVIRONMENTS.join(' or ')}`);
  }
  if (typeof appId !== 'string' || !APP_ID.test(appId)) {
    throw new Error(
      `no bot App ID for ${environment}: put its Azure Bot's Microsoft App ID in packages/connectors/teams/teams-app/app-ids.json`,
    );
  }
  const host = new URL(origin).host;
  const filled = JSON.parse(
    JSON.stringify(manifest)
      .replaceAll(PLACEHOLDER_APP_ID, appId)
      .replaceAll(`https://${PLACEHOLDER_ORIGIN}`, `https://${host}`)
      .replaceAll(PLACEHOLDER_ORIGIN, host),
  );
  if (environment === 'staging') {
    filled.name = { short: `${manifest.name.short} (staging)`, full: `${manifest.name.full} (staging)` };
  }
  const left = /REPLACE_WITH_[A-Z_]+/.exec(JSON.stringify(filled));
  if (left) throw new Error(`the manifest has a placeholder nothing fills: ${left[0]}`);
  return filled;
}

/** A PNG's width and height, from its header; refuses anything that is not a PNG. */
export function pngSize(png) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (png.length < 24 || !png.subarray(0, 8).equals(signature) || png.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Refuses an icon of the wrong size, which Teams would refuse on upload. */
export function checkIcon(kind, png) {
  const want = ICON_SIZES[kind];
  const { width, height } = pngSize(png);
  if (width !== want || height !== want) {
    throw new Error(`${kind}.png is ${width}×${height}; Teams wants ${want}×${want}`);
  }
}

/** The file name a package is written under, which names what it is for. */
export function packageName(environment, version) {
  return `cockpit-teams-${environment}-${version}.zip`;
}

/**
 * A zip of `files` ({ name, data }), each deflated, at the root of the archive
 * as Teams wants them. Every entry is dated 1980-01-01, the format's earliest
 * date, so the same inputs always make the same bytes.
 */
export function zipOf(files) {
  const DATE = (0 << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
