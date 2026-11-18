import { CombineDialog } from './CombineDialog';
import { useAsking } from './dialogs';
import { SplitDialog } from './SplitDialog';

/** POC (throwaway): where the Combine and Split dialogs are drawn, whichever page asked. */
export default function PocHost({ workspaceId }: { workspaceId: string }) {
  const asking = useAsking();
  return (
    <>
      {asking.combine && (
        <CombineDialog
          key={asking.combine.itemIds.join()}
          workspaceId={workspaceId}
          itemIds={asking.combine.itemIds}
          dashboardId={asking.combine.dashboardId}
          boardNodeIds={asking.combine.boardNodeIds}
        />
      )}
      {asking.split && <SplitDialog key={asking.split.itemId} workspaceId={workspaceId} itemId={asking.split.itemId} />}
    </>
  );
}
