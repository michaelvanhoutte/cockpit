import { REMEMBERED_ACTION_LIMIT, REMEMBERED_SENTENCE_LIMIT } from '@cockpit/shared';
import { onOneLine, sentenceMayBeKept } from './remembered-sentences.js';

/**
 * What an Agent becomes when Agents are retired ("Retire the agents' dock and
 * routines, keeping what each agent knew", issue 1165): one remembered
 * sentence saying what kind of action it was for and how Claude was told to do
 * it - "Scope in Cockpit: Claude Code, start with /scoping" - which the person
 * can reword in *What Cockpit remembers*. Pure, and here rather than in the
 * store, for the reason every rule in `domain/` is.
 *
 * **Only what the Agent holds.** Its name is the kind of action and its
 * template the instruction, with the Item's own words (`{title}`,
 * `{description}`, `{link}`, `{prompt}`) taken out, since a sentence is about
 * every Item of that kind rather than one. A folder it never stored is not
 * guessed: the routine it fired ran wherever Claude had it set up.
 *
 * **Held to exactly what Remember is held to** (`sentenceMayBeKept`), so a
 * template naming an address or a command becomes no sentence, as a pasted
 * one would; and to the same lengths.
 */

/** Why an Agent became no sentence, which the retirement logs and keeps on the row. */
export type AgentNotRemembered =
  | 'deleted'
  | 'empty'
  | 'unknown-placeholder'
  | 'too-long'
  | 'points-somewhere';

export type AgentSentence =
  | { sentence: string; action: string }
  | { notRemembered: AgentNotRemembered };

/** The placeholders an Agent's template could hold, each filled with the Item's own words. */
const PLACEHOLDER = /\{title\}|\{description\}|\{link\}|\{prompt\}/g;

/** Anything else in braces: a placeholder no Agent ever filled, so what the template meant there is unknown. */
const UNKNOWN_PLACEHOLDER = /\{[^{}\s]*\}/;

/**
 * A word that is nothing but punctuation, dropped only where it touches a
 * placeholder - the `:` of `{title}: {description}` - so a `&` or `-` the
 * person wrote between their own words stays.
 */
const ONLY_PUNCTUATION = /^[\p{P}\p{S}]+$/u;

/** A Claude Code command the template starts with, such as `/scoping`. */
const SLASH_COMMAND = /^\/[\w:-]+$/;

const isSeparator = (word: string) => ONLY_PUNCTUATION.test(word) && !SLASH_COMMAND.test(word);

/** The template's own words, the placeholders taken out with the punctuation either side of each. */
function instructionOf(message: string): string {
  const pieces = message.split(PLACEHOLDER);
  return pieces
    .flatMap((piece, at) => {
      const words = onOneLine(piece).split(' ').filter((word) => word !== '');
      if (at > 0) while (words.length > 0 && isSeparator(words[0]!)) words.shift();
      if (at < pieces.length - 1) while (words.length > 0 && isSeparator(words.at(-1)!)) words.pop();
      return words;
    })
    .join(' ');
}

export function sentenceForAgent(agent: { name: string; message: string; deleted: boolean }): AgentSentence {
  if (agent.deleted) return { notRemembered: 'deleted' };
  const action = onOneLine(agent.name);
  if (UNKNOWN_PLACEHOLDER.test(agent.message.replace(PLACEHOLDER, ' '))) return { notRemembered: 'unknown-placeholder' };
  const instruction = instructionOf(agent.message);
  // No letter or digit left: punctuation alone says nothing to Claude.
  if (!/[\p{L}\p{N}]/u.test(instruction) || action === '') return { notRemembered: 'empty' };
  const sentence = SLASH_COMMAND.test(instruction.split(' ')[0]!)
    ? `${action}: Claude Code, start with ${instruction}`
    : `${action}: Claude Code. ${instruction}`;
  if (sentence.length > REMEMBERED_SENTENCE_LIMIT || action.length > REMEMBERED_ACTION_LIMIT) {
    return { notRemembered: 'too-long' };
  }
  if (!sentenceMayBeKept(sentence, action)) return { notRemembered: 'points-somewhere' };
  return { sentence, action };
}
