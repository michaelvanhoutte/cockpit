import { z } from 'zod';

/**
 * Who a user is, as far as anything outside the register is concerned
 * (architecture.md §4.4 for why `role` crosses this boundary and nothing else does).
 */
/** The two roles there are, written once so both sides compare against the same word (architecture.md §4.4). */
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
 * A person as the admin pages see them — deliberately more than `userSchema`
 * tells anyone about anyone else (architecture.md §4.4).
 */
export const registeredUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  role: z.enum(ROLES),
  /** The account this person owns, which is theirs alone. */
  accountName: z.string(),
  hasSignedIn: z.boolean(),
  /** That their access was taken away (issue 233; architecture.md §4.4). */
  disabled: z.boolean(),
});
export type RegisteredUser = z.infer<typeof registeredUserSchema>;

/** Everyone this Cockpit knows, for the admin pages. */
export const registeredUserListSchema = z.object({ users: z.array(registeredUserSchema) });
export type RegisteredUserList = z.infer<typeof registeredUserListSchema>;

/** How much a box may hold, so the boxes and the schemas below cannot drift. 254 is the longest address an SMTP envelope carries. */
export const NAME_LIMIT = 120;
export const ADDRESS_LIMIT = 254;

/**
 * Adding somebody: their name, and the Google address they will sign in with
 * (issue 231; architecture.md §4.4 for why the bounds are this loose).
 */
export const addUserSchema = z.object({
  name: z.string().min(1).max(NAME_LIMIT),
  email: z.string().min(1).max(ADDRESS_LIMIT),
});
export type AddUser = z.infer<typeof addUserSchema>;

/** What adding somebody answered (architecture.md §4.4 — `accountReady` is false rather than an error). */
export const userAddedSchema = z.object({
  user: registeredUserSchema,
  accountReady: z.boolean(),
});
export type UserAdded = z.infer<typeof userAddedSchema>;

/**
 * Changing somebody: the name they are shown by and the role that decides what
 * they may reach (issue 232; architecture.md §4.4 for why both fields travel together).
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
 * Taking somebody's access away, or giving it back (issue 233). Its own
 * request rather than a third field on the form (architecture.md §4.4).
 */
export const setAccessSchema = z.object({ disabled: z.boolean() });
export type SetAccess = z.infer<typeof setAccessSchema>;

/**
 * Why an admin may not be left unable to admin, or `null` when they may — the
 * one rule both sides of every such change have to agree on (architecture.md §4.4).
 */
export function losingAdminIsRefused({
  who,
  stillAnAdmin,
  askedBy,
  admins,
}: {
  /** The person being changed, as the register holds them today. */
  who: { id: string; role: string };
  /** Whether they would still be an admin who can sign in afterwards (issue 233). */
  stillAnAdmin: boolean;
  /** Who is asking, which one of the two reasons is about. */
  askedBy: string | undefined;
  /** How many admins the register holds, this person included. */
  admins: number;
}): 'the last admin' | 'your own' | null {
  if (who.role !== ADMIN || stillAnAdmin) return null;
  if (admins <= 1) return 'the last admin';
  return who.id === askedBy ? 'your own' : null;
}
