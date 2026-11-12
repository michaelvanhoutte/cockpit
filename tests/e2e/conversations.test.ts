import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { isLinkedWorktree, portsFor } from "../../scripts/lib/ports.mjs";
import {
  chooseRowAction,
  closeCapture,
  closeSettings,
  dashboardBar,
  deleteWorkspace,
  expect,
  itemRow,
  makeWorkspace,
  openCapture,
  openFirstWorkspace,
  openSettings,
  press,
  switchTo,
  test,
  uniqueTitle,
} from "./support/app";
import { arrange, giveAWorkspace, giveToTheInbox } from "./support/arrange";

const root = resolve(__dirname, "..", "..");
/** The stub the stack runs, which stands in for Gmail's mailbox as well as for Google's sign-in. */
const issuer = `http://127.0.0.1:${portsFor(root, { linked: isLinkedWorktree(root), env: process.env }).e2eIssuer}`;
const MAILBOX = "michael@example.com";

/**
 * F3: a Gmail conversation starred after connecting is one Item whose row says
 * who wrote last, and whose status follows ("A Gmail starred conversation is
 * one Item whose status follows who wrote last", issue 1705). Only the sign-in,
 * the check, the store and the row together make the line appear. The line's
 * wording is apps/web/tests/unit/conversationLine.test.ts's; which message is a
 * turn, the Gmail connector's own tests'; what a turn does to the status,
 * apps/api/tests/unit/domain/conversations.test.ts's.
 *
 * **It makes its own workspace and puts it back**, as connections.test.ts does.
 */

/** Something done in the stand-in mailbox, as a person does it in Gmail: answers what the stub says it made. */
async function inGmail(
  what: "star" | "reply" | "linkedin",
  query: Record<string, string>,
): Promise<{ thread: string; message: string }> {
  const answer = await fetch(
    `${issuer}/gmail-stub/${what}?${new URLSearchParams({ email: MAILBOX, ...query })}`,
    { method: "POST" },
  );
  return (await answer.json()) as { thread: string; message: string };
}

/** Every call the mailbox was asked, oldest first. */
async function askedOfGmail(): Promise<string[]> {
  return (await (
    await fetch(
      `${issuer}/gmail-stub/asked?email=${encodeURIComponent(MAILBOX)}`,
    )
  ).json()) as string[];
}

/**
 * The connection checked once more after what the mailbox just took: *Check
 * now*, through the route the row's own menu sends, until a check starts that
 * reads the history again - one already running may have read it before.
 */
async function checkedAgain(page: Page): Promise<void> {
  const workspaceId = new URL(page.url()).pathname.split("/")[2]!;
  const listed = (await (
    await page.request.get(`/v1/workspaces/${workspaceId}/connections`)
  ).json()) as {
    sourceAccounts: { id: string; connectorId: string }[];
  };
  const gmail = listed.sourceAccounts.find(
    (one) => one.connectorId === "gmail",
  )!;
  const before = (await askedOfGmail()).length;
  await expect
    .poll(async () => {
      const pressed = await page.request.post(
        `/v1/workspaces/${workspaceId}/connections/${gmail.id}/check-now`,
      );
      return ((await pressed.json()) as { status: string }).status;
    })
    .not.toBe("running");
  await expect
    .poll(async () =>
      (await askedOfGmail())
        .slice(before)
        .some((call) => call.startsWith("history")),
    )
    .toBe(true);
}

/** Something done in the stand-in Outlook mailbox, as a person does it there: answers what the stub says it made. */
async function inOutlook(
  what: "flag" | "reply",
  query: Record<string, string>,
): Promise<{ id: string; conversation: string }> {
  const answer = await fetch(
    `${issuer}/graph-stub/${what}?${new URLSearchParams({ email: MAILBOX, ...query })}`,
    { method: "POST" },
  );
  return (await answer.json()) as { id: string; conversation: string };
}

async function askedOfOutlook(): Promise<string[]> {
  return (await (
    await fetch(
      `${issuer}/graph-stub/asked?email=${encodeURIComponent(MAILBOX)}`,
    )
  ).json()) as string[];
}

