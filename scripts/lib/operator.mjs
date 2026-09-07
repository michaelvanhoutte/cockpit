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
 * The environments either command can be pointed at.
 *
 * **Checked while the arguments are read, before anything looks a token or an
 * address up.** Both of those are keyed by this name, so a typo reaching them
 * is answered in terms of what they wanted rather than what is wrong: asking
 * for a token first turns `--env prod` into "no token for prod", which sends
 * somebody to add one for an environment that does not exist.
 */
export const ENVIRONMENTS = Object.freeze(['local', 'staging', 'production']);

/** Refuses a name that is not one of them, in the words of the thing they typed. */
export function readEnvironment(name) {
  if (!ENVIRONMENTS.includes(name)) {
    throw new Error(`no environment ${name} - it is one of ${ENVIRONMENTS.join(', ')}`);
  }
  return name;
}

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
  // **Two different 401s, and telling them apart is the whole point.** The
  // operator's gate answers `not allowed`; the *sign-in* gate answers `sign in
  // to continue`, and this command meets that one when it asks at
  // `/v1/operator/` of a deployment that predates the address ("Give the
  // operator's routes the operator's name, and free /v1/admin/ for the admin
  // section", issue 229). Production lags `main` by design - it is promoted by
  // hand - so that window is ordinary rather than exotic, and reporting it as a
  // rejected secret sends an operator to rotate BACKUP_TOKEN when the fix is to
  // promote.
  if (status === 401) {
    if (message(body) === 'sign in to continue') {
      return (
        'refused: that environment is older than this checkout and has not got the ' +
        'operator routes at /v1/operator/ yet. Promote it, or run this from a ' +
        'checkout as old as it is. The secret was never asked for.'
      );
    }
    return (
      'refused: the operator secret was not accepted. It is that environment\'s own ' +
      'BACKUP_TOKEN, set with `wrangler secret put BACKUP_TOKEN`, and this command reads ' +
      'the value it sends from backup-tokens.json - so the two have to match.'
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
