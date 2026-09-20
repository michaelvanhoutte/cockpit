import { describe, expect, it } from 'vitest';
import type { Dashboard } from '@cockpit/shared';
import { ordersDashboardsExactly } from '../../../src/domain/dashboards.js';

const TENANT_ID = 'tenant-default';

function aDashboard(id: string, name: string, workspaceId = 'ws-work'): Dashboard {
  return { id, tenantId: TENANT_ID, workspaceId, name };
}

describe('Dashboards', () => {
  describe('an order is only accepted when it is an order of that workspace’s dashboards', () => {
    /**
     * L1: whether a list is an order of these dashboards is a pure decision
     * over a list and a set of ids, and two of the rows below cannot be driven
     * at it through the interface at all - the wire schema refuses a repeated
     * id before a handler sees it. That the decision is reached, refuses with a
     * 409 and stores nothing is proved against a real database in
     * tests/integration/http/dashboards.test.ts.
     *
     * The list is one workspace's, which is the whole difference from the
     * workspaces' own rule: a dashboard of another workspace is as absent from
     * this list as one nobody ever made.
     */
    const live = [
      aDashboard('db-day', 'Day to day'),
      aDashboard('db-research', 'Research'),
      aDashboard('db-admin', 'Admin'),
    ];
    /**
     * A real dashboard of another workspace, built rather than written as a
     * bare id: an id nobody ever made would be the same row twice over, and
     * what the case below is about is that a dashboard which genuinely exists
     * is still not one of *these*.
     */
    const elsewhere = aDashboard('db-elsewhere', 'Day to day', 'ws-atlas').id;

    it.each([
      {
        situation: 'the dashboards it has, in a different order',
        order: ['db-admin', 'db-day', 'db-research'],
        accepted: true,
      },
      {
        situation: 'the dashboards it has, in the order they are already in',
        order: ['db-day', 'db-research', 'db-admin'],
        accepted: true,
      },
      {
        situation: 'an order made before somebody else added a dashboard',
        order: ['db-admin', 'db-day'],
        accepted: false,
      },
      {
        situation: 'an order made before somebody else deleted one',
        order: ['db-admin', 'db-day', 'db-research', 'db-gone'],
        accepted: false,
      },
      {
        situation: 'an order naming a dashboard of another workspace',
        order: ['db-admin', 'db-day', elsewhere],
        accepted: false,
      },
      {
        situation: 'an order with the same dashboard in two places',
        order: ['db-day', 'db-day', 'db-research'],
        accepted: false,
      },
      {
        situation: 'an order with the same dashboard in two places and one missing',
        order: ['db-day', 'db-day', 'db-research', 'db-admin'],
        accepted: false,
      },
      { situation: 'no order at all', order: [], accepted: false },
    ])('$situation', ({ order, accepted }) => {
      expect(ordersDashboardsExactly(live, order)).toBe(accepted);
    });

    it('is an order of nothing when there are no dashboards to order', () => {
      expect(ordersDashboardsExactly([], [])).toBe(true);
      expect(ordersDashboardsExactly([], ['db-day'])).toBe(false);
    });
  });
});
