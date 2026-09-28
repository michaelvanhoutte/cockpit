import {
  expect,
  expectNoSidewaysScroll,
  openFirstWorkspace,
  press,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, because none of this exists below a real browser: the dock is drawn at
 * the bottom of the shell, a tile's own menu opens by right-click, and A and
 * the gear toggle the dock itself - none of which a component test can drive
 * with a real keyboard event over the real page.
 *
 * It is not re-proving the naming, hiding or Ask Claude rules, which
 * apps/api/tests/integration/http/agents.test.ts owns against a real store,
 * nor which tiles a given state draws, which
 * packages/shared/tests/unit/domain/agent.test.ts owns, nor the dock's own
 * wiring, which apps/web/tests/unit/components/AgentDock.test.tsx owns. One
 * walk for the capability, saying it works for a person - on the one device
 * it is offered on ("Keep your agents in a dock, and choose which each
 * dashboard shows", issue 570): hidden on a phone, where there is no drag.
 *
 * It makes an agent of its own, named uniquely, and deletes it again at the
 * end: every spec in a run shares one account (support/app.ts), and an agent
 * is account-wide, drawn in the dock of every workspace and dashboard a spec
 * after this one opens.
 */
test.describe('Agents', () => {
  test.describe('an agent is made, edited, hidden, shown and deleted from the dock', () => {
    test('offers it from the dock, and the dock only, and hides on a phone', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);

      if (isMobile) {
        await expect(page.getByRole('toolbar', { name: 'Agents' })).toHaveCount(0);
        await expectNoSidewaysScroll(page);
        return;
      }

      const dock = page.getByRole('toolbar', { name: 'Agents' });
      await expect(dock).toBeVisible();

      const name = uniqueTitle('Scope it');
      await press(dock.getByRole('button', { name: '+ New agent' }), isMobile);
      await page.getByLabel('Name of the agent').fill(name);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(dock.getByRole('button', { name })).toBeVisible();

      // A name another agent already has is refused, and the form stays open.
      await press(dock.getByRole('button', { name: '+ New agent' }), isMobile);
      await page.getByLabel('Name of the agent').fill(name);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(page.getByRole('alert')).toHaveText(`an agent called ${name} already exists`);
      await press(page.getByRole('button', { name: 'Cancel' }), isMobile);

      // Edited from the tile's own menu.
      const renamed = uniqueTitle('Scope it well');
      await dock.getByRole('button', { name }).click({ button: 'right' });
      await press(page.getByRole('menuitem', { name: 'Edit…' }), isMobile);
      await expect(page.getByLabel('Name of the agent')).toHaveValue(name);
      await page.getByLabel('Name of the agent').fill(renamed);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await expect(dock.getByRole('button', { name: renamed })).toBeVisible();

      // Hidden on this dashboard from the tile's own menu; the dock's own
      // "…" says so and offers it back.
      await dock.getByRole('button', { name: renamed }).click({ button: 'right' });
      await press(page.getByRole('menuitem', { name: 'Hide on this dashboard' }), isMobile);
      await expect(dock.getByRole('button', { name: renamed })).toHaveCount(0);

      const dockMenu = dock.getByRole('button', {
        name: 'What is hidden here, and the Ask Claude switch',
      });
      await press(dockMenu, isMobile);
      await expect(page.getByText('1 hidden here')).toBeVisible();
      await press(page.getByRole('menuitem', { name: `Show ${renamed}` }), isMobile);
      await expect(dock.getByRole('button', { name: renamed })).toBeVisible();

      // The dock hides and shows with A and from the gear.
      await page.keyboard.press('a');
      await expect(dock).toHaveCount(0);
      await press(page.getByRole('button', { name: 'Account settings' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Show the agents’ dock' }), isMobile);
      await expect(dock).toBeVisible();

      // Deleted, asked first, from the tile's own menu.
      await dock.getByRole('button', { name: renamed }).click({ button: 'right' });
      await press(page.getByRole('menuitem', { name: 'Delete…' }), isMobile);
      await expect(page.getByText(`Delete ${renamed}?`)).toBeVisible();
      await press(page.getByRole('button', { name: `Yes, delete ${renamed}` }), isMobile);
      await expect(dock.getByRole('button', { name: renamed })).toHaveCount(0);

      await expectNoSidewaysScroll(page);
    });
  });
});
