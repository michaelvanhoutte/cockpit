import {
  DEFAULT_WORKSPACE_THEME,
  DEMO_PAGES,
  type DemoPage as DemoPageName,
} from "@cockpit/shared";

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
const WORDS: Record<DemoPageName, { title: string; where: string }> = {
  gmail: { title: "Gmail", where: "the email in Gmail" },
  teams: { title: "Microsoft Teams", where: "the message in Microsoft Teams" },
};

export function DemoPage({ page }: { page: string }) {
  const words = (DEMO_PAGES as readonly string[]).includes(page)
    ? WORDS[page as DemoPageName]
    : null;
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center px-4"
      style={{ backgroundColor: DEFAULT_WORKSPACE_THEME.ground }}
    >
      <main className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-panel">
        <h1 className="text-xl font-semibold tracking-tight">
          {words
            ? `This is where ${words.title} would open`
            : "Nothing opens here"}
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          {words
            ? `In your own Cockpit, Open ↗ takes you to ${words.where}. This demo is not connected to a real ${words.title} account, so it stops here.`
            : "This demo address does not lead anywhere."}
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
