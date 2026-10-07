import {
  DEMO_PAGES,
  type DemoPage as DemoPageName,
} from "@cockpit/shared";
import { usePageGround } from "../appearance";

/**
 * What the guest demo opens in place of a source ("Seed Gmail and Teams in the
 * guest demo, with fewer items, opening their links inside Cockpit", issue 773):
 * a page saying where the mail or message would open, with the way back.
 *
 * **Beside the logon page rather than under the shell**, like it: it carries
 * none of the app's chrome and reads nothing from the account, so it opens in a
 * tab of its own (the *Open ↗* link is a new-tab link) and works signed out.
 * `Record<DemoPageName, …>` makes the next demo page a compile error until it
 * has its words.
 */
const WORDS: Record<DemoPageName, { heading: string; body: string }> = {
  gmail: {
    heading: "This is where Gmail would open",
    body: "In your own Cockpit, Open ↗ takes you to the email in Gmail. This demo is not connected to a real Gmail account, so it stops here.",
  },
  teams: {
    heading: "This is where Microsoft Teams would open",
    body: "In your own Cockpit, Open ↗ takes you to the message in Microsoft Teams. This demo is not connected to a real Microsoft Teams account, so it stops here.",
  },
  // A simulated run's link ("Show agents at work in the guest demo, with
  // simulated runs", issue 774).
  session: {
    heading: "This is where the Claude Code session would be",
    body: "In your own Cockpit, a run's ↗ takes you to its Claude Code session. In this demo the run is played out for you and never reaches Claude, so it stops here.",
  },
};

export function DemoPage({ page }: { page: string }) {
  const ground = usePageGround();
  const words = (DEMO_PAGES as readonly string[]).includes(page)
    ? WORDS[page as DemoPageName]
    : null;
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center px-4"
      style={{ backgroundColor: ground }}
    >
      <main className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-panel">
        <h1 className="text-xl font-semibold tracking-tight">
          {words ? words.heading : "Nothing opens here"}
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          {words ? words.body : "This demo address does not lead anywhere."}
        </p>
        <a
          href="/"
          className="mt-4 flex w-full items-center justify-center rounded-md border border-accent-soft/70 bg-accent-tint px-3 py-2 text-sm font-medium text-accent-deep hover:border-accent hover:bg-accent hover:text-on-accent"
        >
          Back to Cockpit
        </a>
      </main>
    </div>
  );
}

// Also the default export, for the lazy `import()` router.tsx loads this behind.
export default DemoPage;
