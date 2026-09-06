import { Link } from '@tanstack/react-router';

/**
 * The look every tab in the band under the workspace tabs wears - the
 * dashboards of the workspace you are in, and the two settings pages when you
 * are on one of them.
 *
 * **One string, because the band is one thing.** The band was drawn only inside
 * a workspace, so leaving one took it off the screen and the chrome lost forty
 * pixels of height between two addresses of the same app; the settings page
 * then headed itself with a heading of its own on the sheet, in a style nothing
 * else in the app uses. Two ways of saying "this is the screen you are on" is
 * one too many, and a second tab strip written out again beside this one would
 * be the same mistake a layer down.
 *
 * Rounded at the top only, and filled with the sheet's own colour when it is
 * the one you are on, so the tab runs into the page under it with no line
 * between them; `--tab-on` and `--tab-mark` arrive as custom properties because
 * they are the workspace's and only known at runtime. `.active` rather than a
 * comparison, so the router stays the one thing that decides which is current.
 */
export const bandTabClass =
  'shrink-0 whitespace-nowrap rounded-t-md px-2.5 pt-1 pb-1.5 text-sm text-chrome-ink-soft hover:bg-white/8 hover:text-chrome-ink [&.active]:bg-[var(--tab-on)] [&.active]:font-medium [&.active]:text-ink [&.active]:shadow-[inset_0_2px_0_0_var(--tab-mark)]';

/**
 * The look every tab in the strip above wears - the workspaces, and Capture
 * ahead of them - for the reason `bandTabClass` is one string: two tabs side by
 * side in one strip cannot each carry their own copy of what "the one you are
 * on" looks like.
 *
 * The band's ink inverted, because the strips are opposite ways up: a selected
 * band tab is filled with the sheet and takes the app's dark ink, a selected
 * strip tab is filled with the near-black bar and takes the chrome's light ink.
 * The fill itself is not here - it is the band's own colour, which only the
 * shell knows (`pages/Layout.tsx`).
 *
 * Rounded at the top only and square at the bottom, because the bottom is not
 * an edge: the tab you are on and the band under it are one fill, and a rounded
 * corner there would draw a seam across it. The tint along the top edge is what
 * makes that read as *selected* rather than merely as joined - the header and
 * the band are four values of grey apart - and it is an inset shadow rather
 * than a border so becoming current does not change the tab's height and
 * shuffle the strip.
 *
 * Horizontal padding is the caller's, and the only thing that differs between
 * the two: Capture is set a little wider than a workspace.
 */
export function stripTabClass(here: boolean): string {
  return `shrink-0 whitespace-nowrap rounded-t-lg pt-1.5 pb-2 text-sm ${
    here
      ? 'font-medium text-chrome-ink shadow-[inset_0_2px_0_0_var(--tab-mark)]'
      : 'text-chrome-ink-soft hover:bg-white/8 hover:text-chrome-ink'
  }`;
}

/**
 * What the band holds on the settings pages: the two of them, as tabs, in the
 * place the dashboards of a workspace sit.
 *
 * **They are the page's heading**, which is why there is no other one. A
 * settings page used to carry an `h1` on the sheet, so the app had two
 * unrelated ways of naming the screen you were on and the chrome changed shape
 * between them. The current tab names this screen exactly as the current
 * dashboard tab does.
 *
 * Named "Manage…" rather than "Workspaces" and "Types": these are the pages
 * where those things are managed, and the workspaces themselves are already
 * across the top of the screen in the bar above.
 */
export function SettingsBar({ tint, ground }: { tint: string; ground: string }) {
  return (
    <nav
      aria-label="Settings"
      // No background of its own, and the same insets as the dashboards': the
      // band around it is painted by the shell.
      className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto px-3 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ '--tab-on': ground, '--tab-mark': tint } as React.CSSProperties}
    >
      <Link to="/settings/workspaces" className={bandTabClass}>
        Manage workspaces
      </Link>
      <Link to="/settings/types" className={bandTabClass}>
        Manage types
      </Link>
    </nav>
  );
}
