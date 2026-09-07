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
  name: z.string().min(1).max(120),
  email: z.string().min(1).max(254),
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
