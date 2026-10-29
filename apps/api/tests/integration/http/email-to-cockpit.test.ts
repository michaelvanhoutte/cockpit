import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE, type WorkspaceSnapshot } from '@cockpit/shared';
import worker from '../../../src/worker.js';
import {
  ACCOUNT_NAME,
  OTHER_ACCOUNT_NAME,
  OTHER_USER_ID,
  WORKSPACE_ID,
  asUser,
  besidesTheGuide,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, through the real Worker, register and account store:
 * an address is the register's row and the store's together, and a mail is
 * decided by both ("Get an Email to Cockpit address, and receive mail at it",
 * issue 1466). The address is got, renewed and turned off as Settings does it,
 * through the command's own route; a mail is handed to the Worker's own email
 * event, as Email Routing hands one over. Which address a mail is to, and what
 * of it is logged, is tests/unit/email/receive.test.ts's.
 *
 * **This is the coverage ceiling for receiving mail**: no browser can send one.
 */

const DOMAIN = 'mail.cockpit.test';
const AT = '2026-10-29T10:00:00.000Z';
const FIRST = 'k7f3q9xwk7f3q9xwk7f3';
const SECOND = 'p2r8m4ndp2r8m4ndp2r8';
const OTHERS = 'z9y8x7w6z9y8x7w6z9y8';

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

function setAddress(localPart: unknown, userId?: string, commandId = nextId()): Promise<Response> {
  return asUser(
    'http://cockpit.test/v1/commands/set_email_address',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandId, issuedAt: AT, workspaceId: ACCOUNT_WIDE, localPart }),
    },
    userId,
  );
}

