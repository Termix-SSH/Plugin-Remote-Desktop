import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import GuacamoleApp from "../../src/frontend/GuacamoleApp";

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  connect: undefined as undefined | (() => Promise<void>),
  retry: vi.fn(),
  token: vi.fn(),
  reset: vi.fn(),
  addLog: vi.fn(),
  clearLogs: vi.fn(),
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHost: () => ({
    id: 1,
    name: "RDP host",
    ip: "192.0.2.1",
    pluginSettings: { "remote-desktop": state.settings },
  }),
  useTranslation: () => ({ t: (key: string) => key }),
  useTabs: () => ({}),
  logActivity: async () => {},
  useConnectionRetry: ({ connect }: { connect: () => Promise<void> }) => {
    state.connect = connect;
    return {
      retryNow: state.retry,
      reset: state.reset,
      markConnected: vi.fn(),
      markFailed: vi.fn(),
    };
  },
}));
vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isElectron: () => false,
  ConnectionLogProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  useConnectionLog: () => ({
    addLog: state.addLog,
    clearLogs: state.clearLogs,
  }),
  ConnectionScreen: ({
    status,
    onManualRetry,
  }: {
    status: string;
    onManualRetry?: () => void;
  }) => <button onClick={onManualRetry}>{status}</button>,
}));
vi.mock("../../src/frontend/guacamole-api", () => ({
  getGuacdStatus: async () => ({
    enabled: true,
    guacd: { status: "connected" },
  }),
  getGuacamoleTokenFromHost: state.token,
  getGuacamoleToken: vi.fn(),
  remoteByDefault: async () => false,
}));
vi.mock("../../src/frontend/GuacamoleDisplay.tsx", () => ({
  GuacamoleDisplay: ({
    onLost,
    onConnect,
  }: {
    onLost: () => void;
    onConnect: () => void;
  }) => (
    <>
      <button onClick={onConnect}>Connected</button>
      <button onClick={onLost}>Lose session</button>
    </>
  ),
}));
vi.mock("../../src/frontend/GuacamoleToolbar.tsx", () => ({
  GuacamoleToolbar: () => null,
}));
vi.mock("../../src/frontend/GuacamoleFileBrowser.tsx", () => ({
  GuacamoleFileBrowser: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = { enableRdp: true };
  state.token.mockResolvedValue({ token: "test-token" });
  state.retry.mockImplementation(() => {
    void state.connect?.();
  });
});
afterEach(cleanup);

async function connect(protocol: "rdp" | "vnc" = "rdp") {
  render(<GuacamoleApp hostId="1" protocol={protocol} />);
  fireEvent.click(await screen.findByText("Connected"));
  state.retry.mockClear();
}

describe("RDP automatic reconnection", () => {
  it.each([undefined, true])(
    "preserves automatic reconnect when the setting is %s",
    async (value) => {
      state.settings.rdpAutoReconnect = value;
      await connect();
      fireEvent.click(screen.getByText("Lose session"));
      await waitFor(() => expect(state.retry).toHaveBeenCalledTimes(1));
    },
  );

  it("stays disconnected when disabled, but allows a manual retry", async () => {
    state.settings.rdpAutoReconnect = false;
    await connect();
    fireEvent.click(screen.getByText("Lose session"));
    const retry = await screen.findByText("disconnected");
    expect(state.retry).not.toHaveBeenCalled();
    expect(state.token).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await waitFor(() => expect(state.token).toHaveBeenCalledTimes(2));
    expect(state.retry).toHaveBeenCalledTimes(1);
  });

  it("does not disable reconnection for another protocol on the same host", async () => {
    state.settings.rdpAutoReconnect = false;
    await connect("vnc");
    fireEvent.click(screen.getByText("Lose session"));
    await waitFor(() => expect(state.retry).toHaveBeenCalledTimes(1));
  });
});
