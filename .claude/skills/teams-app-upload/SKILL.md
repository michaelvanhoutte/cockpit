---
name: teams-app-upload
description: Cockpit's process for publishing the Teams app to an environment - building the package zip from packages/connectors/teams/teams-app/ with `node scripts/teams-package.mjs`, then, only once the person says yes, uploading it in the Teams admin center through their own Chrome. Use when the Teams app's manifest or icons changed and the change has to reach Teams, or when asked to build, publish, upload or update the Teams app or its package, for staging or production.
---

# Publishing the Teams app

The Teams app is a custom app uploaded per tenant, never a store listing. A changed manifest reaches nobody until its package is uploaded again.

## 1. Build the package

**Start by asking which to publish: staging, production, or both**, even where the request seems to name one, since the person chooses each time. For both, run every step below for staging first, then for production.

```bash
node scripts/teams-package.mjs <environment>
```

The last line it prints is the zip's absolute path. Pass on whatever it refuses instead, and fix only what the person can confirm:

| Refusal | What to do |
|---|---|
| no bot App ID | ask for that environment's Azure Bot Microsoft App ID and put it in `packages/connectors/teams/teams-app/app-ids.json`; it is not a secret, since every uploaded package carries it |
| no `color.png` / `outline.png`, or the wrong size | ask for the icon; Teams wants 192×192 and a transparent 32×32 |
| a placeholder nothing fills | the manifest gained one `scripts/lib/teams-package.mjs` does not know; teach it there, with a test |

**Upload only from `main`, after that environment's deploy carries the server side of the change.** A package whose manifest ran ahead of the deploy offers people a box the server ignores.

## 2. Ask before touching the browser

Uploading replaces the app for the whole organisation, so ask in chat, once per environment, naming the zip, its version and the environment: may I use your Chrome to upload it in the Teams admin center? Wait for a clear yes. Without one, give the path and the steps below for the person to follow, and stop.

## 3. Upload it

Use Claude in Chrome, the person's own signed-in browser: only it can attach a file to a page. Load the `chrome-browser` skill first, and work in a new tab.

1. Open `https://admin.teams.microsoft.com/policies/manage-apps`. On a sign-in page, stop and ask the person to sign in; never type a credential.
2. Search for *Cockpit*, and take the app whose App ID is the package's bot App ID, which the script printed. Match by the ID, not the name: production is *Cockpit* and staging *Cockpit Staging*, and a package built by hand may have named either otherwise.
3. **Stop if the listed version equals the package's**: the manifest changed without its `version` being raised, which Teams needs to tell the packages apart. Say so; never upload over it.
4. Found: open it and use its control for uploading a new version. Not found: use *Upload new app*.
5. Attach the zip with `file_upload` on the page's file input, never by clicking the button, which opens a picker you cannot see. Confirm what the dialog asks only where it names this app and this version.
6. Read the app's details back: its version should now be the package's. Report that, or quote the error the admin center showed.

Then ask the person to check it in Teams, since nothing local can: save a message with *Save to Cockpit*, and see it land in that environment's Inbox.
