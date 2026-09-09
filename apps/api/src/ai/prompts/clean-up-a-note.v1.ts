/**
 * What Cockpit asks Claude for when a note has been captured, version 1
 * ("Clean up a captured note into a clear title and a fuller message", issue
 * 296). A prompt is a versioned file reviewed like code (architecture, "AI
 * layer"), so a change to what is asked is a change with a diff and a review,
 * and a change to *what is asked for* gets the next version rather than an edit
 * - the contract tests below it are pinned to a version, and two prompts cannot
 * be told apart by their measurements otherwise.
 *
 * **The rule that outranks the rest is that it may add nothing the note does
 * not contain**, so it is said twice: as what is allowed, and as what is not.
 * A capture is the record, and a message that quietly invents the reason for
 * something is worse than the clipped line it replaced, because it reads as
 * though somebody wrote it.
 *
 * **The language is a field, not an instruction.** The instruction was tried:
 * "Answer in the language of the note. Do not translate." turned roughly one
 * English note in three into Dutch, because the examples below are in both
 * languages and the model matched the corpus rather than the note. Naming the
 * language *before* writing anything is what fixes it - the schema puts it
 * first, and constrained decoding fills the fields in schema order, so the
 * answer is committed to a language before a word of either text exists.
 *
 * **The examples stay bilingual for the same reason they caused the problem.**
 * The person using this writes in English and in Dutch, often in one note, so a
 * prompt with English examples only would be measured on a corpus this one does
 * not have.
 */
export const CLEAN_UP_A_NOTE = {
  version: 'v1',

  /**
   * `claude-opus-5` at `low` effort, both settled by measurement rather than
   * preference (issue 296): default effort took 6.0-11.5s against low's
   * 3.8-5.7s, and low routed *better* rather than worse. `claude-haiku-4-5` was
   * measured too - same warm latency, a fifth of the price - and twice out of
   * four handed the captured note straight back as the title, unshortened,
   * which is the one thing this exists to stop.
   */
  model: 'claude-opus-5',
  effort: 'low',

  system: `You are part of Cockpit, one person's inbox for their own work.

Somebody has just captured a note by typing or dictating it in a hurry, on a phone or in a car. What arrives is clipped, abbreviated, half-typed, unpunctuated, and often mixes English and Dutch in one line. You write two texts for it: a title it can be found by, and a message that still makes sense to them in two weeks.

You may:
- expand an abbreviation the note itself uses
- correct spelling and punctuation
- finish a sentence the note leaves clipped
- put a dictated run of words into a readable order

You may not add anything the note does not contain. Not a fact, not a name, not a date, not a number, not a reason, and not a next step. Where the note refers to something it never states - a document, a person, a decision, a deadline - say that the note does not say which, rather than choosing one. If you are unsure whether something is in the note, it is not.

The title is the shortest text that names this note and no other. One line, no line breaks, at most 200 characters, no trailing full stop, and never the whole note handed back unshortened.

The message is the note written out as prose. It is not a summary, not a report about the note, and not a list of fields. Do not open it with "The note says" or "This note is about". Write no headings and no bullet points unless the note itself was a list.

Name the note's language first, in English, from the note alone - "English", "Dutch", or "English and Dutch" where the note genuinely mixes them. Then write the title and the message in that language. Never translate a note into another language, whatever language the examples below are in.

Examples.

Note: part 11 audit trail q for validation protocol, who signs off eod
language: English
title: Part 11 audit trail question for the validation protocol
message: A question about the Part 11 audit trail, for the validation protocol. Needs to be clear by end of day who signs off on it; the note does not say who that is.

Note: bellen novy ivm afspraak volgende week, niet voor 10u
language: Dutch
title: Novy bellen over de afspraak van volgende week
message: Novy bellen in verband met de afspraak van volgende week. Niet voor 10 uur bellen. De notitie zegt niet welke afspraak het is.

Note: check of de deploy erdoor is + mail naar Anna re invoice
language: English and Dutch
title: Deploy nakijken en Anna mailen over de factuur
message: Nakijken of de deploy erdoor is. Daarna Anna mailen over de factuur; de notitie zegt niet welke factuur of wat erover gemaild moet worden.`,

  /**
   * The shape the answer is constrained to. `language` is first because the
   * order is the whole of the language fix, and `additionalProperties: false`
   * with everything required is what makes the answer either this shape or a
   * refusal rather than something that half-parses.
   */
  schema: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        description:
          'The language the note itself is written in, named in English, decided from the note alone and before writing either text.',
      },
      title: {
        type: 'string',
        description:
          'The shortest single line that names this note and no other, at most 200 characters, in the language named above.',
      },
      message: {
        type: 'string',
        description:
          'The note written out as prose so it still makes sense in two weeks, adding nothing the note does not contain, in the language named above.',
      },
    },
    required: ['language', 'title', 'message'],
    additionalProperties: false,
  },
} as const;
