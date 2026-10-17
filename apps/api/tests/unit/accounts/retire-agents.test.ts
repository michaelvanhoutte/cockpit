import { describe, expect, it } from 'vitest';
import { whyItFailed } from '../../../src/accounts/retire-agents.js';

/**
 * L1: what the retirement logs when a step fails ("Retire the agents' dock and
 * routines, keeping what each agent knew", issue 1165). A failed query's
 * message carries its parameters - the sentence and the Agent's template -
 * which are the person's words and stay out of the logs.
 */
describe('Agents', () => {
  describe('a failed retirement step is logged without the person’s words', () => {
    it('keeps the database’s reason and drops the query and its parameters', () => {
      // Shaped as drizzle's `DrizzleQueryError` is: the query and its
      // parameters in the message, the database's own error as the cause.
      const failed = new Error(
        'Failed query: insert into "remembered_sentences" ("sentence") values (?)\nparams: Scope in Cockpit: Claude Code, start with /scoping',
        { cause: new Error('UNIQUE constraint failed: remembered_sentences.agent_id') },
      );

      const said = whyItFailed(failed);

      expect(said).toContain('UNIQUE constraint failed: remembered_sentences.agent_id');
      expect(said).not.toContain('Scope in Cockpit');
      expect(said).not.toContain('insert into');
    });

    it('drops the parameters from a query error that carries no cause', () => {
      const said = whyItFailed(new Error('Failed query: insert into "agents" values (?)\nparams: my private template'));

      expect(said).not.toContain('my private template');
      expect(said).not.toContain('insert into');
    });
  });
});
