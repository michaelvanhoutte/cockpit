import type { Priority } from '@cockpit/shared';

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
 * **Fixed, not generated.** Every name, date and priority below is written
 * down, so the demonstration reads the same in January as in September and a
 * screenshot of it stays true. The cost is that the dates age: the Item written
 * as overdue stays overdue, and the one written as due next week joins it as
 * the weeks pass. That is the trade the issue asks for - determinism over
 * freshness - and a reference date that moves with the seeding is what would
 * replace it if the aging ever matters more than the fixed story does.
 *
 * **Invented people and companies, on purpose.** Nothing here is Cockpit's own
 * development content or anybody's real customer, so nothing a visitor reads
 * can be mistaken for leaked data.
 */

/** The instant everything seeded here was made at, and the date the due dates are written around. */
export const SEEDED_AT = '2026-09-10T00:00:00.000Z';

/** One Item on one Panel. `title` is all that is required; the rest is what makes a row worth looking at. */
export interface SeedItem {
  readonly title: string;
  readonly description?: string;
  /** A Note rather than a Task - the account's two standard types, and nothing else is created. */
  readonly note?: true;
  readonly priority?: Priority;
  /** `YYYY-MM-DD`, read against `SEEDED_AT` above. */
  readonly due?: string;
  /** Person associations on this Item. */
  readonly people?: readonly string[];
  /** Topic associations on this Item. */
  readonly topics?: readonly string[];
}

export interface SeedPanel {
  readonly name: string;
  readonly items: readonly SeedItem[];
}

