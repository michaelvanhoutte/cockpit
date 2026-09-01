import { describe, expect, it } from 'vitest';
import { isOutsideTheGate } from '../../../src/auth/gate.js';

/**
 * L1: which addresses answer without a sign-in is a decision about a string,
 * with no request, no register and no clock behind it.
 *
 * The integration suite proves the gate is *wired* - that a real request to a
 * real endpoint is refused or let through - and it can only ask that of
 * addresses something actually answers. This asks the half it cannot: what
 * happens at an address no route serves, where being outside the gate and being
 * refused both end in nothing useful and the difference is invisible from
 * outside. `/v1/users/anything` is the case the rule was written for.
 */
describe('Sign-in', () => {
  describe('the way in is exactly the addresses that have a reason to be open', () => {
    it.each([
      { situation: 'the health check', path: '/health' },
      { situation: 'the people to choose from', path: '/v1/users' },
      { situation: 'signing in', path: '/v1/sign-in' },
      { situation: 'getting back through the perimeter', path: '/v1/relogin' },
      { situation: 'a delivery from a source', path: '/ingress/slack/events' },
      {
        // The prefix is what the connector's id and whatever the source appends
        // to it need, so it has to keep working however deep the path goes.
        situation: 'a delivery filed under a path of its own',
        path: '/ingress/mail/hooks/a/b/c',
      },
    ])('lets $situation past without a sign-in', ({ path }) => {
      expect(isOutsideTheGate(path)).toBe(true);
    });

    it.each([
      { situation: 'anything hung off the list of people', path: '/v1/users/anything' },
      { situation: 'anything hung off signing in', path: '/v1/sign-in/x' },
      {
        // Not a sub-path but a longer name, which a prefix check would let
        // through and an exact one does not.
        situation: 'an address that merely starts like the health check',
        path: '/healthy',
      },
      { situation: 'ingress with nothing filed under it', path: '/ingress' },
      { situation: 'your workspaces', path: '/v1/workspaces' },
      { situation: 'the live updates stream', path: '/v1/events' },
      { situation: 'capturing a thought', path: '/v1/commands/capture_item' },
    ])('holds $situation behind it', ({ path }) => {
      expect(isOutsideTheGate(path)).toBe(false);
    });
  });
});
