import { z } from 'zod';

/**
 * A source account a Workspace has connected - a Microsoft Teams sign-in
 * ("Connect a Microsoft Teams source account", issue 485), a Gmail sign-in,
 * and whatever else is connected later.
 *
 * **The credential is never part of this shape.** It is sealed in the
 * Workspace's own store and read by nothing that answers a browser, so the
 * wire carries only what a row has to say: which source it is, whose account
 * at that source, when it was connected, and when it last worked.
 *
 * **It names no source**: `connectorId` is whatever the connector is called,
 * and its name on screen comes with the Workspace (`sourceNames` on the
 * snapshot).
 */
export const sourceAccountSchema = z.object({
  id: z.string(),
  connectorId: z.string(),
  /**
   * Who the source says this account is - a name where it gave one, the
   * address it signs in with otherwise. Read off the identity the source
   * returned rather than typed here, so two accounts of one source can be
   * told apart in the list.
   */
  displayName: z.string(),
  connectedAt: z.iso.datetime(),
  /**
   * The last time this connection was proven to still work - connecting or
   * reconnecting it counts, and so does pressing Test again (issue 569).
   * `null` for a connector nothing ever tests after connecting: what "last
   * worked" means is specific to a connector that can be tested at all.
   */
  lastTestedAt: z.iso.datetime().nullable(),
  /**
   * Why this connection last failed, in words, until it works again - null
   * while nothing says it is failing. Defaulted so an answer from before this field reads as not
   * failing rather than as broken.
   */
  failingBecause: z.string().nullable().default(null),
  /**
   * The one choice the connection made, where its connector declares one
   * (issue 942): the connector's own value, opaque to everything else ("Take
   * source names out of the shared contract", issue 927). A bare string beside
   * `followsLabel` rather than one object, so a client built before either
   * still parses it.
   */
  follows: z.string().optional(),
  /** What the row says it follows, in the connector's own words; absent from a release before it, which then reads as `follows` itself. */
  followsLabel: z.string().optional(),
  /** What a listing under that choice counts, in the connector's words (*flagged*), said by a check's history line beside how many it listed (issue 1196); absent where the connector gave none. */
  followsListed: z.string().optional(),
  /**
   * Whether the connection files what it brings in on the Panel named after
   * its label or category (issue 1146). Defaulted, so an answer from before
   * this field reads as off.
   */
  filesByName: z.boolean().default(false),
  /**
   * Whether the connection keeps a history its row's *History…* opens - a
   * connection Cockpit pulls from (issue 1140) or one its source pushes to
   * (issue 1144). Absent reads as none.
   */
  keepsHistory: z.boolean().optional(),
  /**
   * Whether Cockpit pulls from the source, which is what *Check now* asks of
   * it - a pushed connection has a history and nothing to check (issue 1144).
   * Absent reads as not pulled.
   */
  pulled: z.boolean().optional(),
});
export type SourceAccount = z.infer<typeof sourceAccountSchema>;

export const sourceAccountListSchema = z.object({
  sourceAccounts: sourceAccountSchema.array(),
});
export type SourceAccountList = z.infer<typeof sourceAccountListSchema>;

/**
 * A connector the registry holds and a person can sign in to, as the
 * Connections window draws its card ("List the registry's connectors in the
 * Connections window", issue 894): the manifest's own name and text, nothing
 * the connector keeps to itself.
 */
export const registeredConnectorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  cardText: z.string(),
  /** Whether connecting asks the person something before it leaves for the source: true where `choice` or `names` is present. */
  asksFirst: z.boolean(),
  /**
   * The one choice the connection makes, asked before the sign-in and
   * changeable later ("Ask a connection's one choice on connecting, and change
   * it later", issue 942): the connector's own question and options, a value
   * each stored as given. Absent for a connector that asks nothing.
   */
  choice: z
    .object({
      question: z.string(),
      options: z.object({ value: z.string(), label: z.string() }).array().min(1),
    })
    .optional(),
  /**
   * What the source calls the names a person gives an Item there (*label*,
   * *category*), and how it speaks of an Item carrying one (*a message with
   * the category*), for a connector that reports them (issue 1146): what makes
   * *Change…* offer filing by name, in those words. Absent for one that does not.
   */
  names: z.object({ noun: z.string(), example: z.string() }).optional(),
  /**
   * What the window says when this connector refuses a grant, by the code the
   * redirect back names: the connector's own sentences, listed here because
   * an address cannot be trusted to carry words. Absent from a release before
   * it, which reads as none.
   */
  refusals: z.record(z.string(), z.string()).default({}),
});
export type RegisteredConnector = z.infer<typeof registeredConnectorSchema>;

export const registeredConnectorListSchema = z.object({
  connectors: registeredConnectorSchema.array(),
});
export type RegisteredConnectorList = z.infer<typeof registeredConnectorListSchema>;
