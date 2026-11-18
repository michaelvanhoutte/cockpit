import { useScreenWidth } from '../panels/useScreenWidth';
import { DEFAULT_VIEW, usePoc, viewKey, type DashboardView } from './store';

export const PHONE_WIDTH = 640;

const CHOICES: { value: DashboardView; label: string }[] = [
  { value: 'side', label: 'Side by side' },
  { value: 'stacked', label: 'Stacked' },
  { value: 'panels', label: 'Panels only' },
  { value: 'board', label: 'Whiteboard only' },
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
          onClick={() => setView(choice.value)}
          className={`whitespace-nowrap rounded px-2 py-1 text-xs ${
            view === choice.value ? 'bg-white/90 font-medium text-ink' : 'text-chrome-ink hover:bg-white/10'
          }`}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}
