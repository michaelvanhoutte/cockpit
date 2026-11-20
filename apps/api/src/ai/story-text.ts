import { z } from 'zod';
import { STORY_LENGTH_LIMIT } from './prompts/write-a-story.v1.js';

/**
 * Reading what the model wrote as a parent's story ("Keep its story up to
 * date", issue 1827). Pure and apart from the call, as `reply-body.ts` is:
 * every way an answer can be unusable ends in no change at all, never in a
 * description of something else.
 */

/** The story as the description will hold it, or why Claude wrote none - which changes nothing. */
export type StoryWritten = { story: string } | { discarded: string };

const answerShape = z.object({ language: z.string(), story: z.string() });

export function readStory(raw: unknown): StoryWritten {
  if (typeof raw !== 'string') return { discarded: 'the answer carried no text' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { discarded: 'the answer was not JSON' };
  }
  const answer = answerShape.safeParse(parsed);
  if (!answer.success) return { discarded: 'the answer was not a language and a story' };
  const story = answer.data.story.replace(/\r\n?/g, '\n').trim();
  if (story === '') return { discarded: 'the story was empty' };
  if (story.length > STORY_LENGTH_LIMIT) return { discarded: 'the story was too long' };
  return { story };
}
