import { z } from 'zod';

/**
 * Who a user is, as far as anything outside the register is concerned: an id, a
 * name to show, and the role that decides what the app offers them.
 *
 * **Role crosses this boundary and the rest still does not.** It has to: the
 * app cannot decide whether to offer the way into the admin pages without
 * knowing, and a role read from the register on every request is the same
 * answer the gate uses ("See who can sign in, on a page only an admin can
 * open", issue 230). Which account somebody owns and the Google account they
 * sign in with stay behind - only the gate reads those. **It is not what
 * enforces anything**: the server refuses an admin address on its own reading
 * of the register, so a client that lies about this changes what it draws and
 * nothing else.
 *
 * **It answers one question now, not two.** There was a second: the list of
 * everybody, which the logon page showed you to pick a name from. Signing in is
 * Google's answer since "Sign in with Google, and retire the list of names"
 * (issue 196), so the only thing anyone is told about a user is who they
 * themselves are signed in as - until they are an admin, below.
 */
/**
 * The two roles there are, written once so both sides compare against the same
 * word. The database holds the same pair in a CHECK (`users_role_is_known`),
 * which is what actually enforces it; this is what stops `'Admin'` or
 * `'adminstrator'` type-checking on the way to a comparison that would then
 * quietly never match.
 */
export const ROLES = ['user', 'admin'] as const;
export const ADMIN: Role = 'admin';
export type Role = (typeof ROLES)[number];

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
});
export type User = z.infer<typeof userSchema>;

/** Who Cockpit currently believes you are. */
export const signedInSchema = z.object({ user: userSchema });
export type SignedIn = z.infer<typeof signedInSchema>;

/**
 * A person as the admin pages see them: everything the register holds about
 * somebody, which is deliberately more than `userSchema` tells anyone about
 * anyone else.
 *
 * **`hasSignedIn` rather than the Google identity itself.** What an admin needs
 * to know is whether a person has ever got in - a row nobody has signed in as
 * is a person who cannot, or has not tried - and the identity Google keys them
 * by answers that without being a thing to publish.
 *
 * `email` is nullable because the register's is: the column arrived after the
 * rows did ("Record the Google account each user signs in with", issue 195),
 * and a row without one is a person nobody can sign in as, which is worth
 * showing rather than hiding.
 */
export const registeredUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  role: z.enum(ROLES),
  /** The account this person owns, which is theirs alone. */
  accountName: z.string(),
  hasSignedIn: z.boolean(),
});
export type RegisteredUser = z.infer<typeof registeredUserSchema>;

/** Everyone this Cockpit knows, for the admin pages. */
export const registeredUserListSchema = z.object({ users: z.array(registeredUserSchema) });
export type RegisteredUserList = z.infer<typeof registeredUserListSchema>;

/**
 * How much a box may hold, so the boxes and the schemas below cannot drift: a
 * form that let somebody type past these would reach the one refusal the server
 * cannot put in its own words. 254 is the longest address an SMTP envelope
 * carries.
 */
export const NAME_LIMIT = 120;
export const ADDRESS_LIMIT = 254;

/**
 * Adding somebody: their name, and the Google address they will sign in with
 * ("Add a user on the admin page, so a second person no longer needs SQL",
 * issue 231).
 *
 * **No role.** Everyone arrives ordinary; making somebody an admin is its own
 * page and its own issue. **No account either** - a person owns one account and
 * it is made with them, so naming it would be asking for something the product
 * does not let you choose.
 *
 * **The bounds only refuse what is not a request at all.** Anything shaped like
 * one is answered by the server's own rules, which say *what* is wrong - which
 * address is already somebody's, what a name leaves nothing of - where this
 * would only say "validation failed". So `min(1)` rather than a length that
 * looks like a real address: `ab` is a request, and being told it is not an
 * address is more use than being told the request was invalid.
 */
export const addUserSchema = z.object({
  name: z.string().min(1).max(NAME_LIMIT),
  email: z.string().min(1).max(ADDRESS_LIMIT),
});
export type AddUser = z.infer<typeof addUserSchema>;

/**
 * What adding somebody answered: the person, and whether their account was
 * ready when they were added.
 *
 * **`accountReady` is false rather than an error**, because the person is added
 * either way: the account is opened as they are added so that a change which
 * will not apply lands on the admin who added them rather than on their first
 * sign-in, and if it does not, their first sign-in tries again. What the admin
 * needs is to be told, not to be left thinking nothing happened.
 */
export const userAddedSchema = z.object({
  user: registeredUserSchema,
  accountReady: z.boolean(),
});
export type UserAdded = z.infer<typeof userAddedSchema>;

/**
 * Changing somebody: the name they are shown by and the role that decides what
 * they may reach ("Rename a user, and make somebody an admin", issue 232).
 *
 * **Both together, because they are one form.** A form that sends only what was
 * touched has to decide what "touched" means, and a role left out is
 * indistinguishable from a role set back to what it already was.
 *
 * **The address is not here.** It is what somebody signs in by and what Google
 * keys them to, so changing it is a different question with failure modes of
 * its own - a changed address must not become a way into the previous holder's
 * account - and it is not asked yet.
 *
 * The bounds refuse only what is not a request at all, for the reason
 * `addUserSchema` gives: a name of spaces is shaped like a request and is
 * answered by the server's own words rather than by "validation failed".
 */
export const changeUserSchema = z.object({
  name: z.string().min(1).max(NAME_LIMIT),
  role: z.enum(ROLES),
});
export type ChangeUser = z.infer<typeof changeUserSchema>;

/** Somebody as they stand after being changed. */
export const userChangedSchema = z.object({ user: registeredUserSchema });
export type UserChanged = z.infer<typeof userChangedSchema>;

/**
 * Why taking somebody's admin away is refused, or `null` when it is not - the
 * one rule both sides of the change have to agree on.
 *
 * **Here rather than once on each side**, for the reason `ROLES` is: the form
 * draws the choice as unavailable before anybody presses Save and the server
 * refuses it afterwards, so two copies of this would be a choice offered and
 * then refused, or greyed out for a reason that no longer holds. What each side
 * *says* stays its own - a label inside a choice is not a sentence under a form -
 * and only the rule is shared.
 *
 * **Both reasons exist because the alternative is an admin page nobody can
 * open**, with no way back but the SQL the environment was bootstrapped with.
 * They are two because "another admin can do it for you" is false when there is
 * no other admin. Gaining the role is never refused: only losing it can lock
 * anybody out.
 */
export function losingAdminIsRefused({
  who,
  role,
  askedBy,
  admins,
}: {
  /** The person being changed, as the register holds them today. */
  who: { id: string; role: string };
  /** The role they are being given. */
  role: Role;
  /** Who is asking, which one of the two reasons is about. */
  askedBy: string | undefined;
  /** How many admins the register holds, this person included. */
  admins: number;
}): 'the last admin' | 'your own' | null {
  if (who.role !== ADMIN || role === ADMIN) return null;
  if (admins <= 1) return 'the last admin';
  return who.id === askedBy ? 'your own' : null;
}
