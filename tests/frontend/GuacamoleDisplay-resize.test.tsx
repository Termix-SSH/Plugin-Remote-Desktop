import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// guacd's VNC client segfaults if it gets a display `size` while it is still
// dialing the VNC server, so the resize observer must stay quiet until the
// client reports CONNECTED.
const mocks = vi.hoisted(() => {
  const state = {
    client: null as null | {
      sendSize: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      onstatechange: ((state: number) => void) | null;
    },
    resizeCallback: null as null | (() => void),
  };
  return state;
});

vi.mock("guacamole-common-js", () => {
  class Client {
    sendSize = vi.fn();
    onstatechange: ((state: number) => void) | null = null;
    private element = document.createElement("div");
    constructor() {
      mocks.client = this;
    }
    getDisplay() {
      return {
        getElement: () => this.element,
        getWidth: () => 1280,
        getHeight: () => 720,
        scale: vi.fn(),
        onresize: null,
      };
    }
    connect = vi.fn();
    disconnect() {}
  }
  class Keyboard {
    onkeydown: unknown = null;
    onkeyup: unknown = null;
    reset() {}
  }
  class Mouse {
    static State = class {};
    static Touchscreen = class {};
    static Touchpad = class {};
  }
  const Status = { Code: { SUCCESS: 0 } };
  return {
    default: {
      Client,
      Keyboard,
      Mouse,
      Status,
      WebSocketTunnel: class {},
    },
  };
});

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isElectron: () => false,
  getBasePath: () => "",
  resolveConnectionOrigin: async () => "remote",
}));

import { GuacamoleDisplay } from "../../src/frontend/GuacamoleDisplay";

const RESIZE_DEBOUNCE_MS = 150;

class FakeResizeObserver {
  constructor(callback: () => void) {
    mocks.resizeCallback = callback;
  }
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  mocks.client = null;
  mocks.resizeCallback = null;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1024,
    height: 768,
    top: 0,
    left: 0,
    right: 1024,
    bottom: 768,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderConnectingVncDisplay() {
  render(
    <GuacamoleDisplay
      connectionConfig={{ protocol: "vnc", token: "test-token" }}
      isVisible
    />,
  );
  await vi.waitFor(() => expect(mocks.client).not.toBeNull());
  await vi.waitFor(() => expect(mocks.resizeCallback).not.toBeNull());
  return mocks.client!;
}

async function fireResize() {
  await act(async () => {
    mocks.resizeCallback!();
    await new Promise((resolve) =>
      setTimeout(resolve, RESIZE_DEBOUNCE_MS + 50),
    );
  });
}

describe("GuacamoleDisplay resize", () => {
  it("does not send a size while a VNC session is still connecting", async () => {
    const client = await renderConnectingVncDisplay();

    act(() => client.onstatechange?.(1)); // CONNECTING
    await fireResize();

    expect(client.sendSize).not.toHaveBeenCalled();
  });

  it("sends the first size once the session is connected", async () => {
    const client = await renderConnectingVncDisplay();

    act(() => client.onstatechange?.(3)); // CONNECTED

    expect(client.sendSize).toHaveBeenCalledTimes(1);
  });

  it("resumes sending sizes on resize after the session is connected", async () => {
    const client = await renderConnectingVncDisplay();

    act(() => client.onstatechange?.(3));
    client.sendSize.mockClear();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 1280,
      height: 800,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    await fireResize();

    expect(client.sendSize).toHaveBeenCalledTimes(1);
  });
});

describe("RDP automatic resizing", () => {
  async function connect(
    rdpAutoResize?: boolean,
    protocol: "rdp" | "vnc" = "rdp",
    width?: number,
    height?: number,
  ) {
    mocks.client = null;
    render(
      <GuacamoleDisplay
        connectionConfig={{
          protocol,
          token: "test-token",
          rdpAutoResize,
          width,
          height,
        }}
        isVisible
      />,
    );
    await vi.waitFor(() => expect(mocks.client).not.toBeNull());
    await vi.waitFor(() => expect(mocks.client!.connect).toHaveBeenCalled());
    const client = mocks.client!;
    act(() => client.onstatechange?.(3));
    return client;
  }

  function resizeTo(width: number, height: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width,
      height,
    } as DOMRect);
  }

  it.each([undefined, true])(
    "resizes by default or when enabled (%s)",
    async (setting) => {
      const client = await connect(setting);
      client.sendSize.mockClear();
      resizeTo(1400, 900);
      await fireResize();
      expect(client.sendSize).toHaveBeenCalledWith(1400, 900);
    },
  );

  it("keeps the initial Auto size until a new connection when disabled", async () => {
    const client = await connect(false);
    const query = new URLSearchParams(client.connect.mock.calls[0][0]);
    expect(query.get("width")).toBe("1024");
    expect(query.get("height")).toBe("768");
    expect(client.sendSize).not.toHaveBeenCalled();
    resizeTo(1400, 900);
    await fireResize();
    expect(client.sendSize).not.toHaveBeenCalled();
    cleanup();
    const reconnected = await connect(false);
    const next = new URLSearchParams(reconnected.connect.mock.calls[0][0]);
    expect(next.get("width")).toBe("1400");
    expect(next.get("height")).toBe("900");
  });

  it("does not apply the RDP opt-out to VNC", async () => {
    const client = await connect(false, "vnc");
    client.sendSize.mockClear();
    resizeTo(1400, 900);
    await fireResize();
    expect(client.sendSize).toHaveBeenCalledWith(1400, 900);
  });

  it("keeps an explicitly configured resolution even with resizing enabled", async () => {
    const client = await connect(true, "rdp", 1600, 1000);
    const query = new URLSearchParams(client.connect.mock.calls[0][0]);
    expect(query.get("width")).toBe("1600");
    expect(query.get("height")).toBe("1000");
    resizeTo(1400, 900);
    await fireResize();
    expect(client.sendSize).not.toHaveBeenCalled();
  });
});
