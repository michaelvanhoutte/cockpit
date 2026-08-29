import { describe, expect, it } from 'vitest';
import { buildTree, matchingConcepts, resolveFiles, unregisteredAreas, withInfrastructure } from '../../src/analyze/concepts.js';
import { INFRASTRUCTURE_KEY, INFRASTRUCTURE_LABEL } from '../../src/model.js';

const CONCEPTS = [
  { key: 'Capture', label: 'Capture', sourcePatterns: ['apps/api/src/domain/items.ts', 'apps/web/src/item/**'] },
  { key: 'Triage', label: 'Triage', sourcePatterns: ['apps/api/src/domain/items.ts'] },
  { key: 'Offline', label: 'Offline', sourcePatterns: ['packages/shared/src/ids.ts'] },
];

describe('globToRegExp (via matchingConcepts)', () => {
  it('matches a literal path exactly', () => {
    expect(matchingConcepts(CONCEPTS, 'apps/api/src/domain/items.ts')).toEqual(['Capture', 'Triage']);
  });

  it('does not match a different file with the same prefix', () => {
    expect(matchingConcepts(CONCEPTS, 'apps/api/src/domain/items-extra.ts')).toEqual([]);
  });

  it('matches a single "*" only within one path segment', () => {
    const concepts = [{ key: 'X', label: 'X', sourcePatterns: ['apps/web/src/components/*.tsx'] }];
    expect(matchingConcepts(concepts, 'apps/web/src/components/CaptureForm.tsx')).toEqual(['X']);
    expect(matchingConcepts(concepts, 'apps/web/src/components/nested/Deep.tsx')).toEqual([]);
  });

  it('matches "**" across multiple path segments', () => {
    expect(matchingConcepts(CONCEPTS, 'apps/web/src/item/panel/Row.tsx')).toEqual(['Capture']);
    expect(matchingConcepts(CONCEPTS, 'apps/web/src/item/Row.tsx')).toEqual(['Capture']);
  });

  it('escapes regex metacharacters in a pattern so they are not treated as regex syntax', () => {
    const concepts = [{ key: 'X', label: 'X', sourcePatterns: ['packages/shared/src/a.b+c.ts'] }];
    expect(matchingConcepts(concepts, 'packages/shared/src/aXbXc.ts')).toEqual([]);
    expect(matchingConcepts(concepts, 'packages/shared/src/a.b+c.ts')).toEqual(['X']);
  });
});

describe('resolveFiles', () => {
  it('resolves a file to every area whose patterns match it, not just the first', () => {
    const byFile = resolveFiles(CONCEPTS, ['apps/api/src/domain/items.ts']);
    expect(byFile.get('apps/api/src/domain/items.ts')).toEqual(['Capture', 'Triage']);
  });

  it('falls back to the infrastructure bucket for a file matching no area', () => {
    const byFile = resolveFiles(CONCEPTS, ['apps/api/src/env.ts']);
    expect(byFile.get('apps/api/src/env.ts')).toEqual([INFRASTRUCTURE_KEY]);
  });
});

describe('withInfrastructure', () => {
  it('appends a synthetic infrastructure entry with no source patterns of its own', () => {
    const withInfra = withInfrastructure(CONCEPTS);
    expect(withInfra).toHaveLength(CONCEPTS.length + 1);
    const infra = withInfra.at(-1);
    expect(infra.key).toBe(INFRASTRUCTURE_KEY);
    expect(infra.label).toBe(INFRASTRUCTURE_LABEL);
    expect(infra.sourcePatterns).toEqual([]);
  });
});

describe('buildTree', () => {
  const makeNode = (c) => ({ key: c.key, label: c.label });

  it('puts every concept with no parent at the root, in registry order', () => {
    const { tree } = buildTree(CONCEPTS, makeNode);
    expect(tree.map((n) => n.key)).toEqual(['Capture', 'Triage', 'Offline']);
    expect(tree.every((n) => n.children.length === 0)).toBe(true);
  });

  it('nests a concept under its parent', () => {
    const concepts = [
      { key: 'Dashboards', label: 'Dashboards', sourcePatterns: [] },
      { key: 'Drag-drop', label: 'Drag-drop', sourcePatterns: [], parent: 'Dashboards' },
      { key: 'Resizing', label: 'Resizing', sourcePatterns: [], parent: 'Dashboards' },
    ];
    const { tree, warnings } = buildTree(concepts, makeNode);
    expect(warnings).toEqual([]);
    expect(tree).toHaveLength(1);
    expect(tree[0].key).toBe('Dashboards');
    expect(tree[0].children.map((c) => c.key)).toEqual(['Drag-drop', 'Resizing']);
  });

  it('supports more than one level of nesting', () => {
    const concepts = [
      { key: 'Dashboards', label: 'Dashboards', sourcePatterns: [] },
      { key: 'Drag-drop', label: 'Drag-drop', sourcePatterns: [], parent: 'Dashboards' },
      { key: 'Multi-select drag', label: 'Multi-select drag', sourcePatterns: [], parent: 'Drag-drop' },
    ];
    const { tree } = buildTree(concepts, makeNode);
    expect(tree[0].children[0].children.map((c) => c.key)).toEqual(['Multi-select drag']);
  });

  it('treats a parent pointing at an unregistered key as a root, with a warning', () => {
    const concepts = [{ key: 'Drag-drop', label: 'Drag-drop', sourcePatterns: [], parent: 'Nope' }];
    const { tree, warnings } = buildTree(concepts, makeNode);
    expect(tree.map((n) => n.key)).toEqual(['Drag-drop']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Nope/);
  });

  it('treats a parent cycle as roots, with a warning, instead of dropping both nodes silently', () => {
    const concepts = [
      { key: 'A', label: 'A', sourcePatterns: [], parent: 'B' },
      { key: 'B', label: 'B', sourcePatterns: [], parent: 'A' },
    ];
    const { tree, warnings } = buildTree(concepts, makeNode);
    expect(tree.map((n) => n.key).sort()).toEqual(['A', 'B']);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('unregisteredAreas', () => {
  it('reports an area name used in a describe but absent from the registry', () => {
    expect(unregisteredAreas(CONCEPTS, ['Capture', 'Trige'])).toEqual(['Trige']);
  });

  it('reports an area even when it was never attached to any rule (an empty describe)', () => {
    // This is the case the original check missed: an outer describe with no cases yet still
    // produces a name in `usedAreaNames`, and that alone must be enough to catch a typo.
    expect(unregisteredAreas(CONCEPTS, ['Trige'])).toEqual(['Trige']);
  });

  it('returns nothing when every used area is registered', () => {
    expect(unregisteredAreas(CONCEPTS, ['Capture', 'Triage', 'Capture'])).toEqual([]);
  });
});
