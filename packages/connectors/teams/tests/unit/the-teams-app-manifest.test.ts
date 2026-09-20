import { describe, expect, it } from 'vitest';
import manifest from '../../teams-app/manifest.json';

/**
 * L1: the manifest is data Teams judges on upload, and nothing here can run
 * Teams' own validator - so what is held is what has already gone wrong or
 * what would silently take the action out of somebody's chat.
 */

/**
 * The top-level properties this manifest is known to carry, each of them
 * present in Teams' 1.17 schema (the `$schema` address inside it). A property
 * added to the file has to be added here, which is the moment somebody opens
 * that schema and checks it: Teams refuses an upload for one it does not
 * define, and the first one that was invented (`packageName`) was found only
 * by uploading.
 */
const CHECKED_AGAINST_THE_SCHEMA = [
  '$schema',
  'manifestVersion',
  'version',
  'id',
  'developer',
  'name',
  'description',
  'icons',
  'accentColor',
  'bots',
  'composeExtensions',
  'permissions',
  'validDomains',
];

describe('Capture', () => {
  describe('the Teams app lists only properties somebody has checked against its schema', () => {
    it('carries no top-level property that has not been checked', () => {
      const unchecked = Object.keys(manifest).filter(
        (property) => !CHECKED_AGAINST_THE_SCHEMA.includes(property),
      );

      expect(unchecked).toEqual([]);
    });
  });

  describe('Save to Cockpit is offered wherever a message can be saved', () => {
    it.each([
      { where: 'a chat with one other person', scope: 'personal' },
      { where: 'a channel of a team', scope: 'team' },
      { where: 'a group chat', scope: 'groupChat' },
    ])('$where', ({ scope }) => {
      const [bot] = manifest.bots;

      expect(bot?.scopes).toContain(scope);
    });

    it('the app, its bot and its message extension are one bot', () => {
      const [bot] = manifest.bots;
      const [extension] = manifest.composeExtensions;

      expect(manifest.bots).toHaveLength(1);
      expect(bot?.botId).toBe(manifest.id);
      expect(extension?.botId).toBe(manifest.id);
    });
  });
});
