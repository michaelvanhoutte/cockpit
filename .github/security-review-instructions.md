# What a security review of this repository looks for

Appended to the `/security-review` run in `.github/workflows/claude-security-review.yml`. It exists as a file rather than as a string inside the workflow because it is prose that will grow, and prose inside a YAML scalar inside a shell quote is three layers of escaping.

CodeQL already runs on every pull request and models injection, taint and workflow misuse. **Do not spend this run re-deriving what CodeQL finds.** What CodeQL cannot model is everything below: rules this project decided on, written down in [docs/architecture.md](../docs/architecture.md), which are invisible to a scanner because breaking them looks like ordinary code.

## The ingress hardening template

Every webhook ingress route follows the template inherited from the task-creator project and recorded in the architecture under "`capture_item` is one command with many front doors". A new or changed route under `/ingress/` that is missing any of these is a finding:

- **A shared secret** in the path or headers, so the endpoint is not merely obscure.
- **Signature verification** against the source's own scheme, done before the payload is parsed or trusted. The architecture puts this on the connector, since it knows its source's scheme — a route that verifies nothing because "the connector will do it" and a connector that verifies nothing because "the route did it" is the failure to look for.
- **An idempotency key** taken from the source's own message identifier, so redelivery does not double-capture. The architecture names `MessageSid` for the SMS channel; every source has an equivalent, and inventing one locally (a hash of the body, a timestamp) is not the same thing.
- **A daily cap**, so a source that goes wrong cannot run up unbounded work.

Report which of the four is missing, not "this webhook is insecure".

## Tokens and secrets

- **Source tokens are encrypted at rest.** OAuth tokens for connected accounts get application-level encryption. A path that writes one to the database in the clear, or reads one and passes it somewhere that persists it, is a finding.
- **No token, access token, refresh token, signing secret or session identifier reaches a log, an error message, a Sentry breadcrumb, or an exception that will be serialized.** Interpolating a whole request or config object into a log line counts, because that is how they leak in practice rather than through a line that names them.
- **Secrets live in the platform's secret store.** This repository is public. A credential appearing in a committed file is a finding even when it looks like an example, and `.env.example` files carry placeholders only.

## Workspace and tenant scoping

- **Every query is scoped server-side** by `tenant_id` and, where the data is workspace-owned, by workspace. The UI's scoping is presentation, not protection, so a read that relies on the client having asked for the right workspace is a finding.
- A new query, a new repository method, or a widened `WHERE` clause that drops either scope is worth reporting even when no current caller can reach it, because the next caller will.

## Authentication and session handling

The architecture chose to hand-roll Google OIDC and its own sessions, and it says explicitly that agent changes to `auth/` get the strictest review. In that area, report anything touching:

- the OAuth `state` and `nonce` — generated, stored, and checked on the way back;
- session cookie flags (`httpOnly`, `Secure`, `SameSite`) and session fixation on login;
- ID token validation: signature, issuer, audience, expiry — all four, not some;
- session expiry and the sliding-refresh path.

Cloudflare Access currently fronts the deployments, and it is a perimeter, not the application's identity model. "Access is in front of it" is not a reason for any of the above to be missing.

## The workflows themselves

This repository's workflows run Claude against an OAuth token and check out pull request branches, which makes them its highest-value target. Report:

- any trigger that gives pull-request-authored code access to repository secrets — `pull_request_target`, `workflow_run`, or a `pull_request` job that has been given secrets some other way;
- `${{ ... }}` interpolation of anything a contributor controls (a title, a branch name, a comment body) into a `run:` block;
- a `permissions:` block granting more than the job needs, particularly `contents: write` or `id-token: write` on a job that handles untrusted input.

## When you could not read the whole diff

A verdict of `NONE` means you looked and found nothing. It must never mean you ran out of room. If the diff is too large to read in full, or a tool you needed was denied, **say so explicitly in your summary comment and give the verdict for what you did read, naming what you did not**. The gate cannot tell a thorough `NONE` from a truncated one — only you can, so a review that quietly covers half a diff and reports nothing is the one failure here that nothing downstream can catch.

## What not to report

- Findings CodeQL already reports. This run is for what it cannot see.
- Missing hardening in the abstract. Every finding names a file, a line, and what an attacker does with it.
- Style, naming, structure, test coverage, or anything a reviewer would raise for quality reasons. `/code-review` runs on the same pull request and owns all of that.
- Anything in `poc/`. It is outside the workspace, does not deploy, and is explicitly proof-of-concept code.

**Finding nothing is a normal and frequent outcome.** Most pull requests here touch neither ingress, nor tokens, nor scoping, nor auth, nor the workflows. A reviewer that always finds something is noise, and noise is how a check stops being read — say you found nothing and say it plainly.
