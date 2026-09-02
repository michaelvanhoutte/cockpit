# Microsoft Teams Integration Options

## Goal

Collect Microsoft Teams items that may require a user's attention, primarily:

- unread direct messages;
- messages that @mention the user in relevant channels;
- messages the user explicitly saved for later, if accessible.

## Options considered

### 1. Saved messages

Teams has a **Save this message** feature and a **Saved** view in the Teams client.

**Pros**
- Closest semantic match to an explicit "follow up later" action.
- Very high signal: the user deliberately selected the message.

**Cons**
- We found no supported Microsoft Graph API that exposes the user's Saved list or the saved state of a `chatMessage`.
- Therefore this cannot currently be used as the basis of the integration.

**Decision:** Not usable through the supported Teams/Graph API at this time.

### 2. Poll chats and channels through Microsoft Graph

Periodically retrieve chat/channel messages and determine which ones are relevant.

**Pros**
- Straightforward conceptually.
- Graph exposes chat messages and structured `mentions`, so @mentions can be detected reliably.
- Can be used to reconstruct state after downtime or as an initial synchronization mechanism.

**Cons**
- Polling every chat/channel is inefficient.
- Requires keeping cursors/state to avoid repeatedly processing the same messages.
- Channel polling becomes unattractive as the number of teams/channels grows.

**Decision:** Do not use polling as the primary mechanism. Keep it only for initial sync/reconciliation if required.

### 3. Microsoft Graph change notifications per chat/channel

Create webhook subscriptions for individual chats and channels. Graph sends notifications when messages are created or changed.

**Pros**
- Event-driven; no continuous message polling.
- Channel subscriptions support delegated permissions (`ChannelMessage.Read.All`).
- Chat subscriptions support delegated `Chat.Read`.
- Notifications can include resource data, avoiding an additional Graph request for every event.
- `chatMessage.mentions` allows deterministic detection of an actual @mention instead of searching message text.

**Cons**
- Requires managing subscriptions and renewing them.
- A subscription is still scoped to the selected chat/channel; there is no general "notify me whenever I am mentioned anywhere" subscription.
- Managing subscriptions individually becomes cumbersome if many channels must be monitored.

**Decision:** Good option for a small, explicitly selected set of channels, but not ideal as the general mechanism for all user chats.

### 4. User-level chat message change notifications

Subscribe to:

`/users/{user-id}/chats/getAllMessages`

This generates message change notifications for **all chats in which that user participates**.

**Pros**
- One logical subscription covers the user's 1:1 and group chats.
- Event-driven: no need to poll every DM conversation.
- Supports delegated `Chat.Read` / `Chat.ReadWrite` as well as application permissions.
- Notifications can include the message resource data.
- Well suited to a personal integration because the scope is a particular user's chats rather than every chat in the tenant.

**Cons**
- The endpoint is broader than "unread DMs": the integration receives chat-message changes and must filter them.
- Read/unread state is user-specific and may require additional state/API handling; it is not simply an `isRead` flag on every message.
- Microsoft documents licensing/payment considerations for some Teams message APIs/change-notification models, so this must be validated before production deployment.
- Subscriptions must be maintained/renewed.

**Decision:** Preferred mechanism for DMs/chat messages.

### 5. Tenant-wide message subscriptions

Subscribe to:

- `/chats/getAllMessages`
- `/teams/getAllMessages`

**Pros**
- Captures everything centrally.
- Simplest architecture if building an organization-wide compliance/archive product.

**Cons**
- Requires powerful application permissions such as `Chat.Read.All` or `ChannelMessage.Read.All`.
- Delegated permissions are not supported for these tenant-wide subscriptions.
- Processes messages belonging to users who have nothing to do with the personal integration.
- Has additional licensing/payment implications.
- Excessive scope for a personal follow-up assistant.

**Decision:** Reject for our use case.

## Selected approach

**Graph change notifications, event-driven and user-scoped**, rather than polling the Teams environment.

- **DMs and chats:** one user-level subscription to `/users/{user-id}/chats/getAllMessages`, filtering the incoming messages for the ones still needing attention.
- **Channel @mentions:** a subscription per monitored channel (`/teams/{team-id}/channels/{channel-id}/messages`), keeping a message only when its structured `mentions` collection names the current user. Every message in the selected channel arrives, but its history is never re-polled.
- **Saved messages:** not integrated, there being no supported Graph API for the user's Saved list.
- **Tenant-wide subscriptions:** deliberately avoided, their permission and data scope being unnecessarily broad for a personal integration.

The main thing to validate before implementation is Microsoft's licensing and tenant-consent impact for the user-level subscription model.

## Resulting architecture

```text
Microsoft Teams
      |
      +-- User chat subscription
      |     /users/{user-id}/chats/getAllMessages
      |              |
      |              v
      |           Webhook
      |              |
      |              v
      |       DM / chat filtering
      |
      +-- Selected channel subscriptions
            /teams/{team-id}/channels/{channel-id}/messages
                     |
                     v
                  Webhook
                     |
                     v
             mentions contains user?
                     |
                     v
               Follow-up inbox
```

## References

- Microsoft Graph — Change notifications for Teams resources: https://learn.microsoft.com/en-us/graph/teams-change-notification-in-microsoft-teams-overview
- Microsoft Graph — Change notifications for Teams chat messages: https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage
- Microsoft Graph — Teams API licensing/payment models: https://learn.microsoft.com/en-us/graph/teams-licenses
- Microsoft Support — Save a chat or channel message: https://support.microsoft.com/en-us/teams/chat/save-a-chat-or-channel-message-in-microsoft-teams
