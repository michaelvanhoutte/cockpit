/**
 * The addresses the guest demo's Items link to ("Seed Gmail and Teams in the
 * guest demo, with fewer items, opening their links inside Cockpit", issue
 * 773).
 *
 * **An Item's stored link must be an absolute URL, and the seed has no origin
 * to make one from**, so a demo Item stores an address on a host that cannot
 * exist and the SPA turns it into one of its own pages (`demoPageOf`,
 * `openableAtSource` in apps/web). The demo never opens Gmail or Teams.
 *
 * **`.invalid` is the host's whole point**: RFC 2606 reserves it and RFC 6761
 * requires every resolver to answer it as not existing. A client that does not
 * translate the address - a browser opening the stored link by hand, an export
 * read elsewhere - reaches nothing rather than somewhere real, which no
 * ordinary domain name could promise (it can be registered tomorrow).
 *
 * **One list of pages, so the next one is a line here.** Each name is both the
 * address's first path segment and the page the SPA draws for it
 * (`/demo/<name>`, apps/web/src/pages/DemoPage.tsx).
 */
export const DEMO_HOST = "demo.cockpit.invalid";

export const DEMO_PAGES = ["gmail", "teams", "session"] as const;
export type DemoPage = (typeof DEMO_PAGES)[number];

/**
 * The stored link for a demo page.
 *
 * **`detail` tells two links to one page apart**: a simulated Claude Code
 * session is `session/<run id>`, so the delayed step that moves one run to
 * *waiting on you* finds that run by the id its own link ends in, the way a
 * real session's hook finds one (`hookNamesSession`).
 */
export function demoAddress(page: DemoPage, detail?: string): string {
  return `https://${DEMO_HOST}/${page}${detail ? `/${encodeURIComponent(detail)}` : ""}`;
}

/**
 * What a link is to the demo: the page it names, `unknown` for an address on
 * the demo host that names none (opens nothing, rather than guessing), and null
 * for any other link, which is somebody's real one and is left alone.
 */
export function demoPageOf(link: string): DemoPage | "unknown" | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== DEMO_HOST)
    return null;
  const named = url.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  return (DEMO_PAGES as readonly string[]).includes(named)
    ? (named as DemoPage)
    : "unknown";
}