/** The Outlook connection checked once more after what the mailbox just took: *Check now* until a check starts that lists Deleted Items again. */
async function outlookCheckedAgain(page: Page): Promise<void> {
  const workspaceId = new URL(page.url()).pathname.split("/")[2]!;
  const listed = (await (
    await page.request.get(`/v1/workspaces/${workspaceId}/connections`)
  ).json()) as {
    sourceAccounts: { id: string; connectorId: string }[];
  };
  const outlook = listed.sourceAccounts.find(
    (one) => one.connectorId === "outlook",
  )!;
  const before = (await askedOfOutlook()).length;
  await expect
    .poll(async () => {
      const pressed = await page.request.post(
        `/v1/workspaces/${workspaceId}/connections/${outlook.id}/check-now`,
      );
      return ((await pressed.json()) as { status: string }).status;
    })
    .not.toBe("running");
  await expect
    .poll(async () =>
      (await askedOfOutlook())
        .slice(before)
        .includes("GET mailFolders/deleteditems"),
    )
    .toBe(true);
}

/** Connect on the Gmail card, picking the star, and wait until the first check has read where the mailbox stands - what is starred after is brought in. */
async function connectedByStar(page: Page, isMobile: boolean): Promise<void> {
  const window = await openSettings(page, "Connections", isMobile);
  await press(window.getByRole("button", { name: "Connect Gmail" }), isMobile);
  const asked = page.getByRole("dialog", { name: "Connect Gmail" });
  await press(asked.getByText("Starred (flagged in Outlook)"), isMobile);
  await press(asked.getByRole("button", { name: "Connect" }), isMobile);
  const askedBefore = (await askedOfGmail()).length;
  await press(page.getByRole("link", { name: MAILBOX, exact: true }), isMobile);
  await expect(
    page.getByRole("dialog", { name: "Settings" }).getByText(/^Checked /),
  ).toBeVisible();
  await expect
    .poll(async () => (await askedOfGmail()).slice(askedBefore))
    .toContain("profile");
  await closeSettings(page, isMobile);
}

/**
 * Connect on the Gmail card choosing the star, by the address its button goes
 * to rather than the button: a phone has no Settings to press it in. Waits until
 * the first check has read where the mailbox stands.
 */
async function connectedByStarFromTheAddress(
  page: Page,
  isMobile: boolean,
): Promise<void> {
  const workspaceId = new URL(page.url()).pathname.split("/")[2]!;
  const askedBefore = (await askedOfGmail()).length;
  await page.goto(
    `/v1/workspaces/${workspaceId}/connections/gmail/connect?choice=star`,
  );
  await page.getByRole("link", { name: MAILBOX, exact: true }).click();
  await expect
    .poll(async () => (await askedOfGmail()).slice(askedBefore))
    .toContain("profile");
  // Coming back from Google opens Settings on its Connections at a desk, and nothing on a phone.
  if (!isMobile) await closeSettings(page, isMobile);
}

/**
 * A Gmail connection and an Outlook connection of the open Workspace, by the
 * address each connect goes to (a phone has no Settings to press them in): the
 * Gmail one is the stub's own `MAILBOX`, the Outlook one signs in as `address`.
 * Waits until both are listed, then reloads so the Workspace holds both.
 */
async function gmailAndOutlookConnected(
  page: Page,
  isMobile: boolean,
  address: string,
): Promise<string[]> {
  const workspaceId = new URL(page.url()).pathname.split("/")[2]!;
  const listedNow = async () =>
    (
      (await (
        await page.request.get(`/v1/workspaces/${workspaceId}/connections`)
      ).json()) as {
        sourceAccounts: { id: string; connectorId: string }[];
      }
    ).sourceAccounts;
  await page.goto(
    `/v1/workspaces/${workspaceId}/connections/gmail/connect?choice=star`,
  );
  await page.getByRole("link", { name: MAILBOX, exact: true }).click();
  await expect
    .poll(async () =>
      (await listedNow()).some((one) => one.connectorId === "gmail"),
    )
    .toBe(true);
  if (!isMobile) await closeSettings(page, isMobile);
  await page.goto(
    `/v1/workspaces/${workspaceId}/connections/outlook/connect?choice=flag`,
  );
  await page.getByPlaceholder("somebody@example.com").fill(address);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect
    .poll(async () =>
      (await listedNow()).some((one) => one.connectorId === "outlook"),
    )
    .toBe(true);
  if (!isMobile) await closeSettings(page, isMobile);
  await page.reload();
  return (await listedNow()).map((one) => one.id);
}

