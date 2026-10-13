import { z } from 'zod';

/**
 * Speaking a note into Cockpit and having it transcribed ("Dictate in Capture
 * with Whisper instead of the browser's speech engine", issue 1037). What the
 * phone and the Worker both have to agree on lives here: how long a recording
 * may be, how many bytes that allows, and what the Worker answers with.
 */

/** A recording stops itself here, and the Worker refuses one that is longer. */
export const MAX_RECORDING_SECONDS = 5 * 60;

/**
 * What a second of recording may weigh on the wire, with room to spare.
 *
 * A phone's recorder writes Opus or AAC at about 64 to 128 kbit/s, which is 8 to
 * 16 kB a second; this is half as much again as the larger of the two, so a
 * recording that stopped at the limit always fits and one that did not is
 * refused by size alone, before the model is called.
 */
export const RECORDING_BYTES_PER_SECOND = 24_000;

/** The most bytes a transcription request may carry: five minutes' worth. */
export const MAX_RECORDING_BYTES = MAX_RECORDING_SECONDS * RECORDING_BYTES_PER_SECOND;

/** Where a recording is sent to be transcribed. */
export const TRANSCRIPTION_PATH = '/v1/transcriptions';

/** What the Worker answers a recording with: the words said in it. */
export const transcriptionSchema = z.object({ text: z.string() });
export type Transcription = z.infer<typeof transcriptionSchema>;
