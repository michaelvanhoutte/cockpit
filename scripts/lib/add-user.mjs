//
// Everything `pnpm user:add` decides, with the reading and the writing
// injected - the same shape as backup.mjs and restore.mjs beside it, and for
// the same reason: a decision that nothing can run is a decision nothing
// checks.
//
// **It writes through the operator routes that already exist**, rather than a
// route of its own. `/v1/admin/restore/register` is the register's only writer:
// it creates the rows that are missing, leaves the ones that are there, and
// refuses every collision the register enforces - an account's id, a user's id,
// the address, and the Google identity. A second insert route would be a second
// copy of those four rules, which `apps/api/src/accounts/register.ts` records as
// having been got wrong twice already.
//
// **Failure modes**, since this writes to a register nobody can un-write:
//
//   - *Stopping halfway.* There is one write, and the route puts whatever it
//     decided to create in a single `DB.batch`, so an interruption leaves the
//     register untouched. Nothing else here changes anything. **This is not the
//     same as the operation being all-or-nothing** - what that batch holds is
//     decided first, which is the third bullet.
//   - *Running it twice.* Refused, naming what is already there. The second run
//     writes nothing rather than adding a second Anna or moving the first.
//   - *Between the read and the write.* The refusals below are decided against
//     the register as it was read, so somebody else adding the same person in
//     that window would get past them - which is why the answer's counts are
//     checked as well. The route recomputes its plan against the register it
//     finds, so a row that arrived meanwhile is left alone and reported as
//     nothing added, and the address is refused outright by the route's own
//     collision check.
//
// Nothing here deletes, renames or disables anybody; adding is the operation
// that blocks having more than two people ("Add a user from the command line",
// issue 87), and the rest belongs with the admin section.
//

import { readAnswer, readFlags } from './operator.mjs';

/**
 * The role a user added here gets.
 *
 * Ordinary, and not a flag. `role` is carried and enforced by nothing today
 * (`apps/api/src/db/schema.ts`), so choosing one at creation would be a
 * question with no consequence - it waits for a role that does something.
 */
const ORDINARY = 'user';

/**
 * How much of a name an id is derived from.
 *
 * Long enough that no name anybody has is shortened, and short enough that
 * `<out>/accounts/tenant-<id>.json` stays well inside the 260 characters
 * Windows gives a path by default - which is the limit that decides whether an
 * account can be backed up at all.
 */
const LONGEST_ID = 48;

/**
 * What the command was asked to do.
 *
 * `--env` defaults to `local`, which is the only environment this can be
 * pointed at by accident and the one it is pointed at all day. Backing up and
 * restoring require it because their other flags are paths, so a missing `--env`
 * there is ambiguous about the direction; here there is nothing to confuse it
 * with.
 *
 * **Everything about what was typed is settled here**, which is why the two
 * derivations below are called for their refusals and their results dropped.
 * The runner prints the usage line for what this throws and nothing else
 * (`scripts/add-user.mjs`), so a name or an address left out anywhere else is a
 * mistyped command answered without the line saying how to type it - which is
 * where `backup:export` and `backup:restore` put the same decision.
 */
export function readArguments(argv) {
  const args = readFlags(argv, {
    takes: { '--name': 'name', '--email': 'email', '--env': 'environment' },
  });
  nameForTheRegister(args.name);
  readAddress(args.email);
  return { ...args, environment: args.environment ?? 'local' };
}

/**
 * The register ids for somebody called this, or the reason there are none.
 *
 * **`tenant-<name>` and `user-<name>`**, which is what the register already
 * holds (`apps/api/seed.sql`) and what every row of that account's store will
 * carry. The account is the person's, so both are derived from the one name
 * rather than asked for separately - two flags naming the same person is two
 * flags that can disagree.
 *
 * **The case is folded upper-then-lower before anything else**, not
 * `toLowerCase()` alone, for the reason `foldName` in
 * `apps/api/src/domain/names.ts` records: lowercasing is not case folding, so
 * `Straße` would keep its `ß` and lose it to the strip below, while uppercasing
 * expands it to `SS` first. That module is TypeScript inside the Worker and
 * cannot be reached from here; this is a different operation in any case -
 * deriving an id, not deciding whether two names are one name.
 *
 * **Normalised rather than refused, and refused only when nothing survives.**
 * An account name has to be letters, digits, dots, dashes and underscores -
 * `accountNameSchema` in `apps/api/src/http/app.ts` and `nameAsAFile` in
 * `backup.mjs` say so independently, the second because the name becomes a file
 * name in a backup. Refusing `Anna Müller` outright would make the command
 * useless for most of the names people have; refusing what leaves nothing at
 * all is the only alternative to inventing an id the name has no connection to.
 */
