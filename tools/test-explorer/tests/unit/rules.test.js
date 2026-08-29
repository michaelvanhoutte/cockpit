import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { columnAndLevelForTestFile, extractRules } from '../../src/analyze/rules.js';

function sourceOf(text) {
  return ts.createSourceFile('fixture.test.ts', text, ts.ScriptTarget.Latest, true);
}

describe('columnAndLevelForTestFile', () => {
  it('maps apps/api unit tests to backend/unit', () => {
    expect(columnAndLevelForTestFile('apps/api/tests/unit/domain/items.test.ts')).toEqual({ column: 'backend', level: 'unit' });
  });

  it('maps apps/api integration tests to backend/integration', () => {
    expect(columnAndLevelForTestFile('apps/api/tests/integration/http/x.test.ts')).toEqual({ column: 'backend', level: 'integration' });
  });

  it('maps apps/web tests to frontend', () => {
    expect(columnAndLevelForTestFile('apps/web/tests/unit/components/X.test.tsx')).toEqual({ column: 'frontend', level: 'unit' });
  });

  it('maps repo-root tests/e2e to browser', () => {
    expect(columnAndLevelForTestFile('tests/e2e/x.test.ts')).toEqual({ column: 'browser', level: 'e2e' });
  });

  it('maps a connector package contract test to contract', () => {
    expect(columnAndLevelForTestFile('packages/connectors/gmail/tests/contract/x.test.ts')).toEqual({
      column: 'contract',
      level: 'contract',
    });
  });

  it('returns null for a path with no recognizable tests/<level>/ shape', () => {
    expect(columnAndLevelForTestFile('apps/api/src/domain/items.test.ts')).toBeNull();
  });
});

describe('extractRules', () => {
  it('extracts one rule per inner describe, with its concept, statement and case count', () => {
    const source = sourceOf(`
      describe('Capture', () => {
        describe('a thought becomes an item to process', () => {
          it('stamps it with the time it was made', () => {});
        });
      });
    `);
    const { rules, areasSeen, warnings } = extractRules(source, 'apps/api/tests/unit/domain/items.test.ts', 'backend');
    expect(warnings).toEqual([]);
    expect(areasSeen).toEqual(['Capture']);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      concept: 'Capture',
      statement: 'a thought becomes an item to process',
      column: 'backend',
      level: 'unit',
      cases: 1,
      todoCases: 0,
    });
  });

  it('produces one rule per top-level describe when there is no inner describe', () => {
    const source = sourceOf(`
      describe('Offline', () => {
        it('generates an id with no server round trip', () => {});
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'backend');
    expect(rules).toHaveLength(1);
    expect(rules[0].statement).toBe('Offline');
  });

  it('counts it.todo separately from real cases and does not count it toward `cases`', () => {
    const source = sourceOf(`
      describe('Triage', () => {
        describe('a rule with one real case and one todo', () => {
          it('a real case', () => {});
          it.todo('a case not written yet');
        });
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'backend');
    expect(rules[0].cases).toBe(1);
    expect(rules[0].todoCases).toBe(1);
  });

  it('drops a describe with zero real and zero todo cases from `rules`, but still reports it in areasSeen', () => {
    const source = sourceOf(`
      describe('Panels', () => {
        describe('not written yet', () => {});
      });
    `);
    const { rules, areasSeen } = extractRules(source, 'x.test.ts', 'backend');
    expect(rules).toEqual([]);
    expect(areasSeen).toEqual(['Panels']);
  });

  it('recognizes describe.skip at the top level and still extracts its rules and cases', () => {
    const source = sourceOf(`
      describe.skip('Capture', () => {
        describe('a rule inside a temporarily skipped suite', () => {
          it('still a real, written case', () => {});
        });
      });
    `);
    const { rules, areasSeen } = extractRules(source, 'x.test.ts', 'backend');
    expect(areasSeen).toEqual(['Capture']);
    expect(rules).toHaveLength(1);
    expect(rules[0].cases).toBe(1);
  });

  it('recognizes describe.only at the top level the same way as a bare describe', () => {
    const source = sourceOf(`
      describe.only('Triage', () => {
        describe('a rule', () => {
          it('a case', () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'backend');
    expect(rules).toHaveLength(1);
  });
});
