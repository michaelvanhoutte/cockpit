import { demoPageOf, type Item } from '@cockpit/shared';

/**
 * What each source is called, by its connector id, as the Workspace's snapshot
 * carries it (`sourceNames`). Possibly absent: a copy stored before it was
 * carried is restored without it.
 */
export type SourceNames = Readonly<Record<string, string>> | undefined;

/**
 * What a source is called on screen ("Take source names out of the shared
 * contract", issue 927): its connector's own name, where the environment
 * registers it, and the id itself where it does not - so a source this app was
 * never built with still reads as something.
 */
export function sourceNamed(names: SourceNames, source: string): string {
  // Own keys only, so an id such as `constructor` is never read off the prototype.
  return names && Object.hasOwn(names, source) ? names[source]! : source;
}

/** Where Cockpit draws the page for one of the guest demo's addresses (`DemoPage`, pages/DemoPage.tsx). */
export const demoPath = (page: string) => `/demo/${page}`;

/**
 * Where a stored link is opened: the guest demo's own addresses become
 * Cockpit's page for them (issue 773), one on the demo host that names no page
 * opens nothing (null), and any other link passes through as it was. Both the
 * *Open ↗* of an Item and a run's ↗ ask this one place.
 */
export function whereALinkOpens(link: string): string | null {
  const demo = demoPageOf(link);
  if (demo === 'unknown') return null;
  return demo ? demoPath(demo) : link;
}

/**
 * The app that captured an Item, by the name it registered under - null for an
 * Item that no app captured.
 *
 * **The row and the form say this name where the source goes**, and no sender
 * beside it: "Task · Claude", not "mcp · Claude". The protocol is how it got
 * here, not who it is.
 */
export function capturingApp(item: Item): string | null {
  return item.source === 'mcp' ? (item.sender ?? 'An app') : null;
}

/**
 * Where an Item can be opened at its source ("Open an Item at its source",
 * issue 487): the source's own name and the link back to the original.
 *
 * Null for an Item with no way back - an internal one, or one whose source
 * never gave a link - so every surface asks this one place rather than each
 * deciding for itself what "has a source link" means.
 *
 * **Only a web address is ever a link.** The stored field is any URL the schema
 * parses, `javascript:` and `data:` included, and this is the first place it is
 * put in an `href`; a connector that let one through would otherwise run script
 * in this page from a click on a row.
 *
 * **The guest demo's own addresses are translated here, once, for every
 * surface** (issue 773): a link on the reserved demo host opens Cockpit's own
 * page for that source rather than the source, and one on it that names no page
 * opens nothing. Any other link - a named person's real one included - passes
 * through as it was.
 */
export function openableAtSource(item: Item, names: SourceNames): { name: string; link: string } | null {
  if (item.source === 'internal' || !item.sourceLink) return null;
  if (!/^https?:\/\//i.test(item.sourceLink)) return null;
  const name = capturingApp(item) ?? sourceNamed(names, item.source);
  const link = whereALinkOpens(item.sourceLink);
  return link === null ? null : { name, link };
}
