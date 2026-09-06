//
// What `pnpm backup:export` and `pnpm backup:restore` both need: reading the
// flags they were given, and turning an answer that is not a 200 into a
// sentence somebody can act on.
//
// Written once because the two commands are one pair. The refusals are
// identical - an unknown flag, a flag with nothing after it, a flag given twice
// - and so is the long 401, which names where the secret is set and what the
// command reads it from; two copies of that is two places to find the day it
// changes.
//

/**
 * The flags a command was given.
 *
 * `takes` names the flags that carry a value, `switches` the ones that are only
 * themselves. Both are given as flag-to-field so a command's own vocabulary
 * stays in the command.
 */
export function readFlags(argv, { takes, switches = {} }) {
  const args = {};
  for (const field of Object.values(takes)) args[field] = undefined;
  for (const field of Object.values(switches)) args[field] = false;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (switches[flag]) {
      args[switches[flag]] = true;
      continue;
    }
    const field = takes[flag];
    if (!field) {
      throw new Error(`there is no ${flag} - the flags are ${named(takes, switches)}`);
    }
    const value = argv[i + 1];
    // A flag with nothing after it, rather than one silently taking the next
    // flag as its value - which is how `--user --out x` would quietly act on an
    // account called `--out`.
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} was given nothing to go with it`);
    }
    // Said rather than taking the last quietly: the environments differ in
    // exactly the way that makes being surprised by which one was used
    // expensive.
    if (args[field] !== undefined) {
      throw new Error(`${flag} was given twice - it takes one value`);
    }
    args[field] = value;
    i += 1;
  }
  return args;
}

function named(takes, switches) {
  return [...Object.keys(takes), ...Object.keys(switches)].join(', ');
}

/**
 * What an answer that is not a 200 means.
 *
 * `extra` lets a command add the statuses only it can meet, and say what to do
 * about them - a restore's 409 carries the way forward, an export's has no
 * equivalent.
 */
export function readAnswer({ status, body }, extra = {}) {
  if (extra[status]) return extra[status](message(body));
  if (status === 401) {
    return (
      'refused: the operator secret was not accepted. It is BACKUP_TOKEN, set per ' +
      'environment with `wrangler secret put BACKUP_TOKEN`, and given to this command ' +
      'as COCKPIT_BACKUP_TOKEN.'
    );
  }
  if (status === 404 || status === 400 || status === 409) return `refused: ${message(body)}`;
  if (status === 0) return 'nothing answered - is the environment up, and the address right?';
  return `answered ${status}: ${message(body)}`;
}

function message(body) {
  try {
    return JSON.parse(body).error ?? body;
  } catch {
    return body;
  }
}
