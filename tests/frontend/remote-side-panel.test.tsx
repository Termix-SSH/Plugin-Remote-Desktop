import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const contributions = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSlotContributions: () => contributions.list,
}));

import { RemoteSidePanel } from "../../src/frontend/RemoteSidePanel";

describe("RemoteSidePanel", () => {
  it("docks the panel a toolbar action asked for, with its props", () => {
    const onClose = vi.fn();
    contributions.list = [
      {
        actionId: "other.panel",
        component: () => <div>other</div>,
      },
      {
        actionId: "session-sharing.sharePanel",
        component: (props: { panelProps: { sessionId: string } }) => (
          <div>share {props.panelProps.sessionId}</div>
        ),
      },
    ];
    render(
      <RemoteSidePanel
        panel={{ id: "session-sharing.sharePanel", props: { sessionId: "s1" } }}
        hostId={4}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("share s1")).toBeTruthy();
    expect(screen.queryByText("other")).toBeNull();
  });

  it("draws nothing when no plugin offers that panel", () => {
    contributions.list = [];
    const { container } = render(
      <RemoteSidePanel panel={{ id: "gone", props: {} }} onClose={() => {}} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
