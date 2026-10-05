import { GMAIL, TEAMS, type PanelFilter, type Priority, type WorkspaceTint } from '@cockpit/shared';

/**
 * What the shared guest account holds when a visitor opens it: a contractor's
 * week, written out once ("Seed the guest account with a full demo dataset",
 * issue 355). `guestDemoSeed` in changes.ts turns this into the statements that
 * put it there, and nothing else reads it.
 *
 * **Data, not schema, which is why it is a structure rather than SQL.**
 * changes.ts writes its DDL out statement by statement for a reason its own
 * header gives - there is no migration tool to generate it against - and that
 * reason says nothing about three hundred rows of demonstration content. What a
 * reviewer has to check here is whether the *content* tells the right story, so
 * the content is the thing on the page and the SQL is derived from it.
 *
 * **Dates are days from the day it is written, not dates.** A Filter showing
 * what is due this week only demonstrates anything if something is, and the
 * guest account is written again every night (`resetGuest`, store.ts), so an
 * offset keeps the story the same on every day it is opened: the overdue Item
 * is two days overdue and the one due today is due today.
 *
 * **Uneven on purpose.** Somebody's real Panels run from one Item to more than
 * they can see at once, most Items have no due date and no priority, and the
 * Inbox is never empty - a demonstration that is tidy looks invented.
 *
 * **Invented people and companies, on purpose.** Nothing here is Cockpit's own
 * development content or anybody's real customer, so nothing a visitor reads
 * can be mistaken for leaked data.
 *
 * **Edited in place.** The guest account is dropped and rebuilt from this file
 * every night, so an edit reaches it at the next reset (or `pnpm guest:reset`),
 * and every other account applies this change with no statements at all.
 */

/** One Item. `title` is all that is required; the rest is what makes a row worth looking at. */
export interface SeedItem {
  readonly title: string;
  readonly description?: string;
  /** A Note rather than a Task - the account's two standard types, and nothing else is created. */
  readonly note?: true;
  readonly priority?: Priority;
  /** Days after the day it is written that it is due: `0` is today, `-2` two days overdue. */
  readonly due?: number;
  /** Days before the day it is written that it was started, which makes it In progress. */
  readonly started?: number;
  /** Person associations on this Item. */
  readonly people?: readonly string[];
  /** Topic associations on this Item. */
  readonly topics?: readonly string[];
  /**
   * That this Item came in from Gmail or Teams, and from whom ("Seed Gmail and
   * Teams in the guest demo", issue 773): the row then reads "Gmail · Els
   * Maes", and its *Open ↗* is the reserved demo address of that source
   * (`demoAddress`, `@cockpit/shared`), which the app opens as its own page.
   */
  readonly via?: { readonly source: 'gmail' | 'teams'; readonly sender: string };
}

/**
 * The connections every demo Workspace shows as connected, under Settings ›
 * Connections ("Seed Gmail and Teams in the guest demo", issue 773).
 *
 * **Rows nothing outside Cockpit ever reads.** The credential is a placeholder
 * that opens nothing, and every path that would use a connection skips the
 * guest account by identity (`holdsGmailConnection`, accounts/gmail.ts), so
 * neither is checked against Google or Microsoft and neither can show as
 * failing. A seeded row is also never a way to connect for real: the guest's
 * connection changes are refused at the route (auth/guest-connections.ts).
 */
export const GUEST_DEMO_CONNECTIONS: readonly {
  readonly connectorId: typeof GMAIL | typeof TEAMS;
  readonly externalAccountKey: string;
  readonly displayName: string;
}[] = [
  { connectorId: GMAIL, externalAccountKey: 'alex@contractor.example', displayName: 'alex@contractor.example' },
  { connectorId: TEAMS, externalAccountKey: 'demo-tenant/alex', displayName: 'Alex Contractor' },
];

/** The credential every demo connection carries: not sealed, and not a secret, so nothing can open it. */
export const GUEST_DEMO_PLACEHOLDER_CREDENTIAL = 'demo-placeholder-not-a-credential';

/** An Item still in its Workspace's Inbox, filed on no Panel. */
export interface SeedInboxItem extends SeedItem {
  /** The Panel of this Workspace Cockpit suggests filing it on, and why - the row's one-click chip. */
  readonly suggest?: { readonly panel: string; readonly why: string };
  /** Not yet put in a Workspace, so it shows in every Workspace's Inbox. */
  readonly anyWorkspace?: true;
}

