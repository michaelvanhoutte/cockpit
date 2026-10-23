import { describe, expect, it } from 'vitest';
import { kindOfResource, resourcesOf } from '../../../src/mcp/resources.js';

/**
 * L1: what an app is, from the resource it is signed in for ("Read a Panel from
 * an app allowed only to read, and open Capture from its address", issue 1445).
 * That a token of either kind then reaches only its own addresses is
 * tests/integration/http/panel-reads-access.test.ts.
 */
const ENV = { APP_ORIGIN: 'https://cockpit.test' };

describe('MCP connections', () => {
  describe('an app signed in for the Panel reads is one that reads your Panels, and any other is one that captures', () => {
    it.each([
      { situation: 'signed in for the reads of Panels', resource: 'https://cockpit.test/apps', kind: 'reads-panels' },
      { situation: 'signed in for MCP, as Claude is', resource: 'https://cockpit.test/mcp', kind: 'captures' },
      { situation: 'a grant made before resources existed, which holds none', resource: undefined, kind: 'captures' },
      { situation: 'signed in for the reads of another Cockpit', resource: 'https://elsewhere.test/apps', kind: 'captures' },
    ])('$situation', ({ resource, kind }) => {
      expect(kindOfResource(ENV, resource)).toBe(kind);
    });

    it('names both resources on the address Cockpit is reached on, without a path or a trailing slash on the origin', () => {
      expect(resourcesOf({ APP_ORIGIN: 'https://cockpit.test/' })).toEqual({
        mcp: 'https://cockpit.test/mcp',
        apps: 'https://cockpit.test/apps',
      });
    });
  });
});
