import { uuidv7 } from '@cockpit/shared';
import type { DashboardView } from '@cockpit/shared/board';
import { useSendCommand, whyNotDone } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { boardLayoutOf } from '../boardLayout';
import { showBoardOnPhone, useBoardOnPhone } from '../boardFocus';
import { useUndo } from '../undo';

const R = (x: number, y: number, w: number, h: number, fill = false) => (
  <rect x={x} y={y} width={w} height={h} rx={1.2} fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.3} />
);

const CHOICES: { value: DashboardView; label: string; icon: React.ReactNode }[] = [
  { value: 'panels', label: 'Panels only', icon: <>{R(1.5, 2.5, 4, 11)}{R(6.5, 2.5, 3, 11)}{R(10.5, 2.5, 4, 11)}</> },
  { value: 'side', label: 'Side by side', icon: <>{R(1.5, 2.5, 5, 11)}{R(8, 2.5, 6.5, 11, true)}</> },
  { value: 'stacked', label: 'Stacked', icon: <>{R(1.5, 2, 13, 6.5, true)}{R(1.5, 10, 13, 4)}</> },
  { value: 'board', label: 'Whiteboard only', icon: <>{R(1.5, 2.5, 13, 11, true)}</> },
];

/**
 * The four layout icons in the Dashboard bar ("Brainstorming: give every
 * Dashboard a whiteboard of its own", issue 1829): Panels only, side by side,
 * stacked, or the whiteboard alone, remembered per Dashboard. Drawn at a desk
 * only; a phone has its *Panels | Whiteboard* toggle instead (`DashboardPage`).
 */
export function LayoutSwitch({ workspaceId, dashboardId }: { workspaceId: string; dashboardId: string }) {
  const { data } = useSnapshot(workspaceId);
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const { view } = boardLayoutOf(data, dashboardId);
  const choose = (value: DashboardView) => {
    if (value === view) return;
    send({ name: 'set_dashboard_view', payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId, dashboardId, view: value } }).catch(
      (failure: unknown) => offerToUndo({ what: `The layout was not changed. ${whyNotDone(failure)}` }),
    );
  };
  return (
    <div role="radiogroup" aria-label="Dashboard layout" className="mb-1 flex shrink-0 items-center rounded-md bg-white/6 p-0.5">
      {CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={view === choice.value}
          aria-label={choice.label}
          title={choice.label}
          onClick={() => choose(choice.value)}
          className={`flex items-center rounded px-1.5 py-1 ${view === choice.value ? 'bg-white/90 text-ink' : 'text-chrome-ink hover:bg-white/10'}`}
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
            {choice.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}

/**
 * *Panels | Whiteboard* on a phone, in the Dashboard bar where a desk has its
 * four layout icons: the board shown in place of the Panels, to look at and
 * tap. Not remembered, so a Dashboard opens on its Panels.
 */
export function PhoneBoardSwitch({ dashboardId }: { dashboardId: string }) {
  const onBoard = useBoardOnPhone(dashboardId);
  return (
    <div role="tablist" aria-label="Show" className="mb-1 flex shrink-0 items-center rounded-md bg-white/6 p-0.5">
      {([false, true] as const).map((board) => (
        <button
          key={String(board)}
          type="button"
          role="tab"
          aria-selected={onBoard === board}
          aria-label={board ? 'Whiteboard' : 'Panels'}
          title={board ? 'Whiteboard' : 'Panels'}
          onClick={() => showBoardOnPhone(board ? dashboardId : null)}
          className={`flex items-center rounded px-1.5 py-1 ${onBoard === board ? 'bg-white/90 text-ink' : 'text-chrome-ink hover:bg-white/10'}`}
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
            {board ? CHOICES[3]!.icon : CHOICES[0]!.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}
