import { useScreenWidth } from '../panels/useScreenWidth';
import { DEFAULT_VIEW, usePoc, viewKey, type DashboardView } from './store';

export const PHONE_WIDTH = 640;

const R = (x: number, y: number, w: number, h: number, fill = false) => (
  <rect x={x} y={y} width={w} height={h} rx={1.2} fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.3} />
);
const CHOICES: { value: DashboardView; label: string; icon: React.ReactNode }[] = [
  { value: 'panels', label: 'Panels only', icon: <>{R(1.5, 2.5, 4, 11)}{R(6.5, 2.5, 3, 11)}{R(10.5, 2.5, 4, 11)}</> },
  { value: 'side', label: 'Side by side', icon: <>{R(1.5, 2.5, 5, 11)}{R(8, 2.5, 6.5, 11, true)}</> },
  { value: 'stacked', label: 'Stacked', icon: <>{R(1.5, 2, 13, 6.5, true)}{R(1.5, 10, 13, 4)}</> },
  { value: 'board', label: 'Whiteboard only', icon: <>{R(1.5, 2.5, 13, 11, true)}</> },
];

/** POC (throwaway): how the open Dashboard is drawn, remembered per Dashboard. */
export function ViewSwitch({ dashboardId }: { dashboardId: string }) {
  const [view, setView] = usePoc<DashboardView>(viewKey(dashboardId), DEFAULT_VIEW);
  if (useScreenWidth() < PHONE_WIDTH) return null;
  return (
    <div role="radiogroup" aria-label="Dashboard view" className="mb-1 flex shrink-0 items-center rounded-md bg-black/15 p-0.5">
      {CHOICES.map((choice) => (
        <button
          key={choice.value}
          type="button"
          role="radio"
          aria-checked={view === choice.value}
          aria-label={choice.label}
          title={choice.label}
          onClick={() => setView(choice.value)}
          className={`flex items-center rounded px-1.5 py-1 ${
            view === choice.value ? 'bg-white/90 text-ink' : 'text-chrome-ink hover:bg-white/10'
          }`}
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
            {choice.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}