async function read(userId?: string): Promise<WorkspaceSnapshot> {
  const response = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`, undefined, userId);
  expect(response.status).toBe(200);
  return (await response.json()) as WorkspaceSnapshot;
}

/** The register's rows, as the email event reads them. */
async function registered(): Promise<{ local_part: string; account_id: string }[]> {
  const rows = await env.DB.prepare('SELECT local_part, account_id FROM email_addresses ORDER BY local_part').all();
  return rows.results as { local_part: string; account_id: string }[];
}

const BODY = 'The quarterly numbers for Jan are attached';

/** A mail as Email Routing hands one to the Worker, and what became of it. */
async function mailed(to: string, settings: typeof env = env) {
  const rejected: string[] = [];
  const lines: string[] = [];
  const logged = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    await worker.email(
      {
        from: 'sender@gmail.com',
        to,
        headers: new Headers({
          'authentication-results': 'mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass; dmarc=pass header.from=gmail.com',
          subject: 'Quarterly numbers',
          from: 'Sender <sender@gmail.com>',
        }),
        raw: new Response(`Subject: Quarterly numbers\r\n\r\n${BODY}`).body,
        rawSize: 120,
        setReject: (reason: string) => rejected.push(reason),
      } as never,
      settings,
    );
  } finally {
    logged.mockRestore();
  }
  const said = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { rejected: rejected.length > 0, said };
}

const at = (localPart: string) => `${localPart}@${DOMAIN}`;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await signInAs();
  await signInAs(OTHER_USER_ID);
  seq = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Email to Cockpit', () => {
  describe('an account holds at most one address, and only the one it holds reaches it', () => {
    it('Get an address holds it, and mail to it is received for this account', async () => {
      expect((await read()).emailToCockpit).toEqual({ domain: DOMAIN, localPart: null });

      expect((await setAddress(FIRST)).status).toBe(200);

      expect((await read()).emailToCockpit).toEqual({ domain: DOMAIN, localPart: FIRST });
      const mail = await mailed(at(FIRST));
      expect(mail.rejected).toBe(false);
      expect(mail.said).toEqual([expect.objectContaining({ account: ACCOUNT_NAME })]);
    });

    it('Make a new address refuses mail to the old one and receives it at the new one', async () => {
      await setAddress(FIRST);

      expect((await setAddress(SECOND)).status).toBe(200);

      expect((await read()).emailToCockpit?.localPart).toBe(SECOND);
      expect((await mailed(at(FIRST))).rejected).toBe(true);
      expect((await mailed(at(SECOND))).rejected).toBe(false);
      expect(await registered()).toEqual([{ local_part: SECOND, account_id: ACCOUNT_NAME }]);
    });

    it('Turn off refuses mail to it, and the account holds no address again', async () => {
      await setAddress(FIRST);

      expect((await setAddress(null)).status).toBe(200);

      expect((await read()).emailToCockpit).toEqual({ domain: DOMAIN, localPart: null });
      expect((await mailed(at(FIRST))).rejected).toBe(true);
      expect(await registered()).toEqual([]);
    });

    it.each([
      { situation: 'one under 16 characters', localPart: 'k7f3q9xwk7f3q9x' },
      { situation: 'one with a capital letter', localPart: 'K7f3q9xwk7f3q9xwk7f3' },
      { situation: 'one with a dot', localPart: 'k7f3q9xw.k7f3q9xwk7f' },
    ])('refuses $situation and keeps nothing', async ({ localPart }) => {
      expect((await setAddress(localPart)).status).toBe(400);

      expect((await read()).emailToCockpit?.localPart).toBeNull();
      expect(await registered()).toEqual([]);
    });

    it('the same Get an address sent twice holds one address', async () => {
      const commandId = nextId();
      expect((await setAddress(FIRST, undefined, commandId)).status).toBe(200);

      const again = await setAddress(FIRST, undefined, commandId);

      expect(again.status).toBe(200);
      expect(((await again.json()) as { applied: boolean }).applied).toBe(false);
      expect(await registered()).toEqual([{ local_part: FIRST, account_id: ACCOUNT_NAME }]);
    });

    it('two accounts each receive only the mail to their own address', async () => {
      await setAddress(FIRST);
      await setAddress(OTHERS, OTHER_USER_ID);

      expect((await mailed(at(FIRST))).said).toEqual([expect.objectContaining({ account: ACCOUNT_NAME })]);
      expect((await mailed(at(OTHERS))).said).toEqual([expect.objectContaining({ account: OTHER_ACCOUNT_NAME })]);
      expect((await read()).emailToCockpit?.localPart).toBe(FIRST);
      expect((await read(OTHER_USER_ID)).emailToCockpit?.localPart).toBe(OTHERS);
    });

    it('refuses an address another account holds, and keeps both as they were', async () => {
      await setAddress(OTHERS, OTHER_USER_ID);

      expect((await setAddress(OTHERS)).status).toBe(409);

      expect((await read()).emailToCockpit?.localPart).toBeNull();
      expect(await registered()).toEqual([{ local_part: OTHERS, account_id: OTHER_ACCOUNT_NAME }]);
    });

    /**
     * What a renewal stopped between the store and the register leaves: a row
     * the store no longer confirms. Made here through the interface, by the
     * first Get arriving again after the renewal, which writes its row and
     * changes nothing in the store.
     */
    it('a row the account no longer holds rejects its mail, and is swept once it is a minute old', async () => {
      const firstGet = nextId();
      await setAddress(FIRST, undefined, firstGet);
      await setAddress(SECOND);
      await setAddress(FIRST, undefined, firstGet);
      expect(await registered()).toHaveLength(2);

      const atOnce = await mailed(at(FIRST));
      expect(atOnce.rejected).toBe(true);
      expect(await registered()).toHaveLength(2);

      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 60_000 }); // clock-ok: a minute on from the row just written
      const later = await mailed(at(FIRST));

      expect(later.rejected).toBe(true);
      expect(later.said).toEqual([expect.objectContaining({ account: ACCOUNT_NAME, swept: true })]);
      expect(await registered()).toEqual([{ local_part: SECOND, account_id: ACCOUNT_NAME }]);
      expect((await mailed(at(SECOND))).rejected).toBe(false);
    });
  });

  describe('mail to an address nobody holds is rejected, and mail to a held one is received and captures nothing', () => {
    it.each([
      { situation: 'an address nobody got', to: at(SECOND) },
      { situation: 'a name Cockpit never makes', to: `michael@${DOMAIN}` },
      { situation: 'another domain', to: `${FIRST}@cockpit.test` },
    ])('rejects mail to $situation', async ({ to }) => {
      await setAddress(FIRST);

      expect((await mailed(to)).rejected).toBe(true);
    });

    it('receives mail to a held address, captures nothing, and logs one line naming the account and how the mail was authenticated, never what it says', async () => {
      await setAddress(FIRST);
      const before = besidesTheGuide((await read()).items);

      const mail = await mailed(at(FIRST));

      expect(mail.rejected).toBe(false);
      expect(besidesTheGuide((await read()).items)).toEqual(before);
      expect(mail.said).toEqual([
        expect.objectContaining({
          account: ACCOUNT_NAME,
          authentication: expect.objectContaining({ 'authentication-results': expect.stringContaining('dmarc=pass') }),
        }),
      ]);
      expect(JSON.stringify(mail.said)).not.toContain(BODY);
      expect(JSON.stringify(mail.said)).not.toContain('Quarterly');
    });

    it('rejects every mail where the environment receives none, and draws no address', async () => {
      await setAddress(FIRST);
      const settings = env as unknown as Record<string, string | undefined>;
      const domain = settings.EMAIL_DOMAIN;
      delete settings.EMAIL_DOMAIN;
      try {
        expect((await read()).emailToCockpit).toBeNull();
        expect((await mailed(at(FIRST))).rejected).toBe(true);
      } finally {
        settings.EMAIL_DOMAIN = domain;
      }
    });
  });

  describe('the guest holds no address', () => {
    it('refuses Get an address from the guest, and holds none for it', async () => {
      const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
      const cookie = back.headers
        .getSetCookie()
        .map((one) => one.split(';')[0]!)
        .find((one) => one.startsWith('cockpit_session='))!;

      const res = await SELF.fetch('http://cockpit.test/v1/commands/set_email_address', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ commandId: nextId(), issuedAt: AT, workspaceId: ACCOUNT_WIDE, localPart: FIRST }),
      });

      expect(res.status).toBe(403);
      expect(await registered()).toEqual([]);
      expect((await mailed(at(FIRST))).rejected).toBe(true);
    });
  });
});
