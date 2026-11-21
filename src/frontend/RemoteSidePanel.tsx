import type { ComponentType } from "react";
import { useSlotContributions } from "@termix-ssh/plugin-sdk/frontend";
import { REMOTE_DESKTOP_SIDE_PANEL_SLOT } from "./toolbar-items";

export interface RemoteSidePanelState {
  id: string;
  props: Record<string, unknown>;
}

/**
 * A panel another plugin docks beside the display, like the share panel.
 * A toolbar action opens it with `openSidePanel(id, props)`.
 */
export function RemoteSidePanel({
  panel,
  hostId,
  onClose,
}: {
  panel: RemoteSidePanelState;
  hostId?: number;
  onClose: () => void;
}) {
  const contributions = useSlotContributions(REMOTE_DESKTOP_SIDE_PANEL_SLOT);
  const contribution = contributions.find(
    (entry) => entry.actionId === panel.id && entry.component,
  );
  if (!contribution?.component) return null;
  const Panel = contribution.component as ComponentType<
    Record<string, unknown>
  >;
  return (
    <aside className="flex h-full w-[360px] max-w-[50%] shrink-0 flex-col border-l border-border bg-background">
      <Panel
        panelProps={panel.props}
        hostId={hostId}
        onClose={onClose}
        placed
      />
    </aside>
  );
}
