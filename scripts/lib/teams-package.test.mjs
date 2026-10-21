//
// Unit tests for the Teams app package (scripts/teams-package.mjs), run by
// `node --test` from the Scripts step, like the rest of scripts/lib. Nothing
// here reads a file the test did not import or reaches Teams: what is worth
// asserting is that the package names the right bot and origin, and that the
// zip is one any reader can open.
//

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';

import manifest from '../../packages/connectors/teams/teams-app/manifest.json' with { type: 'json' };
import { appOrigins, checkIcon, filledManifest, packageName, withoutComments, zipOf } from './teams-package.mjs';

const STAGING_ID = '11111111-2222-3333-4444-555555555555';
const PRODUCTION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Shaped like apps/api/wrangler.jsonc where it says the two origins. */
const WRANGLER = `{
  // production's
  "name": "cockpit",
  "vars": {
    "APP_ORIGIN": "https://cockpit.example.dev", // a URL keeps its //
    /* a block comment */
    "GUEST_SIGN_IN": "true",
  },
  "env": {
    "staging": {
      "vars": {
        "APP_ORIGIN": "https://cockpit-staging.example.dev",
      },
    },
  },
}`;

/** The entries a zip holds, read straight from the format rather than through the code that wrote it. */
function entriesOf(zip) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1, 'no end-of-directory record');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, 'not a directory entry');
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const packedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    assert.equal(zip.readUInt32LE(local), 0x04034b50, `${name} has no local header`);
    // A reader that streams the archive trusts the local header alone.
    assert.deepEqual(
      [zip.readUInt16LE(local + 8), zip.readUInt32LE(local + 14), zip.readUInt32LE(local + 18), zip.readUInt32LE(local + 22)],
      [method, crc, packedSize, zip.readUInt32LE(at + 24)],
      `${name}'s local header disagrees with the directory`,
    );
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const packed = zip.subarray(start, start + packedSize);
    const data = method === 8 ? inflateRawSync(packed) : packed;
    assert.equal(crc32(data), crc, `${name}'s checksum`);
    entries.push({ name, data });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}

/** The first 24 bytes of a PNG of this size, which is all a size check reads. */
function pngOf(width, height) {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

describe('a package names the environment it was built for', () => {
  const origins = appOrigins(WRANGLER);

  it("reads each environment's origin from the Worker's own configuration", () => {
    assert.deepEqual(origins, {
      production: 'https://cockpit.example.dev',
      staging: 'https://cockpit-staging.example.dev',
    });
  });

  it('fills every place the manifest names the bot and the origin', () => {
    const filled = filledManifest(manifest, { environment: 'production', appId: PRODUCTION_ID, origin: origins.production });

    assert.equal(filled.id, PRODUCTION_ID);
    assert.equal(filled.bots[0].botId, PRODUCTION_ID);
    assert.equal(filled.composeExtensions[0].botId, PRODUCTION_ID);
    assert.equal(filled.developer.websiteUrl, 'https://cockpit.example.dev');
    assert.equal(filled.developer.privacyUrl, 'https://cockpit.example.dev/privacy');
    assert.deepEqual(filled.validDomains, ['cockpit.example.dev']);
    assert.doesNotMatch(JSON.stringify(filled), /REPLACE_WITH/);
  });

  it('names staging apart, so the admin center never lists two apps called Cockpit', () => {
    const staging = filledManifest(manifest, { environment: 'staging', appId: STAGING_ID, origin: origins.staging });
    const production = filledManifest(manifest, { environment: 'production', appId: PRODUCTION_ID, origin: origins.production });

    // The name the tenant's staging app already has, so an upload never renames it.
    assert.equal(staging.name.short, 'Cockpit Staging');
    assert.equal(production.name.short, 'Cockpit');
  });

  it('keeps the version the manifest carries, which is how Teams tells a new package from the installed one', () => {
    const filled = filledManifest(manifest, { environment: 'staging', appId: STAGING_ID, origin: origins.staging });

    assert.equal(filled.version, manifest.version);
    assert.equal(packageName('staging', filled.version), `cockpit-teams-staging-${manifest.version}.zip`);
  });

  for (const { situation, given, refusal } of [
    { situation: 'an App ID still a placeholder', given: { environment: 'staging', appId: 'REPLACE_WITH_THE_STAGING_AZURE_BOT_APP_ID' }, refusal: /no bot App ID for staging/ },
    { situation: 'no App ID at all', given: { environment: 'production', appId: undefined }, refusal: /no bot App ID for production/ },
    { situation: 'an environment that does not exist', given: { environment: 'prod', appId: PRODUCTION_ID }, refusal: /no environment called "prod"/ },
  ]) {
    it(`builds nothing for ${situation}`, () => {
      assert.throws(() => filledManifest(manifest, { ...given, origin: origins.staging }), refusal);
    });
  }

  it('builds nothing for a placeholder it does not know how to fill', () => {
    const withAnother = { ...manifest, developer: { ...manifest.developer, mpnId: 'REPLACE_WITH_A_PARTNER_ID' } };

    assert.throws(
      () => filledManifest(withAnother, { environment: 'staging', appId: STAGING_ID, origin: origins.staging }),
      /REPLACE_WITH_A_PARTNER_ID/,
    );
  });

  it('builds nothing where the configuration gives an environment no origin', () => {
    assert.throws(() => appOrigins('{ "vars": { "APP_ORIGIN": "https://cockpit.example.dev" } }'), /staging/);
  });
});

describe('reading the Worker configuration as JSON', () => {
  it('leaves comment-like text inside a string alone', () => {
    assert.deepEqual(JSON.parse(withoutComments('{ "a": "https://x/*y*/z, }" , }')), { a: 'https://x/*y*/z, }' });
  });
});

describe('the icons are the sizes Teams accepts', () => {
  for (const { situation, kind, png, refusal } of [
    { situation: 'a 192×192 colour icon', kind: 'color', png: pngOf(192, 192), refusal: null },
    { situation: 'a 32×32 outline icon', kind: 'outline', png: pngOf(32, 32), refusal: null },
    { situation: 'a colour icon of the outline size', kind: 'color', png: pngOf(32, 32), refusal: /color\.png is 32×32; Teams wants 192×192/ },
    { situation: 'an outline icon that is not square', kind: 'outline', png: pngOf(32, 30), refusal: /outline\.png is 32×30/ },
    { situation: 'a file that is not a PNG', kind: 'color', png: Buffer.from('<svg></svg>'), refusal: /not a PNG/ },
  ]) {
    it(`${refusal ? 'refuses' : 'takes'} ${situation}`, () => {
      if (refusal) assert.throws(() => checkIcon(kind, png), refusal);
      else assert.doesNotThrow(() => checkIcon(kind, png));
    });
  }
});

describe('the package is a zip any reader opens', () => {
  const files = [
    { name: 'manifest.json', data: Buffer.from('{"version":"1.0.2"}\n') },
    { name: 'color.png', data: Buffer.alloc(5000, 7) },
    { name: 'outline.png', data: Buffer.from([1, 2, 3]) },
  ];

  it('holds each file at its root, byte for byte', () => {
    assert.deepEqual(
      entriesOf(zipOf(files)).map(({ name, data }) => ({ name, data: data.toString('hex') })),
      files.map(({ name, data }) => ({ name, data: data.toString('hex') })),
    );
  });

  it('is the same bytes every time it is built from the same files', () => {
    assert.ok(zipOf(files).equals(zipOf(files)));
  });
});