test.describe("Triage", () => {
  test.describe("Follow a sent email… in Capture lists the mailbox’s newest sent mail, and a pick is an Item waiting for a reply", () => {
    test("lists the newest first, one entry a row, and picking the first reads Gmail · You wrote in the Inbox, Waiting since", async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle("Followed sent");
      await giveAWorkspace(page, workspace);
      await page.reload();
      await switchTo(page, workspace, isMobile);
      await connectedByStarFromTheAddress(page, isMobile);

      // An email sent from the mailbox just now, so it is the newest whatever the mailbox held before.
      const subject = uniqueTitle("Quote for the kitchen");
      await fetch(
        `${issuer}/gmail-stub/send?${new URLSearchParams({ email: MAILBOX, subject, to: "Marc Lambrecht <marc@example.com>", text: "Attached is the quote." })}`,
        { method: "POST" },
      );

      await openCapture(page, isMobile);
      await press(
        page.getByRole("button", { name: "Follow a sent email…" }),
        isMobile,
      );
      const list = page.getByRole("region", { name: "Follow a sent email" });
      const entries = list.locator("[data-sent-email]");
      await expect(entries.first()).toContainText(subject);
      await expect(entries.first()).toContainText("To Marc Lambrecht");
      await expect(entries.nth(1)).toBeVisible();
      expect(await entries.count()).toBeLessThanOrEqual(10);

      // One entry a row, each the width of the list; on a phone the list is the width of the page.
      const boxes = await entries.evaluateAll((all) =>
        all.map((one) => one.getBoundingClientRect().toJSON() as DOMRect),
      );
      const listBox = (await list.boundingBox())!;
      for (const [at, box] of boxes.entries()) {
        expect(
          Math.abs(box.width - listBox.width),
          `entry ${at} is as wide as the list`,
        ).toBeLessThanOrEqual(2);
        if (at > 0)
          expect(
            box.top,
            `entry ${at} is under the one before`,
          ).toBeGreaterThanOrEqual(boxes[at - 1]!.bottom - 1);
      }
      if (isMobile)
        expect(listBox.width).toBeGreaterThan(
          page.viewportSize()!.width * 0.85,
        );

      await press(entries.first(), isMobile);
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: `Following “${subject}” → Inbox` }),
      ).toBeVisible();
      await closeCapture(page, isMobile);

      // A phone draws the Inbox as a screen of its own.
      if (isMobile)
        await press(
          dashboardBar(page).getByRole("link", { name: "Inbox" }),
          isMobile,
        );
      const row = itemRow(page, subject);
      await expect(row).toBeVisible();
      await expect(row.getByText(/^Waiting since/)).toBeVisible();
      await expect(row.getByText("Gmail · You wrote just now")).toBeVisible();
      await expect(
        row.getByRole("link", { name: "Open the latest email in Gmail" }),
      ).toHaveAttribute("href", /#all\/sent-\d+$/);

      const workspaceId = new URL(page.url()).pathname.split("/")[2]!;
      const listed = (await (
        await page.request.get(`/v1/workspaces/${workspaceId}/connections`)
      ).json()) as {
        sourceAccounts: { id: string; connectorId: string }[];
      };
      await arrange(page, "disconnect_source_account", {
        sourceAccountId: listed.sourceAccounts.find(
          (one) => one.connectorId === "gmail",
        )!.id,
      });
      await deleteWorkspace(page, workspace, isMobile);
    });
  });

  test.describe("a followed Gmail conversation’s row says who wrote last, and its status follows", () => {
    test("reads Steven replied on his reply, To do, then You wrote with Waiting since on yours, and opens the conversation", async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, "a phone has no Connections, only Appearance");
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle("Followed");
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      await connectedByStar(page, isMobile);

      const purpose = uniqueTitle("Dinner with Steven");
      const { thread } = await inGmail("star", {
        subject: purpose,
        text: "Shall we have dinner one of these weeks?",
      });
      await checkedAgain(page);
      const row = itemRow(page, purpose);
      await expect(row).toBeVisible();

      // Steven answers, starred or not: the row says so, and the Item is to do.
      const { message: reply } = await inGmail("reply", {
        thread,
        from: "Steven Noels <steven@example.com>",
        text: "Thursday is tricky, how about Friday?",
      });
      await checkedAgain(page);
      await expect(
        row.getByText("Gmail · Steven replied just now"),
      ).toBeVisible();
      await expect(
        row.getByText("Gmail · Steven replied just now"),
      ).toHaveAttribute(
        "title",
        "Steven Noels: Thursday is tricky, how about Friday?",
      );
      await expect(row.getByText(/^Waiting since/)).toHaveCount(0);
      const open = row.getByRole("link", {
        name: "Open the latest email in Gmail",
      });
      // His reply itself, not the conversation, whose id is its first email's (issue 1720).
      await expect(open).toHaveAttribute("href", new RegExp(`#all/${reply}$`));

      // Its form shows the conversation under the description ("Show the conversation an Item follows in its form", issue 1706).
      await press(row.getByRole("button", { name: "Item actions" }), isMobile);
      await press(
        page.getByRole("menuitem", { name: "Open", exact: true }),
        isMobile,
      );
      const conversation = page.getByRole("region", { name: "Conversation" });
      await expect(conversation).toBeVisible();
      await expect(conversation.getByText(/Steven replied/)).toBeVisible();
      await expect(
        conversation.getByText("“Thursday is tricky, how about Friday?”"),
      ).toBeVisible();
      await expect(
        conversation.getByRole("link", {
          name: "Open the latest email in Gmail",
        }),
      ).toHaveAttribute("href", new RegExp(`#all/${reply}$`));
      await page.keyboard.press("Escape");
      await expect(conversation).toBeHidden();

      // Your reply arrives: the same row, now waiting for his.
      await inGmail("reply", { thread, sent: "" });
      await checkedAgain(page);
      await expect(row.getByText("Gmail · You wrote just now")).toBeVisible();
      await expect(row.getByText(/^Waiting since/)).toBeVisible();

      await openSettings(page, "Connections", isMobile);
      await chooseRowAction(page, MAILBOX, "Disconnect", isMobile);
      await press(
        page.getByRole("button", { name: `Yes, disconnect ${MAILBOX}` }),
        isMobile,
      );
      await expect(
        page.getByRole("dialog").getByText(/Nothing connected yet/),
      ).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });

  test.describe("Email… opens the draft it made in a new tab, and Reply… with points asks Claude for the draft; the row says the draft is started", () => {
    test("opens a tab at the mailbox’s draft and reads Gmail · Draft started, In progress; then Reply… asks what Claude should say and opens the draft holding what was written", async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, "a phone has no Connections, only Appearance");
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle("Emailed");
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);
      await connectedByStar(page, isMobile);
      // The draft's own page is Gmail's, which no walk may reach: answered here, so only its address is checked.
      await page
        .context()
        .route("https://mail.google.com/**", (route) =>
          route.fulfill({ body: "the draft" }),
        );

      const purpose = uniqueTitle("Plan a dinner with Steven Noels");
      await giveToTheInbox(page, [purpose]);
      const row = itemRow(page, purpose);
      await expect(row).toBeVisible();
      await press(row.getByRole("button", { name: "Item actions" }), isMobile);
      await press(page.getByRole("menuitem", { name: "Email…" }), isMobile);
      // Where Claude can write the draft the press first asks what it should say; Write it myself makes the empty draft.
      const [tab] = await Promise.all([
        page.waitForEvent("popup"),
        press(page.getByRole("button", { name: "Write it myself" }), isMobile),
      ]);

      await expect(tab).toHaveURL(/#drafts\?compose=[B-Zb-z]+$/);
      await expect(row.getByText("Gmail · Draft started")).toBeVisible();
      // While it is unsent, Open goes to the draft itself (issue 1720).
      await expect(
        row.getByRole("link", { name: "Open the draft in Gmail" }),
      ).toHaveAttribute("href", /#drafts\?compose=[B-Zb-z]+$/);
      await expect(row.getByText("In progress")).toBeVisible();
      const drafts = (await (
        await fetch(
          `${issuer}/gmail-stub/drafts?email=${encodeURIComponent(MAILBOX)}`,
        )
      ).json()) as { subject: string }[];
      expect(drafts.map((one) => one.subject)).toContain(purpose);
      await tab.close();

      // Where the Item follows a conversation Claude can write the reply: Reply… asks what it should say (issue 1730). What the real model writes is the contract tier's.
      const followed = uniqueTitle("Plan a dinner with Steven Noels");
      const { thread } = await inGmail("star", {
        subject: followed,
        text: "Shall we have dinner one of these weeks?",
      });
      await checkedAgain(page);
      await inGmail("reply", {
        thread,
        from: "Steven Noels <steven@example.com>",
        text: "Thursday evening?",
      });
      await checkedAgain(page);
      const followedRow = itemRow(page, followed);
      await expect(followedRow.getByText("Gmail · Steven replied just now")).toBeVisible();

      await press(followedRow.getByRole("button", { name: "Item actions" }), isMobile);
      await press(page.getByRole("menuitem", { name: "Reply…", exact: true }), isMobile);
      const box = page.getByRole("dialog", {
        name: /Anything Claude should say/,
      });
      await expect(box).toBeVisible();
      await box.getByRole("textbox").fill("only after 8pm");
      await expect(
        box.getByRole("button", { name: "Write it myself" }),
      ).toBeDisabled();
      const [claudeTab] = await Promise.all([
        page.waitForEvent("popup"),
        press(box.getByRole("button", { name: "Draft with Claude" }), isMobile),
      ]);

      await expect(claudeTab).toHaveURL(/#drafts(\/[B-Zb-z]+)?$/);
      await expect(box).toBeHidden();
      // The Inbox column is narrow enough to cut the source's line to nothing, so it is checked in the row, not by sight.
      await expect(followedRow.getByText("Gmail · Draft started")).toBeAttached();
      await expect(followedRow.getByText("In progress")).toBeVisible();
      const claudeDrafts = (await (
        await fetch(
          `${issuer}/gmail-stub/drafts?email=${encodeURIComponent(MAILBOX)}`,
        )
      ).json()) as { thread: string; body: string }[];
      const draft = claudeDrafts.find((one) => one.thread === thread);
      expect(draft?.body).toContain("Points: only after 8pm");
      expect(draft?.body).toContain("shown 2 messages");
      await claudeTab.close();

      await openSettings(page, "Connections", isMobile);
      await chooseRowAction(page, MAILBOX, "Disconnect", isMobile);
      await press(
        page.getByRole("button", { name: `Yes, disconnect ${MAILBOX}` }),
        isMobile,
      );
      await expect(
        page.getByRole("dialog").getByText(/Nothing connected yet/),
      ).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });

  test.describe("a followed LinkedIn conversation’s row says LinkedIn, and opens LinkedIn", () => {
    test("reads LinkedIn · Steven wrote, then replied on a later notification, opens linkedin.com, and offers no Email…", async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, "a phone has no Connections, only Appearance");
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle("LinkedIn");
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);
      await connectedByStar(page, isMobile);

      // A LinkedIn message notification, starred: the Item follows the LinkedIn conversation, not the email.
      const subject = uniqueTitle("Steven Noels sent you a message");
      const conversation = "2-ZmFrZS1lMmUtdGhyZWFk";
      const { message } = await inGmail("linkedin", {
        subject,
        text: "Shall we have dinner on Thursday?",
        conversation,
      });
      await inGmail("star", { message });
      await checkedAgain(page);
      const row = itemRow(page, subject);
      await expect(
        row.getByText("LinkedIn · Steven wrote just now"),
      ).toBeVisible();
      await expect(
        row.getByRole("link", { name: "Open the conversation in LinkedIn" }),
      ).toHaveAttribute(
        "href",
        `https://www.linkedin.com/messaging/thread/${conversation}/`,
      );
      await press(row.getByRole("button", { name: "Item actions" }), isMobile);
      await expect(
        page.getByRole("menuitem", { name: "Open", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("menuitem", { name: /^Email/ })).toHaveCount(
        0,
      );
      await page.keyboard.press("Escape");

      // Another notification about it, in a Gmail conversation of its own and not starred: still Steven's turn on this row.
      await inGmail("linkedin", {
        subject: uniqueTitle("Another notification"),
        text: "Friday works too.",
        conversation,
      });
      await checkedAgain(page);
      await expect(
        row.getByText("LinkedIn · Steven replied just now"),
      ).toBeVisible();
      await expect(
        row.getByText("LinkedIn · Steven replied just now"),
      ).toHaveAttribute("title", "Steven Noels: Friday works too.");

      // Its form opens LinkedIn too, and counts nothing it cannot see.
      await press(row.getByRole("button", { name: "Item actions" }), isMobile);
      await press(
        page.getByRole("menuitem", { name: "Open", exact: true }),
        isMobile,
      );
      const section = page.getByRole("region", { name: "Conversation" });
      await expect(
        section.getByText("LinkedIn", { exact: true }),
      ).toBeVisible();
      await expect(
        section.getByRole("link", {
          name: "Open the conversation in LinkedIn",
        }),
      ).toHaveAttribute(
        "href",
        `https://www.linkedin.com/messaging/thread/${conversation}/`,
      );
      await expect(section.getByText("With Steven Noels")).toBeVisible();
      await expect(section.getByText(/emails?/)).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(section).toBeHidden();

      await openSettings(page, "Connections", isMobile);
      await chooseRowAction(page, MAILBOX, "Disconnect", isMobile);
      await press(
        page.getByRole("button", { name: `Yes, disconnect ${MAILBOX}` }),
        isMobile,
      );
      await expect(
        page.getByRole("dialog").getByText(/Nothing connected yet/),
      ).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });
  test.describe("a followed Outlook conversation’s row says who wrote last, and a reply turns it To do", () => {
    test("reads Outlook · Anna wrote, then Steven replied, with the status To do, and opens the latest message", async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, "a phone has no Connections, only Appearance");
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle("Followed in Outlook");
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      const window = await openSettings(page, "Connections", isMobile);
      await press(
        window.getByRole("button", { name: "Connect Outlook" }),
        isMobile,
      );
      const asked = page.getByRole("dialog", { name: "Connect Outlook" });
      await expect(asked.getByRole("radio", { name: "Flagged" })).toBeChecked();
      await press(asked.getByRole("button", { name: "Connect" }), isMobile);
      await press(
        page.getByRole("link", { name: MAILBOX, exact: true }),
        isMobile,
      );
      await expect(
        page.getByRole("dialog", { name: "Settings" }).getByText(/^Checked /),
      ).toBeVisible();
      await closeSettings(page, isMobile);

      // A message flagged after connecting: one Item for its conversation.
      const purpose = uniqueTitle("Dinner with Steven");
      const { conversation, id } = await inOutlook("flag", {
        subject: purpose,
        text: "Shall we have dinner one of these weeks?",
      });
      await outlookCheckedAgain(page);
      const row = itemRow(page, purpose);
      await expect(
        row.getByText("Outlook · Anna wrote just now"),
      ).toBeVisible();

      // Steven answers, flagged or not: the row says so, and the Item is to do.
      await inOutlook("reply", {
        conversation,
        from: "Steven Noels <steven@example.com>",
        text: "Thursday is tricky, how about Friday?",
      });
      await outlookCheckedAgain(page);
      await expect(
        row.getByText("Outlook · Steven replied just now"),
      ).toBeVisible();
      await expect(
        row.getByText("Outlook · Steven replied just now"),
      ).toHaveAttribute(
        "title",
        "Steven Noels: Thursday is tricky, how about Friday?",
      );
      await expect(row.getByText(/^Waiting since/)).toHaveCount(0);
      await expect(
        row.getByRole("link", { name: "Open the latest email in Outlook" }),
      ).toBeVisible();

      // Your reply, sent from the mailbox: waiting for his.
      await inOutlook("reply", { conversation, sent: "" });
      await outlookCheckedAgain(page);
      await expect(row.getByText("Outlook · You wrote just now")).toBeVisible();
      await expect(row.getByText(/^Waiting since/)).toBeVisible();

      // Done completes the flag in the mailbox.
      await press(row.getByRole("button", { name: "Item actions" }), isMobile);
      await press(page.getByRole("menuitem", { name: /^Status/ }), isMobile);
      await press(page.getByRole("menuitemradio", { name: "Done" }), isMobile);
      await expect(row).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (
              (await (
                await fetch(
                  `${issuer}/graph-stub/message?email=${encodeURIComponent(MAILBOX)}&id=${id}`,
                )
              ).json()) as { flagStatus: string }
            ).flagStatus,
        )
        .toBe("complete");

      await openSettings(page, "Connections", isMobile);
      await chooseRowAction(page, MAILBOX, "Disconnect", isMobile);
      await press(
        page.getByRole("button", { name: `Yes, disconnect ${MAILBOX}` }),
        isMobile,
      );
      await expect(
        page.getByRole("dialog").getByText(/Nothing connected yet/),
      ).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });

  test.describe("Email… with an Outlook connection opens the draft it made in a new tab, and the row follows the draft", () => {
    test("opens a tab at the mailbox’s draft and reads Outlook · Draft started, then Waiting for reply once the draft is sent", async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, "a phone has no Connections, only Appearance");
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle("Emailed in Outlook");
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);

      const window = await openSettings(page, "Connections", isMobile);
      await press(
        window.getByRole("button", { name: "Connect Outlook" }),
        isMobile,
      );
      const asked = page.getByRole("dialog", { name: "Connect Outlook" });
      await expect(asked.getByRole("radio", { name: "Flagged" })).toBeChecked();
      await press(asked.getByRole("button", { name: "Connect" }), isMobile);
      await press(
        page.getByRole("link", { name: MAILBOX, exact: true }),
        isMobile,
      );
      await expect(
        page.getByRole("dialog", { name: "Settings" }).getByText(/^Checked /),
      ).toBeVisible();
      await closeSettings(page, isMobile);
      // The draft's own page is Outlook's, which no walk may reach: answered here, so only its address is checked.
      await page
        .context()
        .route("https://outlook.office365.com/**", (route) =>
          route.fulfill({ body: "the draft" }),
        );

      const purpose = uniqueTitle("Plan a dinner with Steven Noels");
      await giveToTheInbox(page, [purpose]);
      const row = itemRow(page, purpose);
      await expect(row).toBeVisible();
      await press(row.getByRole("button", { name: "Item actions" }), isMobile);
      await press(page.getByRole("menuitem", { name: "Email…" }), isMobile);
      // Outlook too asks first what Claude should say; Write it myself makes the empty draft.
      const [tab] = await Promise.all([
        page.waitForEvent("popup"),
        press(page.getByRole("button", { name: "Write it myself" }), isMobile),
      ]);

      await expect(tab).toHaveURL(/ItemID=AAkALgStubDraft\d+/);
      await expect(row.getByText("Outlook · Draft started")).toBeVisible();
      await expect(row.getByText("In progress")).toBeVisible();
      const drafts = (await (
        await fetch(
          `${issuer}/graph-stub/drafts?email=${encodeURIComponent(MAILBOX)}`,
        )
      ).json()) as { id: string; subject: string }[];
      const draft = drafts.find((one) => one.subject === purpose);
      expect(draft).toBeDefined();
      await tab.close();

      // The draft sent from Outlook: waiting for his reply.
      await fetch(
        `${issuer}/graph-stub/send-draft?email=${encodeURIComponent(MAILBOX)}&id=${draft!.id}`,
        { method: "POST" },
      );
      await outlookCheckedAgain(page);
      await expect(row.getByText("Outlook · You wrote just now")).toBeVisible();
      await expect(row.getByText(/^Waiting since/)).toBeVisible();

      await openSettings(page, "Connections", isMobile);
      await chooseRowAction(page, MAILBOX, "Disconnect", isMobile);
      await press(
        page.getByRole("button", { name: `Yes, disconnect ${MAILBOX}` }),
        isMobile,
      );
      await expect(
        page.getByRole("dialog").getByText(/Nothing connected yet/),
      ).toBeVisible();
      await closeSettings(page, isMobile);
      await deleteWorkspace(page, workspace, isMobile);
    });
  });

  /**
   * "Email…'s mailbox menu does not say it is the From" (issue 1723): what the
   * menu draws is the component tests'; how wide it comes out, and that nothing
   * crosses its edge or the screen's, only a browser measures.
   */
  test.describe("the mailbox menu fits the longest address up to 320px, cutting a longer one, and nothing crosses an edge", () => {
    // The Gmail address fits; the Outlook one is past the limit, so one walk sees both.
    const address =
      "a.very.long.shared.mailbox.address.for.the.whole.team@subsidiary.example.com";
    const inARegExp = (text: string) => new RegExp(text.replace(/\./g, "\\."));
    test("heads From over Gmail and Outlook, the short address whole and the long one cut", async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);
      const workspace = uniqueTitle("Mailbox menu");
      await makeWorkspace(page, workspace, isMobile);
      await switchTo(page, workspace, isMobile);
      const sourceAccountIds = await gmailAndOutlookConnected(
        page,
        isMobile,
        address,
      );

      const purpose = uniqueTitle("Plan a dinner with Steven Noels");
      // Into this Workspace by name: one captured to no Workspace may be routed to another before the row is looked for.
      await giveToTheInbox(page, [purpose], {
        id: new URL(page.url()).pathname.split("/")[2]!,
        name: workspace,
      });
      if (isMobile)
        await press(
          dashboardBar(page).getByRole("link", { name: "Inbox" }),
          isMobile,
        );
      const row = itemRow(page, purpose);
      await expect(row).toBeVisible();
      await press(row.getByRole("button", { name: "Item actions" }), isMobile);
      await press(page.getByRole("menuitem", { name: /^Email…/ }), isMobile);

      const heading = page.getByText("From", { exact: true });
      await expect(heading).toBeVisible();
      const menu = page.getByRole("menu").filter({ has: heading });
      await expect(
        menu.getByRole("menuitem", { name: inARegExp(address) }),
      ).toContainText("Outlook");
      await expect(
        menu.getByRole("menuitem", { name: inARegExp(MAILBOX) }),
      ).toContainText("Gmail");

      const box = (await menu.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      expect(box.width).toBeLessThanOrEqual(321);
      // Every line stops inside the menu; the one cut says so by its own overflow, and says its whole name on hover.
      const lines = await menu.getByRole("menuitem").evaluateAll((items) =>
        items.flatMap((item) => {
          const edge = item
            .closest('[role="menu"]')!
            .getBoundingClientRect().right;
          return [...item.querySelectorAll("div")].map((line) => ({
            text: line.textContent,
            right: line.getBoundingClientRect().right,
            edge,
            cut: line.scrollWidth > line.clientWidth,
            title: line.getAttribute("title"),
          }));
        }),
      );
      for (const line of lines)
        expect(line.right).toBeLessThanOrEqual(line.edge);
      const long = lines.find((line) => line.text === address)!;
      expect(long.cut).toBe(true);
      expect(long.title).toBe(address);
      const short = lines.find((line) => line.text === MAILBOX)!;
      expect(short.cut).toBe(false);
      expect(box.width).toBeGreaterThanOrEqual(319);

      await page.keyboard.press("Escape");
      for (const sourceAccountId of sourceAccountIds)
        await arrange(page, "disconnect_source_account", { sourceAccountId });
      await deleteWorkspace(page, workspace, isMobile);
    });
  });
});
