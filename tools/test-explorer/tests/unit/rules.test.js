import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { extractRules, levelForTestFile } from '../../src/analyze/rules.js';

function sourceOf(text) {
  return ts.createSourceFile('fixture.test.ts', text, ts.ScriptTarget.Latest, true);
}

describe('levelForTestFile', () => {
  it('maps apps/api unit tests to L1', () => {
    expect(levelForTestFile('apps/api/tests/unit/domain/items.test.ts')).toBe('L1');
  });

  it('maps apps/api integration tests to L2', () => {
    expect(levelForTestFile('apps/api/tests/integration/http/x.test.ts')).toBe('L2');
  });

  it('maps a backend system-level test to L3', () => {
    expect(levelForTestFile('apps/api/tests/system/x.test.ts')).toBe('L3');
  });

  it('maps apps/web unit tests to F1', () => {
    expect(levelForTestFile('apps/web/tests/unit/components/X.test.tsx')).toBe('F1');
  });

  it('maps apps/web service tests to F2', () => {
    expect(levelForTestFile('apps/web/tests/service/x.test.ts')).toBe('F2');
  });

  it('maps repo-root tests/e2e to F3', () => {
    expect(levelForTestFile('tests/e2e/x.test.ts')).toBe('F3');
  });

  it('maps a connector package contract test to Contract', () => {
    expect(levelForTestFile('packages/connectors/gmail/tests/contract/x.test.ts')).toBe('Contract');
  });

  it('returns null for a path with no recognizable tests/<level>/ shape', () => {
    expect(levelForTestFile('apps/api/src/domain/items.test.ts')).toBeNull();
  });

  it('returns null for an unrecognized level folder name', () => {
    expect(levelForTestFile('apps/api/tests/whatever/x.test.ts')).toBeNull();
  });
});

describe('extractRules', () => {
  it('extracts one rule per inner describe, with its concept, statement, level, and each case\'s own text and line', () => {
    const source = sourceOf(`
      describe('Capture', () => {
        describe('a thought becomes an item to process', () => {
          it('stamps it with the time it was made', () => {});
        });
      });
    `);
    const { rules, areasSeen, warnings } = extractRules(source, 'apps/api/tests/unit/domain/items.test.ts', 'L1');
    expect(warnings).toEqual([]);
    expect(areasSeen).toEqual(['Capture']);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      concept: 'Capture',
      statement: 'a thought becomes an item to process',
      level: 'L1',
      file: 'apps/api/tests/unit/domain/items.test.ts',
      line: 3,
    });
    expect(rules[0].cases).toEqual([
      { text: 'stamps it with the time it was made', file: 'apps/api/tests/unit/domain/items.test.ts', line: 4 },
    ]);
    expect(rules[0].todoCases).toEqual([]);
  });

  it('produces one rule per top-level describe when there is no inner describe', () => {
    const source = sourceOf(`
      describe('Offline', () => {
        it('generates an id with no server round trip', () => {});
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'L1');
    expect(rules).toHaveLength(1);
    expect(rules[0].statement).toBe('Offline');
  });

  it('keeps it.todo separate from real cases and does not count it as one', () => {
    const source = sourceOf(`
      describe('Triage', () => {
        describe('a rule with one real case and one todo', () => {
          it('a real case', () => {});
          it.todo('a case not written yet');
        });
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'L1');
    expect(rules[0].cases.map((c) => c.text)).toEqual(['a real case']);
    expect(rules[0].todoCases.map((c) => c.text)).toEqual(['a case not written yet']);
  });

  it('drops a describe with zero real and zero todo cases from `rules`, but still reports it in areasSeen', () => {
    const source = sourceOf(`
      describe('Panels', () => {
        describe('not written yet', () => {});
      });
    `);
    const { rules, areasSeen } = extractRules(source, 'x.test.ts', 'L1');
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
    const { rules, areasSeen } = extractRules(source, 'x.test.ts', 'L1');
    expect(areasSeen).toEqual(['Capture']);
    expect(rules).toHaveLength(1);
    expect(rules[0].cases).toHaveLength(1);
  });

  it('recognizes describe.only at the top level the same way as a bare describe', () => {
    const source = sourceOf(`
      describe.only('Triage', () => {
        describe('a rule', () => {
          it('a case', () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'L1');
    expect(rules).toHaveLength(1);
  });

  it('recognizes it.each(table)(name, fn) as one case per call, not the whole table as one case', () => {
    // it.each(table)(name, fn) is two chained calls: matching only a bare `it.<x>` callee (as
    // .skip/.only are) would instead match the *inner* call, it.each(table), and read the whole
    // data table as the case's "name" — this is the regression test for that.
    const source = sourceOf(`
      describe('Triage', () => {
        describe('a rule with a data table', () => {
          it.each([
            { name: 'a' },
            { name: 'b' },
          ])('$name is handled', () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'L1');
    expect(rules[0].cases).toHaveLength(1);
    expect(rules[0].cases[0].text).toBe('$name is handled');
  });

  it('recognizes test.each the same way as it.each', () => {
    const source = sourceOf(`
      describe('Triage', () => {
        describe('a rule', () => {
          test.each(['a', 'b'])('%s is handled', () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'L1');
    expect(rules[0].cases).toHaveLength(1);
    expect(rules[0].cases[0].text).toBe('%s is handled');
  });
});
