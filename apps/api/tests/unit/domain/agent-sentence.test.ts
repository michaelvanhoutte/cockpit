import { describe, expect, it } from 'vitest';
import { sentenceForAgent } from '../../../src/domain/agent-sentence.js';

/**
 * L1: what an Agent's name and template become when Agents are retired ("Retire
 * the agents' dock and routines, keeping what each agent knew", issue 1165).
 * That the store writes it once per Agent, and disconnects the routine after,
 * is tests/integration/accounts/aged-store.test.ts's.
 */

describe('Agents', () => {
  describe('an Agent becomes one sentence saying what it was for and how Claude was told to do it', () => {
    it.each([
      {
        situation: 'a template that is a Claude Code command and the Item’s words',
        name: 'Scope in Cockpit',
        message: '/scoping {title}: {description}',
        sentence: 'Scope in Cockpit: Claude Code, start with /scoping',
      },
      {
        situation: 'a command with words of its own after it',
        name: 'Build it',
        message: '/build the feature {title} — {link}',
        sentence: 'Build it: Claude Code, start with /build the feature',
      },
      {
        situation: 'an instruction in words, the Item’s on lines of their own',
        name: 'Research',
        message: 'Research this and come back with what you found.\n\n{title}\n\n{description}\n\n{link}',
        sentence: 'Research: Claude Code. Research this and come back with what you found.',
      },
      {
        situation: 'an instruction that asked for a prompt',
        name: 'Ask Claude',
        message: 'Answer this: {prompt}\n\n{title}',
        sentence: 'Ask Claude: Claude Code. Answer this:',
      },
      {
        situation: 'punctuation of the person’s own between their words, kept where no placeholder touches it',
        name: 'Research',
        message: 'Research & summarise - then tell me “{title}”',
        sentence: 'Research: Claude Code. Research & summarise - then tell me',
      },
    ])('$situation', ({ name, message, sentence }) => {
      expect(sentenceForAgent({ name, message, deleted: false })).toEqual({ sentence, action: name });
    });
  });

  describe('an Agent that cannot become a sentence becomes none, saying why', () => {
    it.each([
      { situation: 'a deleted Agent', name: 'Fix it', message: 'Fix this.', deleted: true, because: 'deleted' },
      { situation: 'a template of the Item’s words alone', name: 'Echo', message: '{title}\n\n{description}', deleted: false, because: 'empty' },
      { situation: 'a blank template', name: 'Blank', message: '   ', deleted: false, because: 'empty' },
      { situation: 'a template of punctuation alone', name: 'Dashes', message: '- -- !', deleted: false, because: 'empty' },
      { situation: 'a placeholder no Agent ever filled', name: 'Odd', message: 'Reply to {sender} about {title}', deleted: false, because: 'unknown-placeholder' },
      { situation: 'one too long to read at a glance', name: 'Long', message: 'word '.repeat(60), deleted: false, because: 'too-long' },
      { situation: 'one naming an address', name: 'Mail it', message: 'Send it to someone@example.com', deleted: false, because: 'points-somewhere' },
      { situation: 'one naming a command to install something', name: 'Set up', message: 'Run npx create-thing first, then {title}', deleted: false, because: 'points-somewhere' },
    ])('$situation', ({ name, message, deleted, because }) => {
      expect(sentenceForAgent({ name, message, deleted })).toEqual({ notRemembered: because });
    });
  });
});
