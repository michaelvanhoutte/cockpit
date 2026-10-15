import { describe, expect, it } from 'vitest';
import { buildResolveAPlace } from '../../../../src/ai/prompts/resolve-a-place.v1.js';
import type { PlaceTreeWorkspace } from '../../../../src/domain/spoken-path.js';

/**
 * L1: what the second call is shown is built purely from the names handed to
 * it ("File a capture on the panels you name, read from the spoken path",
 * issue 1116). Which Workspaces are handed to it - every live one, or the
 * capture's own - is the store's read, held in
 * apps/api/tests/integration/http/note-cleanup-path.test.ts.
 */

const TREE: PlaceTreeWorkspace[] = [
  {
    id: 'home',
    name: 'Home',
    dashboards: [
      {
        id: 'home-day',
        name: 'Day to day',
        panels: [
          { id: 'admin', name: 'Admin & money', kind: 'items' },
          { id: 'notes', name: 'Shopping notes', kind: 'text' },
          { id: 'due', name: 'Due soon', kind: 'filter' },
        ],
      },
    ],
  },
  { id: 'work', name: 'Work', dashboards: [{ id: 'work-day', name: 'Hiring board', panels: [{ id: 'cv', name: 'CVs', kind: 'items' }] }] },
];

describe('Capture', () => {
  describe('reading where a note goes shows the model names only, nested as the account has them', () => {
    const prompt = buildResolveAPlace('day to day, admin and money', TREE);
    const shown = [prompt.system.instructions, prompt.system.stable, prompt.system.recent, prompt.message].join('\n');

    it('lists every workspace, dashboard and panel that takes items, under one another', () => {
      expect(prompt.system.stable).toBe(
        'Places:\nWorkspace: Home\n  Dashboard: Day to day\n    - Admin & money\nWorkspace: Work\n  Dashboard: Hiring board\n    - CVs',
      );
      expect(shown).not.toContain('Shopping notes');
      expect(shown).not.toContain('Due soon');
    });

    it('asks about the words alone, and lets the answer name only what it was shown, or nothing', () => {
      const schema = prompt.schema as { properties: Record<string, { enum?: string[]; items?: { enum: string[] } }> };

      expect(prompt.message).toBe('Where it should go: "day to day, admin and money"');
      expect(schema.properties.workspace?.enum).toEqual(['Home', 'Work', '']);
      expect(schema.properties.dashboard?.enum).toEqual(['Day to day', 'Hiring board', '']);
      expect(schema.properties.panels?.items?.enum).toEqual(['Admin & money', 'CVs']);
    });

    it('carries no item, and nothing the account holds beyond the names, in the part every call shares', () => {
      expect(prompt.system.instructions).toBe(buildResolveAPlace('for work', []).system.instructions);
      // Names, never ids.
      expect(shown).not.toMatch(/home-day|work-day/);
    });
  });
});
