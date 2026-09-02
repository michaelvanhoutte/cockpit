# WhatsApp Integration Options

## Goal

Integrate WhatsApp into a personal follow-up/inbox system so that
incoming messages can be processed automatically, for example to
identify messages that require a reply or contain an action item.

The preferred solution should:

-   Receive new messages automatically rather than polling.
-   Use an official and reasonably stable integration where possible.
-   Allow the existing WhatsApp phone number to remain usable on the
    phone.
-   Ideally cover normal 1-to-1 conversations and group chats.
-   Feed incoming messages into our own backend for further processing.

## Options Considered

### 1. Personal WhatsApp account

Keep the existing personal WhatsApp account and try to access its
messages through an official API.

**Pros**

-   No change to the current WhatsApp setup.
-   Existing chats, groups, contacts and usage remain untouched.
-   No migration risk.

**Cons**

-   WhatsApp does not provide an official API for accessing messages
    from a normal personal account.
-   No official webhooks for incoming personal messages.
-   Therefore unsuitable for an event-driven integration.

**Conclusion:** Rejected. There is no supported API for the required use
case.

------------------------------------------------------------------------

### 2. Unofficial WhatsApp Web automation

Use an unofficial library or automation layer that connects through
WhatsApp Web and exposes incoming messages programmatically.

Typical solutions emulate or automate the WhatsApp Web client rather
than using Meta's official Business APIs.

**Pros**

-   Potentially gives access to messages from the existing personal
    account.
-   May provide access to both 1-to-1 conversations and normal WhatsApp
    groups.
-   Can potentially preserve the current WhatsApp setup without
    migrating to Business.

**Cons**

-   Not an official or supported WhatsApp integration.
-   Can break when WhatsApp changes its web client or protocol.
-   Creates maintenance and reliability risk.
-   May create account/policy risk depending on how the automation
    works.
-   Poor foundation for a system intended to run reliably over the long
    term.

**Conclusion:** Rejected as the primary solution. It could technically
fill gaps that the official API cannot, especially group messages, but
the reliability and support trade-off is not attractive.

------------------------------------------------------------------------

### 3. WhatsApp Business App only

Convert the existing personal WhatsApp account to the free WhatsApp
Business App.

The existing phone number can be migrated from normal WhatsApp to
WhatsApp Business, while continuing to use WhatsApp from the phone.

**Pros**

-   Official WhatsApp product.
-   WhatsApp Business App itself is free.
-   Existing number can be retained.
-   Existing chats and media can be migrated.
-   Adds Business features such as labels and quick replies.

**Cons**

-   The Business App by itself is not sufficient for our integration.
-   Simply converting a personal account to Business does not
    automatically expose all messages through an API or webhooks.
-   An additional Business Platform / Cloud API integration is needed.

**Conclusion:** Useful as a migration step, but not sufficient on its
own.

------------------------------------------------------------------------

### 4. WhatsApp Business Platform / Cloud API with a separate number

Create a WhatsApp Business Platform integration using Meta's official
Cloud API and use a dedicated WhatsApp Business number.

Incoming messages to that number can be delivered to our backend through
Meta webhooks.

**Pros**

-   Official Meta API.
-   Event-driven incoming messages through webhooks.
-   Stable and intended for programmatic integrations.
-   Supports sending and receiving messages, media and other WhatsApp
    Business functionality.
-   Clean separation between personal WhatsApp and automated/business
    messaging.

**Cons**

-   People would have to message the new Business number for messages to
    reach the integration.
-   Existing conversations on the personal number would not
    automatically move to the new integration.
-   Does not solve the requirement of monitoring messages already
    arriving on the existing personal number.
-   Normal existing WhatsApp group chats are not exposed through the
    API.

**Conclusion:** Technically clean, but rejected because the objective is
to process messages arriving on the existing number.

------------------------------------------------------------------------

### 5. WhatsApp Business App + Cloud API using Coexistence

Migrate the existing personal number to the WhatsApp Business App and
then connect that same number to the WhatsApp Business Platform / Cloud
API using WhatsApp's **Coexistence** capability.

Coexistence is specifically designed to allow the WhatsApp Business App
and the Business Platform to operate on the same phone number.

**Pros**

-   Official Meta solution.
-   Existing phone number can be retained.
-   WhatsApp can continue to be used interactively from the Business App
    on the phone.
-   Incoming supported messages can be delivered to our backend through
    webhooks.
-   Messages sent/received through the Business App can be synchronized
    with the Cloud API setup.
-   Avoids WhatsApp Web scraping or other unofficial automation.
-   Provides the event-driven architecture needed for the personal
    follow-up system.

**Cons**

-   Requires migration from personal WhatsApp to the WhatsApp Business
    App.
-   Coexistence has additional onboarding and eligibility/setup
    requirements compared with simply using the Business App.
-   Cloud API/business messaging rules and potential messaging charges
    apply where relevant.
-   **Normal WhatsApp group chats are not supported by Coexistence.**
-   Existing personal groups therefore cannot be monitored through Cloud
    API webhooks.
-   WhatsApp's separate Groups API does not provide access to arbitrary
    existing personal groups; it is intended for API-created/managed
    business groups.

**Conclusion:** Selected.

## Selected Architecture

We will use:

**Existing personal number → WhatsApp Business App → Coexistence →
WhatsApp Business Platform / Cloud API → Webhooks → Our backend**

Conceptually:

``` text
                         ┌─────────────────────────┐
                         │ WhatsApp Business App   │
                         │ (existing phone/number) │
                         └────────────┬────────────┘
                                      │
                                Coexistence
                                      │
                                      ▼
                         ┌─────────────────────────┐
Incoming 1-to-1 ───────► │ WhatsApp Business      │
messages                 │ Platform / Cloud API    │
                         └────────────┬────────────┘
                                      │ Webhook
                                      ▼
                         ┌─────────────────────────┐
                         │ Our backend             │
                         │                         │
                         │ classify / extract /    │
                         │ create follow-up        │
                         └─────────────────────────┘
```

This keeps the existing phone number and normal phone use, receives supported incoming messages programmatically through official Meta APIs and webhooks, and avoids fragile WhatsApp Web automation.

## Important Limitation: Groups

Coexistence does not expose existing normal group chats through the Cloud API, so *"Michael, can you take care of this tomorrow?"* sent in a family or work group cannot be captured through an official webhook. The official WhatsApp Groups API does not help: it covers groups created through the Business Platform, not general access to existing groups. Accepted rather than introducing an unofficial WhatsApp Web integration.

## Decision Summary

  ----------------------------------------------------------------------------------
  Option          Existing    1-to-1        Existing      Official    Decision
                  number      webhooks      groups                    
  --------------- ----------- ------------- ------------- ----------- --------------
  Personal        Yes         No            No API        Yes         Reject
  WhatsApp                                                            

  WhatsApp Web    Yes         Potentially   Potentially   No          Reject
  automation                                                          

  Business App    Yes         Not           App only      Yes         Migration step
  only                        sufficient                              

  Cloud API +     No          Yes           No            Yes         Reject
  separate number                                                     

  **Business      **Yes**     **Yes**       **No**        **Yes**     **Selected**
  App +                                                               
  Coexistence +                                                       
  Cloud API**                                                         
  ----------------------------------------------------------------------------------

The next implementation step is to validate Coexistence eligibility and onboarding for the account, then configure the Cloud API webhook endpoint.