/** A Panel of the Items filed onto it. */
export interface SeedItemsPanel {
  readonly name: string;
  readonly items: readonly SeedItem[];
}

/** A Filter: a Panel showing every filed Item of its Workspace that meets its conditions. */
export interface SeedFilterPanel {
  readonly name: string;
  readonly filter: PanelFilter;
}

export type SeedPanel = SeedItemsPanel | SeedFilterPanel;

/**
 * One row of a Dashboard's layout. The Panels of a row divide it in proportion
 * to their spans, so the generator gives each an equal share of the grid rather
 * than this file carrying numbers that must add up.
 *
 * **No height, which is a decision rather than an omission.** Every seeded row
 * is as tall as what is in it, so a Panel shows every Item it holds on
 * whatever screen the demonstration is opened on; a fixed height cropped the
 * last row of each Panel at 1280px, and a number that has to be retuned per
 * screen is the opposite of what a demonstration wants.
 */
export interface SeedRow {
  readonly panels: readonly SeedPanel[];
}

export interface SeedDashboard {
  readonly name: string;
  /** A Project association written onto every Item of this Dashboard, where it has one. */
  readonly project?: string;
  readonly rows: readonly SeedRow[];
}

export interface SeedWorkspace {
  readonly name: string;
  /**
   * The tint of one of the palette's themes; the other three surfaces are read
   * off it (`themeOf`). Typed as the palette rather than as a string, because
   * `themeOf` answers a tint it does not know with the default theme - so a
   * mistyped hex here would paint a demonstration Workspace like a brand-new
   * one, with nothing anywhere failing.
   */
  readonly tint: WorkspaceTint;
  readonly inbox: readonly SeedInboxItem[];
  readonly dashboards: readonly SeedDashboard[];
}

export function isFilter(panel: SeedPanel): panel is SeedFilterPanel {
  return 'filter' in panel;
}

/**
 * Three Workspaces: the contractor's own life, the customer they are with on
 * Monday to Wednesday, and the customer they are CTO for on Thursday and
 * Friday. Which is the shape the multi-workspace boundary exists for, said in
 * content rather than in a caption.
 */
