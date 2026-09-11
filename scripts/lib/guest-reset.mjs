//
// Everything `pnpm guest:reset` decides, which is only what it was asked - the
// asking is the whole of the rest (scripts/guest-reset.mjs).
//
// It puts the shared guest account back to its demonstration ("Reset the guest
// account to its seeded state", issue 356): the reset the nightly run does, for
// a demo due before 03:00 UTC comes round.
//
// **Nothing is confirmed by typing a name**, unlike `pnpm backup:restore`. That
// prompt guards data nobody can put back; this reaches only the guest account,
// whose contents are promised to nobody and wiped every night regardless, so
// the prompt would cost every demo a step and guard nothing.
//

import { readEnvironment, readFlags } from './operator.mjs';

/** Where the reset is asked for, on whichever environment `--env` names. */
export const RESET_PATH = '/v1/operator/guest/reset';

/** What the command was asked to do. */
export function readArguments(argv) {
  const args = readFlags(argv, { takes: { '--env': 'environment' } });
  // Required rather than defaulting to local, as the backup commands do: a
  // guessed environment is found out about in the wrong one.
  if (!args.environment) throw new Error("--env says which environment's guest account to reset");
  readEnvironment(args.environment);
  return args;
}
