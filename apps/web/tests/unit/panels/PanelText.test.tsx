import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Panel } from '@cockpit/shared';

/**
 * F1: what a panel of text draws, and when its formatting bar is there.
 *
 * **Both chunks are replaced.** The editor is 135KB and the renderer its own
 * fetch (architecture, "Performance budgets"), so there is a window where the
 * panel is on screen and neither has arrived - and a case where one never does.
 * What the editor does with Markdown is proved in
 * tests/unit/description/syntax.test.ts, and what the panel needs from it here
 * is only *when* it appears and whether its bar is drawn.
 *
 * What is stored, and that switching how it is drawn never touches the words,
 * is proved against a real store in
 * apps/api/tests/integration/http/panels.test.ts. That the two chunks really
 * are separate files, each charged on its own against the budget, is
 * `scripts/bundle-budget.mjs` in CI - not a browser walk: the F3 tier runs the
 * Vite dev server, which serves a pre-bundled dependency whether or not
 * anything renders it.
 */

/** What the fetch for a chunk does. One of the three, per test. */
type Arrival = 'arrives' | 'never comes';

function aPanelOfText(holding: Partial<Panel> = {}): Panel {
  return {
    id: 'words',
    tenantId: 'tenant',
    dashboardId: 'today',
    name: 'What matters',
    kind: 'text',
    format: 'plain',
    body: '',
    readOnly: false,
    ...holding,
  };
}

/**
 * How many times each chunk was actually asked for. Counted in the factories
 * below, which `React.lazy` runs once each and only when something renders the
 * component - so a zero here is the panel never reaching for that chunk.
 */
let asked: { editor: number; renderer: number };

/**
 * The panel, with the chunks arriving the way this test wants them to.
 *
 * Mocked per test rather than once for the file, for the reason the item form's
 * description is: a module factory runs once and `React.lazy` remembers the
 * first answer it got, so one registration would make every test share
 * whichever arrival ran first - and would make the counts above meaningless.
 */
async function show(panel: Panel, arrival: Arrival = 'arrives') {
  vi.resetModules();
  asked = { editor: 0, renderer: 0 };
  vi.doMock('../../../src/api/queries', async () => {
    const actual = await vi.importActual<typeof import('../../../src/api/queries')>(
      '../../../src/api/queries',
    );
    return { ...actual, useCommand: () => ({ mutate: vi.fn(), reset: vi.fn(), error: null }) };
  });
  vi.doMock('../../../src/description/RichDescription', async () => {
    asked.editor += 1;
    if (arrival === 'never comes') throw new Error('offline');
    return {
      default: ({ label, toolbar }: { label: string; toolbar: boolean }) => (
        <div>
          {toolbar && <div role="toolbar" aria-label="Formatting" />}
          <div aria-label={label} role="textbox" tabIndex={0} contentEditable suppressContentEditableWarning />
        </div>
      ),
    };
  });
  vi.doMock('../../../src/panels/DrawnText', async () => {
    asked.renderer += 1;
    if (arrival === 'never comes') throw new Error('offline');
    return { default: ({ body }: { body: string }) => <div data-testid="drawn">{body}</div> };
  });
  const { PanelText } = await import('../../../src/panels/PanelText');
  render(<PanelText panel={panel} workspaceId="ws-work" />);
  return userEvent.setup();
}

afterEach(() => {
  cleanup();
  vi.doUnmock('../../../src/description/RichDescription');
  vi.doUnmock('../../../src/panels/DrawnText');
  vi.doUnmock('../../../src/api/queries');
});

describe('Panels', () => {
  describe('a panel of text shows the characters that were typed until somebody asks for formatting', () => {
    it('draws the characters when nobody has asked, whether it is read or written in', async () => {
      await show(aPanelOfText({ body: '**Pricing**', readOnly: true }));
      expect(screen.getByText('**Pricing**')).toBeInTheDocument();
      cleanup();

      await show(aPanelOfText({ body: '**Pricing**' }));
      expect(screen.getByRole('textbox', { name: 'What matters' })).toHaveValue('**Pricing**');
    });

    it('draws what the words mean once somebody has, without fetching an editor to do it', async () => {
      await show(aPanelOfText({ body: '**Pricing**', format: 'rich', readOnly: true }));

      expect(await screen.findByTestId('drawn')).toHaveTextContent('**Pricing**');
      // The renderer, not the editor: a panel being read has nothing to type
      // into, so there is no bar and no box.
      expect(screen.queryByRole('toolbar')).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
    });

    /**
     * The whole reason drawing and writing are two chunks (architecture,
     * "Performance budgets"): a dashboard of panels nobody is writing in must
     * not pay for an editor. That the two really are separate files, each
     * charged on its own, is `scripts/bundle-budget.mjs` in CI; what is asked
     * here is that the panel only ever reaches for the one it needs.
     */
    it.each([
      { situation: 'plain and read', panel: aPanelOfText({ body: 'x', readOnly: true }), wants: { editor: 0, renderer: 0 } },
      { situation: 'plain and written in', panel: aPanelOfText({ body: 'x' }), wants: { editor: 0, renderer: 0 } },
      {
        situation: 'formatted and read',
        panel: aPanelOfText({ body: 'x', format: 'rich', readOnly: true }),
        wants: { editor: 0, renderer: 1 },
      },
      {
        situation: 'formatted and written in',
        panel: aPanelOfText({ body: 'x', format: 'rich' }),
        wants: { editor: 1, renderer: 0 },
      },
    ])('$situation asks for what it needs and nothing else', async ({ panel, wants }) => {
      await show(panel);
      // Settled, so a chunk fetched a tick late is not missed.
      await vi.waitFor(() => expect(asked.editor + asked.renderer).toBe(wants.editor + wants.renderer));

      expect(asked).toEqual(wants);
    });

    it('leaves the characters readable where the chunk never comes', async () => {
      await show(aPanelOfText({ body: '**Pricing**', format: 'rich', readOnly: true }), 'never comes');

      expect(await screen.findByText('**Pricing**')).toBeInTheDocument();
    });
  });

  describe('formatting is offered only while somebody is writing in the panel', () => {
    it('draws no bar until the panel is written in, and takes it away again', async () => {
      const user = await show(aPanelOfText({ format: 'rich' }));
      const box = await screen.findByRole('textbox', { name: 'What matters' });

      // Formatted and open to be written in, but nobody in it: a bar standing
      // over the dashboard would be chrome for something nobody is doing.
      expect(screen.queryByRole('toolbar')).toBeNull();

      await user.click(box);
      expect(await screen.findByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();

      box.blur();
      await vi.waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull());
    });

    it.each([
      { situation: 'plain and written in', panel: aPanelOfText() },
      { situation: 'formatted and read', panel: aPanelOfText({ body: 'x', format: 'rich', readOnly: true }) },
      { situation: 'plain and read', panel: aPanelOfText({ body: 'x', readOnly: true }) },
    ])('$situation, there is never a bar', async ({ panel }) => {
      await show(panel);

      expect(screen.queryByRole('toolbar')).toBeNull();
    });
  });
});