export function nameForTheRegister(name) {
  const given = (name ?? '').trim();
  if (!given) {
    throw new Error('--name says who to add, and is what their account is named after');
  }
  const derived = given
    .toUpperCase()
    .toLowerCase()
    // The accents NFKD splits off its letters, so `Müller` derives `muller`
    // rather than losing the whole letter.
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    // Cut before the ends are trimmed, so a name cut mid-separator does not
    // leave one hanging. **Bounded because a backup writes an account's name as
    // a file name** (`nameAsAFile` in backup.mjs): an id derived from a very
    // long name makes a path Windows refuses at 260 characters, so that account
    // could never be backed up. This is the only place that can stop it, the
    // rows having been written by hand until now.
    .slice(0, LONGEST_ID)
    .replace(/^-+|-+$/g, '');
  if (!derived) {
    throw new Error(
      `${JSON.stringify(given)} leaves nothing an account can be named after - a name has to ` +
        'carry at least one letter or digit that survives being written as an id',
    );
  }
  // `given` travels with the ids because it is what the rows are *named*, as
  // against what they are addressed by: the register holds `Anna Müller` and
  // addresses her account `tenant-anna-muller`, so trimming it in one place and
  // deriving from it in another is one trim two callers can disagree about.
  return { account: `tenant-${derived}`, user: `user-${derived}`, derived, given };
}

/**
 * The address, in the one spelling the register will hold it in.
 *
 * **Settled here rather than left as typed**, because the unique index that
 * stops two people sharing an address compares it exactly as written
 * (`apps/api/src/db/schema.ts`): two rows differing only in case would both be
 * allowed in and only one of them would ever be found. Signing in folds the
 * same way (`normaliseAddress` in `apps/api/src/auth/oidc.ts`), so a person
 * added here is found by the address Google hands back.
 *
 * **The shape is checked and the account behind it is not.** Nothing here can
 * tell whether a real Google account holds this address - that is discovered at
 * the first attempt to sign in - so refusing plausible-looking addresses would
 * be theatre. What is worth catching is the thing that is not an address at
 * all, which is how `--email` ends up holding a name when two flags are typed
 * in the wrong order.
 */
export function readAddress(email) {
  const given = (email ?? '').trim();
  if (!given) {
    throw new Error(
      '--email says which Google address signs in as them. The register is the allowlist, so a ' +
        'user without one is a row nobody can sign in as.',
    );
  }
  const address = given.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error(`${JSON.stringify(given)} is not an address - it is what somebody signs in with`);
  }
  return address;
}

/**
 * Adds the user: reads the register, refuses what it already knows, and writes
 * the two rows.
 *
 * **The refusals are named against what is there rather than left to the
 * route**, because the route is a restore and answers a duplicate id by leaving
 * the row exactly as it is - which is right for putting a backup back and would
 * read here as a success that added nobody. The address is the one it does
 * refuse, and it is left to do so: it is the collision that can arrive between
 * this read and this write.
 *
 * Nothing creates the account's store, and nothing needs to. A store is made by
 * the first request that opens it and starts with the workspaces every account
 * starts with (`apps/api/src/accounts/changes.ts`), which is why the account is
 * empty rather than absent when they first sign in.
 */
