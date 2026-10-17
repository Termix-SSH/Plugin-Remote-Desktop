import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GuacamoleToolbar } from "../../src/frontend/GuacamoleToolbar.js";
import type { GuacamoleDisplayHandle } from "../../src/frontend/GuacamoleDisplay.js";
import { DEFAULT_TOOLBAR_SETTINGS } from "../../src/frontend/toolbar-settings.js";

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

function display(overrides: Partial<GuacamoleDisplayHandle> = {}) {
  return {
    current: {
      disconnect: vi.fn(),
      isConnected: () => true,
      sendKey: vi.fn(),
      sendMouse: vi.fn(),
      setClipboard: vi.fn(),
      getFilesystem: () => null,
      uploadFile: async () => {},
      zoomIn: vi.fn(() => 1.25),
      zoomOut: vi.fn(() => 0.75),
      resetZoom: vi.fn(() => 1),
      ...overrides,
    } satisfies GuacamoleDisplayHandle,
  } as React.RefObject<GuacamoleDisplayHandle>;
}

describe("GuacamoleToolbar", () => {
  it("sends system key shortcuts and Ctrl+Alt+Del", () => {
    const ref = display();
    const sendKey = ref.current!.sendKey as ReturnType<typeof vi.fn>;
    const { getByRole } = render(
      <GuacamoleToolbar displayRef={ref} protocol="rdp" metaKeyFamily="win" />,
    );

    fireEvent.click(
      getByRole("button", { name: "remoteDesktop.toolbar.winL" }),
    );
    expect(sendKey.mock.calls).toEqual([
      [0xffeb, true],
      [0x006c, true],
      [0x006c, false],
      [0xffeb, false],
    ]);

    sendKey.mockClear();
    fireEvent.click(
      getByRole("button", { name: "remoteDesktop.toolbar.winKey" }),
    );
    expect(sendKey.mock.calls).toEqual([
      [0xffeb, true],
      [0xffeb, false],
    ]);

    sendKey.mockClear();
    fireEvent.click(
      getByRole("button", { name: "remoteDesktop.toolbar.ctrlAltDel" }),
    );
    expect(sendKey.mock.calls.map((call) => call[0])).toEqual([
      0xffe3, 0xffe9, 0xffff, 0xffff, 0xffe9, 0xffe3,
    ]);
  });

  it("latches a modifier until the next key, once each", () => {
    const ref = display();
    const sendKey = ref.current!.sendKey as ReturnType<typeof vi.fn>;
    const { getAllByRole, getByRole } = render(
      <GuacamoleToolbar displayRef={ref} protocol="rdp" metaKeyFamily="win" />,
    );
    const ctrl = getAllByRole("button", {
      name: "remoteDesktop.toolbar.stickyInactive",
    })[0];
    fireEvent.click(ctrl);
    expect(sendKey.mock.calls).toEqual([[0xffe3, true]]);
    expect(ctrl.getAttribute("aria-pressed")).toBe("true");

    sendKey.mockClear();
    fireEvent.click(getByRole("button", { name: "remoteDesktop.toolbar.esc" }));
    expect(sendKey.mock.calls).toEqual([
      [0xff1b, true],
      [0xff1b, false],
      [0xffe3, false],
    ]);
    expect(ctrl.getAttribute("aria-pressed")).toBe("false");
  });

  it.each(["vnc", "rdp"] as const)("has working zoom for %s", (protocol) => {
    const ref = display();
    const { getByRole } = render(
      <GuacamoleToolbar displayRef={ref} protocol={protocol} zoom={1.25} />,
    );
    fireEvent.click(
      getByRole("button", { name: "remoteDesktop.toolbar.zoomOut" }),
    );
    fireEvent.click(
      getByRole("button", { name: "remoteDesktop.toolbar.zoomIn" }),
    );
    fireEvent.click(
      getByRole("button", { name: "remoteDesktop.toolbar.resetZoom" }),
    );
    expect(ref.current!.zoomOut).toHaveBeenCalledOnce();
    expect(ref.current!.zoomIn).toHaveBeenCalledOnce();
    expect(ref.current!.resetZoom).toHaveBeenCalledOnce();
  });

  it("labels the VNC system key Super", () => {
    const { getByRole, queryByRole } = render(
      <GuacamoleToolbar
        displayRef={display()}
        protocol="vnc"
        metaKeyFamily="super"
      />,
    );
    expect(
      getByRole("button", { name: "remoteDesktop.toolbar.superL" }).textContent,
    ).toBe("Super+L");
    expect(
      queryByRole("button", { name: "remoteDesktop.toolbar.winL" }),
    ).toBeNull();
  });

  it("leaves desktop keys out of Telnet", () => {
    const { queryByRole, getByRole } = render(
      <GuacamoleToolbar displayRef={display()} protocol="telnet" />,
    );
    expect(
      queryByRole("button", { name: "remoteDesktop.toolbar.ctrlAltDel" }),
    ).toBeNull();
    expect(
      getByRole("button", { name: "remoteDesktop.toolbar.tab" }),
    ).toBeTruthy();
  });

  it("follows the host's position, order and hidden buttons", () => {
    const { getByRole, queryByRole } = render(
      <GuacamoleToolbar
        displayRef={display()}
        protocol="rdp"
        settings={{
          ...DEFAULT_TOOLBAR_SETTINGS,
          position: "bottom",
          buttons: { order: ["tab", "esc"], hidden: ["zoom"] },
        }}
      />,
    );
    const toolbar = getByRole("toolbar");
    expect(toolbar.getAttribute("data-position")).toBe("bottom");
    expect(
      queryByRole("button", { name: "remoteDesktop.toolbar.zoomIn" }),
    ).toBeNull();
    const names = Array.from(
      toolbar.querySelectorAll("[data-toolbar-buttons] > button"),
    ).map((button) => button.getAttribute("aria-label"));
    expect(names.slice(0, 2)).toEqual([
      "remoteDesktop.toolbar.tab",
      "remoteDesktop.toolbar.esc",
    ]);
  });

  it("shows the file browser button only with a drive", () => {
    const onToggle = vi.fn();
    const { getByRole, rerender, queryByRole } = render(
      <GuacamoleToolbar
        displayRef={display()}
        protocol="rdp"
        onToggleFileBrowser={onToggle}
      />,
    );
    expect(
      queryByRole("button", { name: "remoteDesktop.toolbar.items.files" }),
    ).toBeNull();
    rerender(
      <GuacamoleToolbar
        displayRef={display()}
        protocol="rdp"
        hasFilesystem
        onToggleFileBrowser={onToggle}
      />,
    );
    fireEvent.click(
      getByRole("button", { name: "remoteDesktop.toolbar.items.files" }),
    );
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("GuacamoleToolbar on a Mac", () => {
  it("swaps Ctrl+Alt+Del and Win+L for the Apple controls on ARD", () => {
    const { queryByRole } = render(
      <GuacamoleToolbar displayRef={display()} protocol="ard" />,
    );
    for (const name of ["forceQuit", "macLock", "spotlight"]) {
      expect(
        queryByRole("button", { name: `remoteDesktop.toolbar.items.${name}` }),
      ).not.toBeNull();
    }
    expect(
      queryByRole("button", { name: "remoteDesktop.toolbar.ctrlAltDel" }),
    ).toBeNull();
    expect(
      queryByRole("button", { name: "remoteDesktop.toolbar.cmdL" }),
    ).toBeNull();
  });

  it("keeps the Apple controls off RDP and VNC", () => {
    for (const protocol of ["rdp", "vnc"] as const) {
      const { queryByRole, unmount } = render(
        <GuacamoleToolbar displayRef={display()} protocol={protocol} />,
      );
      for (const name of ["forceQuit", "macLock", "spotlight"]) {
        expect(
          queryByRole("button", {
            name: `remoteDesktop.toolbar.items.${name}`,
          }),
        ).toBeNull();
      }
      expect(
        queryByRole("button", { name: "remoteDesktop.toolbar.ctrlAltDel" }),
      ).not.toBeNull();
      unmount();
    }
  });

  it("sends the Mac shortcuts", () => {
    const ref = display();
    const sendKey = ref.current!.sendKey as ReturnType<typeof vi.fn>;
    const { getByRole } = render(
      <GuacamoleToolbar displayRef={ref} protocol="ard" />,
    );
    const press = (name: string) => {
      sendKey.mockClear();
      fireEvent.click(
        getByRole("button", { name: `remoteDesktop.toolbar.items.${name}` }),
      );
      return sendKey.mock.calls.map((call) => [call[0], call[1]]);
    };

    // Cmd+Option+Esc: pressed in order, released in reverse.
    expect(press("forceQuit")).toEqual([
      [0xffeb, true],
      [0xffe9, true],
      [0xff1b, true],
      [0xff1b, false],
      [0xffe9, false],
      [0xffeb, false],
    ]);
    expect(press("macLock").map((call) => call[0])).toEqual([
      0xffe3, 0xffeb, 0x0071, 0x0071, 0xffeb, 0xffe3,
    ]);
    expect(press("spotlight").map((call) => call[0])).toEqual([
      0xffeb, 0x0020, 0x0020, 0xffeb,
    ]);
  });

  it("calls Alt Option on ARD only", () => {
    const ard = render(
      <GuacamoleToolbar displayRef={display()} protocol="ard" />,
    );
    expect(
      ard.queryAllByText("remoteDesktop.toolbar.option").length,
    ).toBeGreaterThan(0);
    expect(ard.queryAllByText("remoteDesktop.toolbar.alt")).toHaveLength(0);
    ard.unmount();

    const vnc = render(
      <GuacamoleToolbar displayRef={display()} protocol="vnc" />,
    );
    expect(
      vnc.queryAllByText("remoteDesktop.toolbar.alt").length,
    ).toBeGreaterThan(0);
    expect(vnc.queryAllByText("remoteDesktop.toolbar.option")).toHaveLength(0);
  });
});
