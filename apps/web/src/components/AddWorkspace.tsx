import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { uuidv7 } from '@cockpit/shared';
import { useSendCommand, whyNotDone as whyNot } from '../api/queries';
import { useUndo } from '../undo';
import { WHAT_A_WORKSPACE_IS } from '../whatThingsAre';
import { NameQuestion } from './NameQuestion';

/**
 * Adds a Workspace at the click and opens it before the server has answered
 * ("Open a new Workspace the moment you add it", issue 1366): the tab, its
 * first Dashboard and that Dashboard's Panel are drawn from what the tab made,
 * no read of it is asked for first, and the route decides whether it exists
 * against the list as drawn (`router.tsx`). **A refusal takes it away, puts you
 * back where you were and says why in the undo bar**; `openWorkspaceId` is the
 * Workspace you are on, none from the first-Workspace page.
 *
 * Shared by the `+` at the end of the tabs and by that page, which is why it is
 * a hook: the two differ in what asks for the name, not in what happens next.
 */
export function useAddWorkspace(openWorkspaceId: string | null): (name: string) => void {
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const navigate = useNavigate();
  /**
   * The Workspace on screen as of the latest render, which a refusal that
   * arrives later reads: it puts you back only if you are still on the one that
   * has just gone.
   */
  const onScreen = useRef(openWorkspaceId);
  useEffect(() => {
    onScreen.current = openWorkspaceId;
  }, [openWorkspaceId]);

  return (name) => {
    // Made here rather than inside the payload, so the Workspace to open is
    // known before the answer comes back.
    const workspaceId = uuidv7();
    send({
      name: 'create_workspace',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        // The Panel its first Dashboard arrives with.
        panelId: uuidv7(),
        name,
      },
    }).catch((failure: unknown) => {
      offerToUndo({ what: `“${name}” was not added. ${whyNot(failure)}` });
      if (onScreen.current === workspaceId) {
        void navigate(
          openWorkspaceId ? { to: '/w/$workspaceId', params: { workspaceId: openWorkspaceId } } : { to: '/' },
        );
      }
    });
    // Counted as on screen from here, so a refusal that settles before the
    // route has landed (one refused offline, before it is sent) still puts you back.
    onScreen.current = workspaceId;
    void navigate({ to: '/w/$workspaceId', params: { workspaceId } });
  };
}

/**
 * The `+` at the end of the workspace tabs, and the dialog it opens.
 *
 * **Adding a workspace was reachable only through the header's menu**, two
 * presses in, on the deliberate grounds that you make three or four workspaces
 * in a lifetime and a control for that does not earn a place on the chrome.
 * What changed is that the same dialog now says *what a workspace is*, and an
 * account arrives holding one - so the explanation sat behind a door nobody new
 * would open, which is the one case that reasoning did not cover. It is also
 * the asymmetry that made workspaces feel hidden: the dashboards have a `+` on
 * the strip below this one, and the panels one at its right.
 *
 * **The rest of what can be done to one is on the tab itself**, exactly as it
 * is for dashboards: adding is a one-gesture thing you do from the strip the
 * new tab will appear on, and renaming, recolouring, moving and deleting are
 * the tab's own menu (components/WorkspaceTabs.tsx).
 */
export function AddWorkspace({ openWorkspaceId }: { openWorkspaceId: string | null }) {
  const [naming, setNaming] = useState<string | null>(null);
  const add = useAddWorkspace(openWorkspaceId);
  const button = useRef<HTMLButtonElement>(null);

  const submit = () => {
    const trimmed = (naming ?? '').trim();
    if (!trimmed) return;
    add(trimmed);
    // Closed at the click: whatever the server says arrives in the undo bar.
    setNaming(null);
  };

  return (
    <>
      <button
        type="button"
        ref={button}
        onClick={() => setNaming('')}
        aria-label="Add a workspace"
        className="mb-1 shrink-0 rounded-md px-2.5 py-1 text-sm text-chrome-ink-faint hover:bg-white/10 hover:text-chrome-ink"
      >
        +
      </button>
      <NameQuestion
        open={naming !== null}
        question="What is the new workspace called?"
        explains={WHAT_A_WORKSPACE_IS}
        fieldLabel="Name of the new workspace"
        placeholder="Work, Personal, a customer…"
        submitLabel="Add"
        name={naming ?? ''}
        onNameChange={setNaming}
        onSubmit={submit}
        onCancel={() => setNaming(null)}
        returnFocusTo={button.current}
      />
    </>
  );
}
