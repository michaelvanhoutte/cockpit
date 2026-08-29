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

  it('maps a connector package unit test to L1, not null — packages/connectors/<name>/ nests one level deeper than packages/<name>/', () => {
    expect(levelForTestFile('packages/connectors/gmail/tests/unit/client.test.ts')).toBe('L1');
  });

  it('maps a connector package integration test to L2', () => {
    expect(levelForTestFile('packages/connectors/gmail/tests/integration/x.test.ts')).toBe('L2');
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

  it('recognizes it.each(table)(name, fn) as one case per row, not the whole table as one case', () => {
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
    expect(rules[0].cases.map((c) => c.text)).toEqual(['a is handled', 'b is handled']);
  });

  it('recognizes test.each the same way as it.each, substituting %s positionally', () => {
    const source = sourceOf(`
      describe('Triage', () => {
        describe('a rule', () => {
          test.each(['a', 'b'])('%s is handled', () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'L1');
    expect(rules[0].cases.map((c) => c.text)).toEqual(['a is handled', 'b is handled']);
  });

  it('resolves the row property a template actually names, leaving an unresolvable sibling property out of it', () => {
    // The real case that prompted this (packages/shared/tests/unit/commands.test.ts): the row's
    // `situation` is a literal, but a sibling property is built from a runtime call (uuidv7(), new
    // Date()) — that must not stop `situation` itself from resolving.
    const source = sourceOf(`
      describe('Capture', () => {
        describe('a capture missing what the app needs is refused', () => {
          it.each([
            { situation: 'without a request id', capture: { itemId: uuidv7() } },
          ])('$situation', () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'L1');
    expect(rules[0].cases.map((c) => c.text)).toEqual(['without a request id']);
  });

  it('substitutes %j/%o as JSON and %# as the row index', () => {
    const source = sourceOf(`
      describe('Triage', () => {
        describe('a rule', () => {
          it.each([{ a: 1 }, { a: 2 }])('row %# is %j', () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'L1');
    expect(rules[0].cases.map((c) => c.text)).toEqual(['row 0 is {"a":1}', 'row 1 is {"a":2}']);
  });

  it('leaves an unresolvable placeholder exactly as written rather than guessing', () => {
    const source = sourceOf(`
      describe('Triage', () => {
        describe('a rule', () => {
          it.each([{ known: 'x' }])('$known / $unknown', () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'L1');
    expect(rules[0].cases[0].text).toBe('x / $unknown');
  });

  it('falls back to one case with the raw template when the table is not an array literal at all', () => {
    const source = sourceOf(`
      describe('Triage', () => {
        describe('a rule', () => {
          it.each(situations)('$name is handled', () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'x.test.ts', 'L1');
    expect(rules[0].cases).toHaveLength(1);
    expect(rules[0].cases[0].text).toBe('$name is handled');
  });
});

// Playwright, the F3 runner, hangs describe off `test` instead of exposing it as a
// free function. These cover that dialect, because an F3 file that parsed as "no
// rules, several oddly-named cases" would have been reported as a populated column
// with nothing in it rather than as an error anyone would notice.
describe('extractRules, on Playwright-style files', () => {
  it('reads test.describe as the feature area and its child as the rule', () => {
    const source = sourceOf(`
      test.describe('Capture', () => {
        test.describe('a captured thought appears in the inbox', () => {
          test('lists the thought to process', async () => {});
        });
      });
    `);
    const { rules, areasSeen } = extractRules(source, 'tests/e2e/capture.test.ts', 'F3');
    expect(areasSeen).toEqual(['Capture']);
    expect(rules).toHaveLength(1);
    expect(rules[0].concept).toBe('Capture');
    expect(rules[0].statement).toBe('a captured thought appears in the inbox');
    expect(rules[0].cases.map((c) => c.text)).toEqual(['lists the thought to process']);
  });

  it('reads the modifier forms, so a temporarily skipped suite keeps its rules', () => {
    const source = sourceOf(`
      test.describe.serial('Triage', () => {
        test.describe.skip('dismissing an item takes it out of the inbox', () => {
          test('leaves the inbox once dismissed', async () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'tests/e2e/triage.test.ts', 'F3');
    expect(rules).toHaveLength(1);
    expect(rules[0].concept).toBe('Triage');
    expect(rules[0].statement).toBe('dismissing an item takes it out of the inbox');
  });

  it('counts neither a nested test.describe nor a hook as a case', () => {
    const source = sourceOf(`
      test.describe('Capture', () => {
        test.describe('a rule', () => {
          test.beforeEach(async () => {});
          test.afterAll(async () => {});
          test.use({ viewport: null });
          test('the only case here', async () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'tests/e2e/capture.test.ts', 'F3');
    expect(rules).toHaveLength(1);
    expect(rules[0].cases.map((c) => c.text)).toEqual(['the only case here']);
  });

  it('still counts the case modifiers that are real written cases', () => {
    const source = sourceOf(`
      test.describe('Capture', () => {
        test.describe('a rule', () => {
          test.skip('a skipped case', async () => {});
          test.fixme('a case parked as broken', async () => {});
          test.todo('a case not written yet');
        });
      });
    `);
    const { rules } = extractRules(source, 'tests/e2e/capture.test.ts', 'F3');
    expect(rules[0].cases.map((c) => c.text)).toEqual(['a skipped case', 'a case parked as broken']);
    expect(rules[0].todoCases.map((c) => c.text)).toEqual(['a case not written yet']);
  });
});

// `test.skip` is a case in one overload and a runtime modifier in another, so only the
// arguments can tell them apart. The conditional form is how Playwright's own docs — and
// playwright.config.ts's comment — say to write a device-specific test, so the first spec
// that follows that advice would otherwise have reported a phantom case named after its
// condition.
describe('extractRules, on conditional skips', () => {
  it('does not count a conditional skip inside a test body as a case', () => {
    const source = sourceOf(`
      test.describe('Triage', () => {
        test.describe('a rule', () => {
          test('swiping an item away removes it', async ({ isMobile }) => {
            test.skip(!isMobile, 'the swipe only exists on a phone');
            await doSomething();
          });
        });
      });
    `);
    const { rules } = extractRules(source, 'tests/e2e/triage.test.ts', 'F3');
    expect(rules[0].cases.map((c) => c.text)).toEqual(['swiping an item away removes it']);
  });

  it('still counts the declaration overload, which has a title and a body', () => {
    const source = sourceOf(`
      test.describe('Triage', () => {
        test.describe('a rule', () => {
          test.skip('a case skipped while it is being written', async () => {});
          test.fixme('a case parked as broken', async () => {});
        });
      });
    `);
    const { rules } = extractRules(source, 'tests/e2e/triage.test.ts', 'F3');
    expect(rules[0].cases.map((c) => c.text)).toEqual([
      'a case skipped while it is being written',
      'a case parked as broken',
    ]);
  });

  it.each([
    { situation: 'a condition and a reason', code: "test.fixme(isMobile, 'not on a phone');" },
    { situation: 'a callback condition', code: "test.skip(({ isMobile }) => isMobile, 'desktop only');" },
    { situation: 'no arguments at all', code: 'test.skip();' },
    { situation: 'an expected failure with no title', code: 'test.fail();' },
  ])('reads $situation as a modifier rather than a case', ({ code }) => {
    const source = sourceOf(`
      test.describe('Triage', () => {
        test.describe('a rule', () => {
          test('the only case here', async () => { ${code} });
        });
      });
    `);
    const { rules } = extractRules(source, 'tests/e2e/triage.test.ts', 'F3');
    expect(rules[0].cases.map((c) => c.text)).toEqual(['the only case here']);
  });
});