export const GUEST_DEMO: readonly SeedWorkspace[] = [
  {
    name: 'Personal',
    tint: '#3a72c8',
    inbox: [
      {
        title: "Mum's birthday on the 24th - present?",
        suggest: { panel: 'Errands', why: 'Something to buy, like the other errands.' },
      },
      {
        title: 'Look into a cheaper energy tariff',
        via: { source: 'gmail', sender: 'Voltra Energy' },
        suggest: { panel: 'Admin & money', why: 'A bill to compare, like the insurance quote.' },
      },
      { title: 'Weekend in the Ardennes in October?', note: true },
      {
        title: 'Call the accountant back about the invoice numbering',
        description: 'Could be the business or the personal account - not decided which.',
        anyWorkspace: true,
      },
    ],
    dashboards: [
      {
        name: 'Day to day',
        rows: [
          {
            panels: [
              {
                name: 'Due this week',
                filter: { match: 'all', conditions: [{ field: 'dueDate', window: 'week', orOverdue: true }] },
              },
              {
                name: 'Errands',
                items: [
                  { title: 'Book the car in for its service', due: 3, priority: 'normal' },
                  { title: 'Renew the gym membership before it lapses', due: 0, priority: 'low' },
                  {
                    title: 'Reply to Mum about the weekend',
                    via: { source: 'gmail', sender: 'Mum' },
                  },
                  {
                    title: 'Pick up the parcel from the collection point',
                    description: 'Closes at six, and they only hold it for a week.',
                    due: -1,
                    via: { source: 'gmail', sender: 'ParcelPoint' },
                  },
                  { title: 'Ask the dentist about a night guard', note: true },
                ],
              },
              {
                name: 'Admin & money',
                items: [
                  {
                    title: 'Move the savings across to the higher-rate account',
                    description: 'The introductory rate on the current one has ended.',
                    due: 9,
                    priority: 'high',
                  },
                  { title: 'File the quarterly VAT return', due: 2, priority: 'high', started: 1 },
                  {
                    title: 'Insurance renewal quote came in - worth comparing',
                    note: true,
                    via: { source: 'gmail', sender: 'Ardent Insurance' },
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        name: 'Volleyball club',
        rows: [
          {
            panels: [
              {
                name: 'Committee',
                items: [
                  {
                    title: 'Send Fien the sponsorship invoices',
                    due: 4,
                    priority: 'normal',
                    people: ['Fien Coppens'],
                  },
                  { title: 'Draw up the agenda for the committee meeting', people: ['Bram Willems'] },
                  {
                    title: 'Ask Bram to sign off the referee expenses',
                    people: ['Bram Willems'],
                    via: { source: 'teams', sender: 'Bram Willems' },
                  },
                  { title: 'Minutes from the June meeting are still unpublished', note: true },
                  {
                    title: "Renew the club's insurance with the federation",
                    due: 13,
                    priority: 'high',
                    people: ['Fien Coppens'],
                  },
                ],
              },
              {
                name: 'Season prep',
                items: [
                  { title: 'Order new match balls for the first team', due: 11, priority: 'normal' },
                  { title: 'Book the sports hall for the Christmas tournament', due: 24 },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'Halcyon Health',
    tint: '#c06a45',
    inbox: [
      {
        title: "Sara: can we move Thursday's sync to Friday?",
        people: ['Sara Okafor'],
        via: { source: 'teams', sender: 'Sara Okafor' },
        suggest: { panel: 'Today', why: 'A question from Sara about this week.' },
      },
      {
        title: 'Clinic in Ghent reports slow logins since Monday',
        priority: 'high',
        via: { source: 'gmail', sender: 'Els Maes' },
        suggest: { panel: 'API & service cutover', why: 'Logins go through the new booking service.' },
      },
      {
        title: 'Security questionnaire arrived from the imaging supplier',
        via: { source: 'gmail', sender: 'Lumen Imaging' },
        suggest: { panel: 'Vendor & third-party review', why: 'Another supplier answering for the audit.' },
      },
      { title: 'Check whether the pen test window clashes with the release freeze' },
      { title: "Tom's notes from the clinic visit", note: true, people: ['Tom Delrue'] },
      {
        title: 'Renew the parking permit for the Antwerp office',
        suggest: { panel: 'Admin & expenses', why: 'Office admin, like the building badge.' },
      },
    ],
    dashboards: [
      {
        name: 'Day to day',
        rows: [
          {
            panels: [
              {
                name: 'To answer',
                items: [
                  {
                    title: 'Reply to Els about the slow logins in Ghent',
                    priority: 'high',
                    via: { source: 'gmail', sender: 'Els Maes' },
                  },
                  {
                    title: 'Sara needs a yes or no on Friday for the sync',
                    people: ['Sara Okafor'],
                    via: { source: 'teams', sender: 'Sara Okafor' },
                  },
                  {
                    title: 'Send the imaging supplier our answers',
                    via: { source: 'gmail', sender: 'Lumen Imaging' },
                  },
                ],
              },
              {
                name: 'Today',
                items: [
                  {
                    title: 'Review the pull request for the appointments service',
                    due: 0,
                    priority: 'normal',
                    people: ['Sara Okafor'],
                    started: 0,
                  },
                  { title: 'Write up the incident notes from Tuesday', topics: ['Security'] },
                  { title: 'Pair with Sara on the scheduling bug', people: ['Sara Okafor'] },
                  { title: 'Answer the clinic leads about the new booking hours', due: 0 },
                ],
              },
              {
                name: 'Waiting on others',
                items: [
                  { title: 'Tom to confirm the wording on the consent screen', people: ['Tom Delrue'] },
                  {
                    title: 'Access to the staging logs still has not come through',
                    priority: 'high',
                    topics: ['Security'],
                  },
                ],
              },
            ],
          },
          {
            panels: [
              {
                name: 'Halcyon team',
                items: [
                  { title: 'Onboarding notes for the new backend developer', note: true },
                  { title: 'Book the Q4 planning session with Sara', due: 8, people: ['Sara Okafor'] },
                  {
                    title: 'Handover doc for the days I am not in',
                    description: 'Three days a week here means somebody else has to be able to pick it up.',
                    note: true,
                  },
                ],
              },
              {
                name: 'Admin & expenses',
                items: [{ title: 'Submit last month\'s timesheet', due: -2, priority: 'high' }],
              },
            ],
          },
        ],
      },
      {
        name: 'Platform migration',
        project: 'Platform migration',
        rows: [
          {
            panels: [
              {
                name: "This week's priorities",
                filter: {
                  match: 'all',
                  conditions: [
                    { field: 'dueDate', window: 'week', orOverdue: true },
                    { field: 'priority', values: ['high'] },
                  ],
                },
              },
              {
                name: 'Infrastructure & cloud',
                items: [
                  { title: 'Write the Terraform module for the new network' },
                  { title: 'Decide which region the EU workloads run in', due: 1, priority: 'normal' },
                  { title: 'Set up the private link to the on-premise network', due: 15 },
                  { title: 'Cost estimate for the month of running both', note: true },
                ],
              },
              {
                name: 'Data migration',
                items: [
                  {
                    title: 'Map the legacy patient identifiers onto the new schema',
                    description:
                      'Blocking the first dry run - nothing else in this panel can move until the mapping is agreed.',
                    due: -3,
                    priority: 'high',
                    people: ['Sara Okafor'],
                    started: 6,
                  },
                  { title: "Dry-run the bulk export against last month's snapshot", due: 4, priority: 'normal' },
                  { title: 'Decide what happens to records with no consent flag' },
                  {
                    title: 'Sign-off from the data protection officer on the mapping',
                    due: 11,
                    via: { source: 'gmail', sender: 'Hanne Claes' },
                  },
                  { title: 'Row counts differ by 412 between the two systems', note: true },
                ],
              },
              {
                name: 'API & service cutover',
                items: [
                  { title: 'Version the appointments endpoint before the switch' },
                  { title: 'Feature flag for routing traffic to the new service', due: 6 },
                  { title: 'Retire the old bridge once nothing calls it', priority: 'low' },
                  { title: 'Contract tests against the new booking API', people: ['Tom Delrue'] },
                  { title: 'Rollback plan for the first cutover window', due: 0, priority: 'high' },
                ],
              },
            ],
          },
          {
            panels: [
              {
                name: 'Testing & QA',
                items: [
                  { title: 'Regression pack for the referral journey', priority: 'normal' },
                  { title: 'Load test at three times the Monday-morning peak', due: 2, priority: 'normal' },
                  {
                    title: 'Sign-off checklist with the Halcyon test lead',
                    people: ['Tom Delrue'],
                    via: { source: 'teams', sender: 'Tom Delrue' },
                  },
                  {
                    title: 'Penetration test booked for the week before go-live',
                    due: 19,
                    priority: 'high',
                    topics: ['Security'],
                  },
                  { title: 'Defects from the first round of user testing are triaged', note: true },
                ],
              },
              {
                name: 'Rollout & communications',
                items: [
                  {
                    title: 'Cutover runbook, hour by hour',
                    description: 'Who does what, in what order, and who says stop.',
                    due: 12,
                    priority: 'high',
                  },
                  {
                    title: 'Tell the clinics two weeks before the switch',
                    due: -1,
                    priority: 'normal',
                    via: { source: 'gmail', sender: 'Els Maes' },
                  },
                  { title: 'Draft the status-page notice for the window' },
                  { title: 'Train the front-desk staff on the new screens', people: ['Tom Delrue'] },
                  { title: 'Standby rota for the weekend of the cutover', people: ['Sara Okafor'] },
                ],
              },
            ],
          },
        ],
      },
      {
        name: 'ISO 27001 certification',
        project: 'ISO 27001 certification',
        rows: [
          {
            panels: [
              {
                name: 'In progress',
                filter: { match: 'all', conditions: [{ field: 'status' }] },
              },
              {
                name: 'Risk assessment',
                items: [
                  {
                    title: 'Finish the risk register for the clinical systems',
                    description: 'Ines needs it before she can start the readiness review.',
                    due: 1,
                    priority: 'high',
                    people: ['Ines Verbeek'],
                    started: 5,
                    via: { source: 'teams', sender: 'Ines Verbeek' },
                  },
                  { title: 'Agree the risk appetite statement with the board', due: 18 },
                  { title: 'Threat model for the patient portal', topics: ['Security'] },
                  { title: 'The impact analysis is still missing two departments', note: true },
                ],
              },
              {
                name: 'Policies & documentation',
                items: [
                  {
                    title: 'Statement of applicability against every control',
                    due: 7,
                    priority: 'high',
                    started: 4,
                  },
                  { title: 'Incident response plan still to be signed', due: 21 },
                ],
              },
              {
                name: 'Access control & security',
                items: [
                  {
                    title: 'Quarterly access review for the production systems',
                    due: 3,
                    priority: 'normal',
                    topics: ['Security'],
                  },
                  { title: 'Enforce hardware keys on the administrator accounts', priority: 'normal', topics: ['Security'] },
                  { title: 'Remove the shared service account from the database', priority: 'high' },
                  { title: 'Turn off the VPN accounts of last year\'s contractors', due: -4 },
                  { title: 'Encryption at rest confirmed for every store', note: true, topics: ['Security'] },
                ],
              },
            ],
          },
          {
            panels: [
              {
                name: 'Internal audit',
                items: [
                  {
                    title: 'Book the internal audit for next month',
                    due: 10,
                    via: { source: 'gmail', sender: 'Vantage Audit' },
                  },
                  { title: 'Audit programme covering every control area', people: ['Ines Verbeek'] },
                  { title: 'Evidence pack for the change-management control', due: 5, priority: 'normal' },
                  { title: 'Non-conformities from the readiness review', note: true, people: ['Ines Verbeek'] },
                  { title: 'Track the corrective actions through to closure' },
                ],
              },
              {
                name: 'Vendor & third-party review',
                items: [
                  { title: 'Collect a data-processing agreement from every processor', priority: 'high' },
                  { title: 'Publish the sub-processor list on the website', priority: 'low' },
                  { title: 'Exit plan for the legacy analytics vendor', note: true },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'Oakline Retail',
    tint: '#3f8f78',
    inbox: [
      {
        title: 'Priya: the till update failed in two stores overnight',
        priority: 'high',
        people: ['Priya Shah'],
        via: { source: 'teams', sender: 'Priya Shah' },
        suggest: { panel: 'This week', why: 'A store problem to deal with this week.' },
      },
      {
        title: 'Recruiter sent three CVs for the data engineer role',
        topics: ['Hiring'],
        via: { source: 'gmail', sender: 'Jolien at TalentBridge' },
        suggest: { panel: 'Leadership', why: 'Hiring sits with the other Leadership work.' },
      },
      { title: 'Read the analyst note on composable commerce', note: true },
      {
        title: 'Liam wants a view on the loyalty vendor shortlist',
        due: 2,
        people: ['Liam Novak'],
        via: { source: 'gmail', sender: 'Liam Novak' },
        suggest: { panel: 'This week', why: 'Due in two days, and it is the loyalty decision.' },
      },
    ],
    dashboards: [
      {
        name: 'Day to day',
        rows: [
          {
            panels: [
              {
                name: 'Today',
                filter: { match: 'all', conditions: [{ field: 'dueDate', window: 'today', orOverdue: true }] },
              },
              {
                name: 'This week',
                items: [
                  {
                    title: 'Sign off the Black Friday capacity plan',
                    description: 'Last year the tills queued for eleven minutes at the peak.',
                    due: 0,
                    priority: 'high',
                    started: 1,
                  },
                  { title: 'Review the warehouse integration spike', priority: 'normal' },
                  {
                    title: 'Walk the new checkout flow with Priya',
                    due: 1,
                    people: ['Priya Shah'],
                    via: { source: 'teams', sender: 'Priya Shah' },
                  },
                  { title: 'Decide build or buy for the loyalty scheme', due: 4, priority: 'high' },
                  { title: 'Store managers are asking for offline mode on the tills', note: true, people: ['Priya Shah'] },
                ],
              },
              {
                name: 'Leadership',
                items: [
                  {
                    title: "Next year's technology budget over to Liam",
                    due: -1,
                    priority: 'high',
                    people: ['Liam Novak'],
                    via: { source: 'gmail', sender: 'Liam Novak' },
                  },
                  { title: 'Second interviews for the data engineer role', priority: 'normal', topics: ['Hiring'] },
                  { title: 'Architecture slide for the quarterly board pack', due: 16, people: ['Liam Novak'] },
                  { title: 'The ops handover ritual with Priya is not working', note: true, people: ['Priya Shah'] },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];