export async function addUser({ read, write, name, email, now = () => new Date() }) {
  // Before the register is read, so a name or an address nobody could use costs
  // no request and reads as the caller's to fix.
  const ids = nameForTheRegister(name);
  const address = readAddress(email);

  const register = await read('/v1/admin/backup/register');
  readRegister(register);

  const takenAccount = register.tenants.find((row) => row.id === ids.account);
  if (takenAccount) {
    throw new Error(
      `${ids.account} is already in the register, as ${JSON.stringify(takenAccount.name ?? ids.account)} - ` +
        'two people cannot share an account, so this one needs a name of its own',
    );
  }
  const takenUser = register.users.find((row) => row.id === ids.user);
  if (takenUser) {
    throw new Error(
      `${ids.user} is already in the register - this name is taken, so pick one that derives a different id`,
    );
  }
  const takenAddress = register.users.find(
    (row) => row.email != null && String(row.email).trim().toLowerCase() === address,
  );
  if (takenAddress) {
    throw new Error(
      `${address} is already in the register, as ${takenAddress.id} - an address is what somebody ` +
        'is allowed in by, so it cannot be given to a second person',
    );
  }

  const createdAt = now().toISOString();
  const written = await write('/v1/admin/restore/register', {
    tenants: [{ id: ids.account, name: ids.given, created_at: createdAt }],
    users: [
      {
        id: ids.user,
        name: ids.given,
        account_id: ids.account,
        role: ORDINARY,
        email: address,
        created_at: createdAt,
      },
    ],
  });

  // The same guard the read carries, on the answer that decides what is
  // reported below: a proxy answering 200 with JSON of its own would otherwise
  // be read as a register that refused, and send somebody to look at the wrong
  // thing.
  if (typeof written?.usersCreated !== 'number' || typeof written?.accountsCreated !== 'number') {
    throw new Error(
      'writing the register got an answer that is not one - is something in front of this environment?',
    );
  }

  // **The counts, not the 200, and each of the three outcomes said separately.**
  // A row that arrived between the read above and this write is left exactly as
  // it is by the route - right for putting a backup back, and here it means the
  // write can half-happen: the account already existing while the person did
  // not writes the person *into somebody else's account*. Reporting that as
  // "nothing was added" would be the worst answer this command can give, since
  // what it leaves behind is a person who can sign in to an account that is not
  // theirs.
  if (written.usersCreated !== 1 || written.accountsCreated !== 1) {
    throw new Error(whatHappenedInstead(written, ids));
  }

  return { account: ids.account, user: ids.user, name: ids.given, address, createdAt };
}

/**
 * What a write that created something other than both rows actually did.
 *
 * Three outcomes, because the register can be raced in three ways and they need
 * three different things done about them. Only the first is harmless.
 */
function whatHappenedInstead({ accountsCreated, usersCreated }, ids) {
  if (usersCreated === 0 && accountsCreated === 0) {
    return (
      `nothing was added: the register already held ${ids.user} and ${ids.account} by the time this ` +
      'wrote. Somebody else added them - look at who is there before trying again.'
    );
  }
  if (usersCreated === 1) {
    // The row is committed and cannot be taken back from here, so this says
    // what is true rather than what was wanted. Settling it is a person's
    // decision about who owns what, which is why there is nothing to re-run.
    return (
      `${ids.user} was written, but ${ids.account} was already in the register - so they now own an ` +
      'account somebody else made, and can sign in to it. Nothing here can put that back: look at ' +
      'the register and settle who owns what before they sign in.'
    );
  }
  return (
    `${ids.account} was written and ${ids.user} was not, so the register holds an account nobody ` +
    'owns. Nobody can sign in to it, and it is safe to leave; add them again under a name that is free.'
  );
}

/**
 * That an answer is actually the register.
 *
 * The same guard `backup.mjs` puts on the same request, and for the same
 * reason: an edge or a proxy can answer 200 with JSON of its own, and without
 * it the first thing to notice is `.find` throwing on `undefined` - which reads
 * as a bug in this command rather than as something standing in front of the
 * environment.
 */
function readRegister(register) {
  if (
    !register ||
    typeof register !== 'object' ||
    !Array.isArray(register.tenants) ||
    !Array.isArray(register.users)
  ) {
    throw new Error(
      'reading the register got an answer that is not one - is something in front of this environment?',
    );
  }
}

/**
 * What one refusal from the routes this uses means.
 *
 * The register's 409 is the only status worth saying more about than the pair
 * of backup commands do: it means this environment already knows the address or
 * the person under a different row, which is a question about who somebody is
 * and not something to re-run at.
 */
export function readRefusal(answer) {
  return readAnswer(answer, {
    409: (why) =>
      `refused: ${why}\n\nNobody was added. Look at who is in the register before trying again.`,
  });
}
