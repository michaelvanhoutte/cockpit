import { resolve } from "node:path";
import { isLinkedWorktree, portsFor } from "../../scripts/lib/ports.mjs";
import {
  closeSettings,
  dashboardBar,
  expect,
  itemRow,
  openFirstWorkspace,
  press,
  switchTo,
  test,
  uniqueTitle,
} from "./support/app";
import { giveAWorkspace } from "./support/arrange";

const root = resolve(__dirname, "..", "..");
/** The stub the stack runs, which stands in for Gmail's mailbox as well as for Google's sign-in. */
const issuer = `http://127.0.0.1:${portsFor(root, { linked: isLinkedWorktree(root), env: process.env }).e2eIssuer}`;
const MAILBOX = "michael@example.com";

/**
 * F3: the Inbox's ↻ brings in what was starred in the mailbox since the last
 * check ("Inbox: mail you just labelled waits for the five-minute check, or a Check now per connection in Settings: add a ↻ to the Inbox heading that checks them all now",
 * issue 1835). Only the alarm, the queue, the connector, the announcement and
 * the heading together show it. When it is drawn, what its note says and what
 * the store marks due are apps/web/tests/unit/components/InboxCheckConnections.test.tsx's
 * and apps/api/tests/integration/connectors/workspace-check-now.test.ts's.
 */
test.describe("Connector management", () => {
  test.describe("Pressing ↻ in the Inbox heading checks the Workspace's connections and brings in what was starred", () => {
    test("shows the starred conversation as an Item and says 1 new", async ({ page, isMobile }) => {
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle("Every connection at once");
      await giveAWorkspace(page, workspace);
      await page.reload();
      await switchTo(page, workspace, isMobile);

      // Connected by the address its button goes to, since a phone has no Settings to press it in.
      const workspaceId = new URL(page.url()).pathname.split("/")[2]!;
      await page.goto(`/v1/workspaces/${workspaceId}/connections/gmail/connect?choice=star`);
      await page.getByRole("link", { name: MAILBOX, exact: true }).click();
      if (!isMobile) await closeSettings(page, isMobile);
      // The first check has ended, so what is starred next is for the press to bring in.
      await expect
        .poll(async () => {
          const listed = (await (await page.request.get(`/v1/workspaces/${workspaceId}/connections`)).json()) as {
            sourceAccounts: { id: string }[];
          };
          const gmail = listed.sourceAccounts[0];
          if (!gmail) return 0;
          const history = (await (
            await page.request.get(`/v1/workspaces/${workspaceId}/connections/${gmail.id}/history`)
          ).json()) as { lines: unknown[] };
          return history.lines.length;
        })
        .toBeGreaterThan(0);
      await page.reload();

      const subject = uniqueTitle("Dinner with Steven");
      await fetch(
        `${issuer}/gmail-stub/star?${new URLSearchParams({ email: MAILBOX, subject, text: "Shall we have dinner one of these weeks?" })}`,
        { method: "POST" },
      );

      // A phone's Inbox is a screen of its own, which the bar's tab opens.
      if (isMobile) await press(dashboardBar(page).getByRole("link", { name: "Inbox" }), isMobile);
      await press(page.getByRole("button", { name: "Check connections now" }), isMobile);

      await expect(itemRow(page, subject)).toBeVisible();
      await expect(page.getByText("Checked 1 connection · 1 new")).toBeVisible();
    });
  });
});