/**
 * One row of a Dashboard's layout. The Panels of a row divide it in proportion
 * to their spans, so the generator gives each an equal share of the grid rather
 * than this file carrying numbers that must add up.
 *
 * **No height, which is a decision rather than an omission.** Every seeded row
 * is as tall as what is in it, so a Panel of six Items shows all six on
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
  /** The tint of one of the palette's themes; the other three surfaces are read off it (`themeOf`). */
  readonly tint: string;
  readonly dashboards: readonly SeedDashboard[];
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
    dashboards: [
      {
        name: 'Day to day',
        rows: [
          {
            panels: [
              {
                name: 'This week',
                items: [
                  { title: 'Book the car in for its service', due: '2026-09-18', priority: 'normal' },
                  { title: 'Renew the gym membership before it lapses', due: '2026-09-15', priority: 'low' },
                  { title: 'Reply to Mum about the weekend' },
                  {
                    title: 'Pick up the parcel from the collection point',
                    description: 'Closes at six, and they only hold it for a week.',
                    due: '2026-09-12',
                    priority: 'normal',
                  },
                  { title: 'Ask the dentist about a night guard', note: true },
                  { title: 'Replace the coffee grinder', note: true, priority: 'low' },
                ],
              },
              {
                name: 'Admin & money',
                items: [
                  {
                    title: 'Move the savings across to the higher-rate account',
                    description: 'The introductory rate on the current one ended in August.',
                    due: '2026-09-20',
                    priority: 'high',
                  },
                  { title: "Check last month's card statement for the duplicate charge", priority: 'normal' },
                  { title: 'File the quarterly VAT return', due: '2026-09-30', priority: 'high' },
                  { title: 'Cancel the streaming trial before it renews', due: '2026-09-14', priority: 'normal' },
                  { title: 'Insurance renewal quote came in - worth comparing', note: true },
                  { title: 'Set up the standing order for the club fees', priority: 'low' },
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
                    title: 'Send Fien the sponsorship invoices for August',
                    due: '2026-09-16',
                    priority: 'normal',
                    people: ['Fien Coppens'],
                  },
                  {
                    title: 'Draw up the agenda for the September committee meeting',
                    due: '2026-09-15',
                    people: ['Bram Willems'],
                  },
                  { title: 'Ask Bram to sign off the referee expenses', people: ['Bram Willems'] },
                  { title: 'Minutes from the June meeting are still unpublished', note: true, priority: 'low' },
                  {
                    title: "Renew the club's insurance with the federation",
                    due: '2026-09-25',
                    priority: 'high',
                    people: ['Fien Coppens'],
                  },
                ],
              },
              {
                name: 'Season prep',
                items: [
                  { title: 'Order new match balls for the first team', due: '2026-09-19', priority: 'normal' },
                  { title: 'Book the sports hall for the Christmas tournament', due: '2026-10-01' },
                  { title: 'Chase the printers about the new shirts', priority: 'normal', people: ['Fien Coppens'] },
                  { title: 'Draw up the junior training rota', priority: 'low' },
                  { title: 'Photos from the season opener still to go on the site', note: true },
                  { title: 'Ask the canteen volunteers for their availability' },
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
    dashboards: [
      {
        name: 'Day to day',
        rows: [
          {
            panels: [
              {
                name: 'Today',
                items: [
                  {
                    title: 'Review the pull request for the appointments service',
                    due: '2026-09-12',
                    priority: 'normal',
                    people: ['Sara Okafor'],
                  },
                  { title: 'Write up the incident notes from Tuesday', priority: 'normal', topics: ['Security'] },
                  { title: 'Pair with Sara on the scheduling bug', people: ['Sara Okafor'] },
                  { title: 'Sketch the API for the referral flow', note: true, people: ['Tom Delrue'] },
                ],
              },
              {
                name: 'Waiting on others',
                items: [
                  { title: 'Tom to confirm the wording on the consent screen', people: ['Tom Delrue'] },
                  {
                    title: "Sara's answer on how long we keep the audit trail",
                    people: ['Sara Okafor'],
                    topics: ['Security'],
                  },
                  { title: 'Access to the staging logs still has not come through', priority: 'high', topics: ['Security'] },
                  { title: 'Legal review of the data-processing addendum', due: '2026-09-24' },
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
                  {
                    title: 'Book the Q4 planning session with Sara',
                    due: '2026-09-22',
                    priority: 'normal',
                    people: ['Sara Okafor'],
                  },
                  {
                    title: 'Handover doc for the weeks that are Wednesday only',
                    description: 'Three days a week here means somebody else has to be able to pick it up.',
                    note: true,
                    priority: 'low',
                  },
                  { title: 'Retro actions from August are still open', priority: 'low' },
                ],
              },
              {
                name: 'Admin & expenses',
                items: [
                  { title: 'Submit the August timesheet', due: '2026-09-12', priority: 'high' },
                  { title: 'Expenses: train tickets to the Antwerp office', priority: 'normal' },
                  { title: 'Renew the building badge', due: '2026-10-05', priority: 'low' },
                  { title: 'Signed contract extension back to Halcyon procurement', due: '2026-09-26' },
                ],
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
                name: 'Infrastructure & cloud',
                items: [
                  { title: 'Write the Terraform module for the new network', priority: 'normal' },
                  { title: 'Size the managed database instance', priority: 'normal' },
                  { title: 'Decide which region the EU workloads run in', due: '2026-09-23', priority: 'high' },
                  { title: 'Set up the private link to the on-premise network', due: '2026-10-02' },
                  { title: 'Cost estimate for the month of running both', note: true },
                  { title: 'Rotate the deployment credentials after the cutover', priority: 'low', topics: ['Security'] },
                ],
              },
              {
                name: 'Data migration',
                items: [
                  {
                    title: 'Map the legacy patient identifiers onto the new schema',
                    description:
                      'Blocking the first dry run - nothing else in this panel can move until the mapping is agreed.',
                    due: '2026-09-05',
                    priority: 'high',
                    people: ['Sara Okafor'],
                  },
                  { title: "Dry-run the bulk export against last month's snapshot", due: '2026-09-18', priority: 'normal' },
                  { title: 'Decide what happens to records with no consent flag', priority: 'high' },
                  { title: 'Write the reconciliation report for finance', priority: 'low' },
                  { title: 'Archive the pre-migration backups off-site', due: '2026-10-10' },
                  { title: 'Row counts differ by 412 between the two systems', note: true, priority: 'high' },
                ],
              },
              {
                name: 'API & service cutover',
                items: [
                  { title: 'Version the appointments endpoint before the switch', priority: 'normal' },
                  { title: 'Feature flag for routing traffic to the new service', due: '2026-09-20' },
                  { title: 'Retire the old bridge once nothing calls it', priority: 'low' },
                  { title: 'Contract tests against the new booking API', priority: 'normal', people: ['Tom Delrue'] },
                  { title: 'Rollback plan for the first cutover window', due: '2026-09-21', priority: 'high' },
                  { title: 'The old service still writes audit rows of its own', note: true },
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
                  { title: 'Load test at three times the Monday-morning peak', due: '2026-09-19' },
                  { title: 'Sign-off checklist with the Halcyon test lead', people: ['Tom Delrue'] },
                  { title: 'Accessibility pass on the new booking screens', priority: 'low' },
                  {
                    title: 'Penetration test booked for the week before go-live',
                    due: '2026-09-29',
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
                    due: '2026-09-27',
                    priority: 'high',
                  },
                  { title: 'Tell the clinics two weeks before the switch', due: '2026-09-17' },
                  { title: 'Draft the status-page notice for the window', priority: 'normal' },
                  { title: 'Train the front-desk staff on the new screens', people: ['Tom Delrue'] },
                  { title: 'Standby rota for the weekend of the cutover', priority: 'normal', people: ['Sara Okafor'] },
                  { title: 'Post-migration review pencilled in for October', note: true, priority: 'low' },
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
                name: 'Risk assessment',
                items: [
                  {
                    title: 'Finish the risk register for the clinical systems',
                    description: 'Ines needs it before she can start the readiness review.',
                    due: '2026-09-12',
                    priority: 'high',
                    people: ['Ines Verbeek'],
                  },
                  { title: 'Score the likelihood of the supplier-outage scenario', priority: 'normal' },
                  { title: 'Agree the risk appetite statement with the board', due: '2026-09-30' },
                  { title: 'Threat model for the patient portal', priority: 'normal', topics: ['Security'] },
                  { title: 'The impact analysis is still missing two departments', note: true, priority: 'low' },
                  { title: 'Treatment plan for the risks we are accepting', due: '2026-10-08' },
                ],
              },
              {
                name: 'Policies & documentation',
                items: [
                  { title: 'Information security policy out for review', priority: 'normal', people: ['Ines Verbeek'] },
                  { title: 'Acceptable use policy needs a plain-language rewrite', priority: 'low' },
                  { title: 'Statement of applicability against every control', due: '2026-09-26', priority: 'high' },
                  { title: 'Put the policy set under version control properly' },
                  { title: 'Incident response plan still to be signed', due: '2026-10-03' },
                  { title: 'Records retention schedule agreed with legal', note: true },
                ],
              },
              {
                name: 'Access control & security',
                items: [
                  {
                    title: 'Quarterly access review for the production systems',
                    due: '2026-09-25',
                    priority: 'high',
                    topics: ['Security'],
                  },
                  { title: 'Enforce hardware keys on the administrator accounts', priority: 'normal', topics: ['Security'] },
                  { title: 'Remove the shared service account from the database', priority: 'high' },
                  { title: 'Write down the joiners, movers and leavers process' },
                  { title: 'Encryption at rest confirmed for every store', note: true, topics: ['Security'] },
                  { title: 'Password rules brought in line with the standard', priority: 'low' },
                ],
              },
            ],
          },
          {
            panels: [
              {
                name: 'Internal audit',
                items: [
                  { title: 'Book the internal audit for the first week of November', due: '2026-10-15' },
                  { title: 'Audit programme covering every control area', priority: 'normal', people: ['Ines Verbeek'] },
                  { title: 'Evidence pack for the change-management control', due: '2026-09-28', priority: 'high' },
                  { title: 'Non-conformities from the readiness review', note: true, people: ['Ines Verbeek'] },
                  { title: 'Minutes of the management review meeting', priority: 'low' },
                  { title: 'Track the corrective actions through to closure', priority: 'normal' },
                ],
              },
              {
                name: 'Vendor & third-party review',
                items: [
                  { title: 'Security questionnaire out to the hosting provider', due: '2026-09-24', priority: 'normal' },
                  { title: 'Collect a data-processing agreement from every processor', priority: 'high' },
                  { title: 'Publish the sub-processor list on the website', priority: 'low' },
                  {
                    title: 'Read the penetration test report from the imaging supplier',
                    due: '2026-10-06',
                    topics: ['Security'],
                  },
                  { title: 'Exit plan for the legacy analytics vendor', note: true },
                  { title: 'Annual supplier review dates into the calendar' },
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
    dashboards: [
      {
        name: 'Day to day',
        rows: [
          {
            panels: [
              {
                name: 'This week',
                items: [
                  {
                    title: 'Sign off the Black Friday capacity plan',
                    description: 'Last year the tills queued for eleven minutes at the peak.',
                    due: '2026-09-18',
                    priority: 'high',
                  },
                  { title: 'Review the warehouse integration spike', priority: 'normal' },
                  { title: 'Walk the new checkout flow with Priya', people: ['Priya Shah'] },
                  { title: 'Decide build or buy for the loyalty scheme', due: '2026-09-23', priority: 'high' },
                  { title: 'Store managers are asking for offline mode on the tills', note: true, people: ['Priya Shah'] },
                  { title: 'Catch up with the platform team about the incident', priority: 'normal' },
                ],
              },
              {
                name: 'Leadership',
                items: [
                  {
                    title: "Next year's technology budget over to Liam",
                    due: '2026-09-19',
                    priority: 'high',
                    people: ['Liam Novak'],
                  },
                  { title: 'Second interviews for the data engineer role', priority: 'normal', topics: ['Hiring'] },
                  { title: 'Write the job description for the mobile lead', topics: ['Hiring'] },
                  { title: 'Architecture slide for the quarterly board pack', due: '2026-09-29', people: ['Liam Novak'] },
                  { title: 'The ops handover ritual with Priya is not working', note: true, people: ['Priya Shah'] },
                  { title: 'Review the contractor rates before the renewals', priority: 'low', topics: ['Hiring'] },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
];
