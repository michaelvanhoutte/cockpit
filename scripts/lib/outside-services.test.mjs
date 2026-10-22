//
// The outside-services rule ("Fail the Checks job when an outside service has
// no live contract case, and hold a pull request whose real-device check was
// not done", issue 1426): every outside host the product or the Harness
// Monitor calls belongs to a listed service with a contract suite, or with a
// gap and its reason. The functions over a small list written here, then the
// same check over the real tree, which is the half that gates.
//

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkServices, checkTree, hostsIn, LIST_PATH, listFailures, unclaimedHosts } from './outside-services.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../..');

const SUITE = 'packages/connectors/gmail/tests/contract/recorded-answers.test.ts';
const exists = (path) => path === SUITE;

const gmail = { name: 'Gmail', hosts: ['gmail.googleapis.com', 'accounts.google.com'], suite: SUITE };
const list = { services: [gmail], notServices: [{ host: 'example.com', reason: 'A placeholder address.' }] };

const source = (path, host) => ({ path, text: `const url = 'https://${host}/path';` });

describe('every outside service has a live contract suite, or a gap and its reason', () => {
  it('passes an entry naming a suite that exists', () => {
    assert.deepEqual(listFailures(list, exists), []);
  });

  it('refuses an entry naming a suite that does not exist, naming the entry', () => {
    const missing = { services: [{ name: 'Gmail', hosts: [], suite: 'packages/connectors/gmail/tests/contract/gone.test.ts' }] };
    const [failure, ...rest] = listFailures(missing, exists);
    assert.match(failure, /Gmail names the contract suite packages\/connectors\/gmail\/tests\/contract\/gone\.test\.ts, which does not exist/);
    assert.deepEqual(rest, []);
  });

  it('refuses an entry with neither a suite nor a gap, naming the entry', () => {
    const [failure, ...rest] = listFailures({ services: [{ name: 'Slack', hosts: ['slack.com'] }] }, exists);
    assert.match(failure, /Slack has neither a contract suite nor a gap/);
    assert.deepEqual(rest, []);
  });

  it('refuses a gap with an empty reason, naming the entry', () => {
    for (const gap of ['', '   ']) {
      const [failure, ...rest] = listFailures({ services: [{ name: 'Twilio Verify', hosts: [], gap }] }, exists);
      assert.match(failure, /Twilio Verify has a gap with no reason/);
      assert.deepEqual(rest, []);
    }
  });

  it('refuses a host marked as not a service with no reason, naming the host', () => {
    const [failure] = listFailures({ services: [gmail], notServices: [{ host: 'example.com', reason: '' }] }, exists);
    assert.match(failure, /example\.com is marked as not a service with no reason/);
  });

  it('refuses a host in product source that no entry claims, naming the host and the file', () => {
    const [failure, ...rest] = unclaimedHosts(list, [source('apps/api/src/notify/slack.ts', 'hooks.slack.com')]);
    assert.match(failure, /^apps\/api\/src\/notify\/slack\.ts: names the outside host hooks\.slack\.com,/);
    assert.deepEqual(rest, []);
  });

  it('refuses a host in Harness Monitor source that no entry claims', () => {
    const [failure] = unclaimedHosts(list, [source('apps/harness-monitor/src/costs.ts', 'api.stripe.com')]);
    assert.match(failure, /^apps\/harness-monitor\/src\/costs\.ts: names the outside host api\.stripe\.com,/);
  });

  it('passes an unclaimed host that only a test file names, since a test is not a call', () => {
    const files = [
      source('apps/api/tests/integration/slack.test.ts', 'hooks.slack.com'),
      source('apps/web/src/pages/Inbox.test.tsx', 'hooks.slack.com'),
    ];
    assert.deepEqual(unclaimedHosts(list, files), []);
  });

  it('passes each host of one entry that claims several, such as an API and its sign-in redirect', () => {
    const files = [source('packages/connectors/gmail/src/mailbox.ts', 'gmail.googleapis.com'), source('packages/connectors/gmail/src/sign-in.ts', 'accounts.google.com')];
    assert.deepEqual(unclaimedHosts(list, files), []);
  });

  it('claims a host whatever case the list writes it in', () => {
    const shouting = { services: [{ name: 'Twilio Verify', hosts: ['Verify.Twilio.com'], gap: 'a paid text' }] };
    assert.deepEqual(unclaimedHosts(shouting, [source('packages/connectors/twilio/src/verify.ts', 'verify.twilio.com')]), []);
  });

  it('passes a host the list marks as not a service, with its reason', () => {
    assert.deepEqual(unclaimedHosts(list, [source('apps/web/src/description/safeHref.ts', 'example.com')]), []);
  });

  it('does not take an address in a comment for a call', () => {
    const text = ['// see https://hooks.slack.com/x', '/** a bare ana@example.com becomes https://ana@example.com */', 'const a = 1;'].join('\n');
    assert.deepEqual(hostsIn(text), []);
  });

  it('reports the list and the source failures together', () => {
    const failures = checkServices({ services: [{ name: 'Slack', hosts: [] }] }, [source('apps/api/src/a.ts', 'hooks.slack.com')], exists);
    assert.equal(failures.length, 2);
  });
});

describe("today's repository", () => {
  it('has every outside host claimed, and every suite in place', () => {
    assert.deepEqual(checkTree(repo), []);
  });

  it('has Twilio Verify and the GitHub API as its gaps, and no other', () => {
    const { services } = JSON.parse(readFileSync(join(repo, LIST_PATH), 'utf8'));
    const gaps = services.filter((service) => service.gap !== undefined).map((service) => service.name);
    assert.deepEqual(gaps, ['Twilio Verify', 'GitHub API']);
  });
});
