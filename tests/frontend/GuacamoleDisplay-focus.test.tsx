import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

// The Touchscreen emulator releases a tap from a 250 ms timer. If that delayed
// release refocused the display, it would steal focus from the soft-keyboard
// textarea opened meanwhile and dismiss the phone keyboard.
const mocks = vi.hoisted(() => {
  const state = {
    client: null as null | {
      sendSize: ReturnType<typeof vi.fn>;
      sendMouseState: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      element: HTMLDivElement;
      onstatechange: ((state: number) => void) | null;
    },
    resizeCallback: null as null | (() => void),
  };
  return state;
});

vi.mock("guacamole-common-js", async (importOriginal) => {
  const { default: original } =
    await importOriginal<typeof import("guacamole-common-js")>();
  class Client {
    sendSize = vi.fn();
    sendMouseState = vi.fn();
    sendKeyEvent = vi.fn();
    createClipboardStream = vi.fn(() => ({
      sendBlob: vi.fn(),
      sendEnd: vi.fn(),
    }));
    disconnect = vi.fn();
    onstatechange: ((state: number) => void) | null = null;
    element = document.createElement("div");
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
  }
  class Keyboard {
    pressed: Record<number, boolean> = {};
    onkeydown: unknown = null;
    onkeyup: unknown = null;
    reset() {}
  }
  const Status = { Code: { SUCCESS: 0 } };
  return {
    default: {
      Client,
      Keyboard,
      StringWriter: original.StringWriter,
      Mouse: original.Mouse,
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

import {
  GuacamoleDisplay,
  type GuacamoleDisplayHandle,
} from "../../src/frontend/GuacamoleDisplay";

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
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderConnectedDisplay() {
  const ref = createRef<GuacamoleDisplayHandle>();
  render(
    <GuacamoleDisplay
      connectionConfig={{ protocol: "vnc", token: "test-token" }}
      isVisible
      touchMode="touchscreen"
      ref={ref}
    />,
  );
  await vi.waitFor(() => expect(mocks.client).not.toBeNull());
  await vi.waitFor(() => expect(mocks.client!.connect).toHaveBeenCalled());
  const client = mocks.client!;
  act(() => client.onstatechange?.(3)); // CONNECTED
  return { client, ref };
}

function dispatchTouch(
  target: HTMLElement,
  type: "touchstart" | "touchend",
  x: number,
  y: number,
) {
  const point = [{ identifier: 0, clientX: x, clientY: y, target }];
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: type === "touchend" ? [] : point,
  });
  Object.defineProperty(event, "changedTouches", { value: point });
  act(() => {
    target.dispatchEvent(event);
  });
}

type FakeTouch = {
  identifier: number;
  clientX: number;
  clientY: number;
  target: EventTarget;
};

function finger(
  identifier: number,
  target: EventTarget,
  x: number,
  y: number,
): FakeTouch {
  return { identifier, clientX: x, clientY: y, target };
}

function dispatchTouches(
  target: HTMLElement,
  type: "touchstart" | "touchmove" | "touchend",
  touches: FakeTouch[],
  changed: FakeTouch[],
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: touches });
  Object.defineProperty(event, "changedTouches", { value: changed });
  act(() => {
    target.dispatchEvent(event);
  });
}

function tap(display: HTMLElement) {
  const point = finger(9, display, 100, 100);
  dispatchTouches(display, "touchstart", [point], [point]);
  dispatchTouches(display, "touchend", [], [point]);
}

describe("GuacamoleDisplay two-finger gesture ownership", () => {
  it("ignores a finger resting outside the display", async () => {
    const { client } = await renderConnectedDisplay();
    const display = client.element;
    const toolbar = document.createElement("div");
    document.body.appendChild(toolbar);
    try {
      const a = finger(0, toolbar, 10, 10);
      const b = finger(1, display, 200, 200);
      const bMoved = finger(1, display, 240, 240);
      dispatchTouches(display, "touchstart", [a, b], [b]);
      dispatchTouches(display, "touchmove", [a, bMoved], [bMoved]);
      dispatchTouches(display, "touchend", [a], [bMoved]);
      dispatchTouches(toolbar, "touchend", [], [a]);

      client.sendMouseState.mockClear();
      tap(display);

      expect(client.sendMouseState).toHaveBeenCalledWith(
        expect.objectContaining({ left: true }),
      );
    } finally {
      toolbar.remove();
    }
  });

  it("still clicks after a normal two-finger gesture on the display", async () => {
    const { client } = await renderConnectedDisplay();
    const display = client.element;
    const a = finger(0, display, 100, 100);
    const b = finger(1, display, 200, 200);
    const aMoved = finger(0, display, 140, 140);
    const bMoved = finger(1, display, 240, 240);
    dispatchTouches(display, "touchstart", [a], [a]);
    dispatchTouches(display, "touchstart", [a, b], [b]);
    dispatchTouches(display, "touchmove", [aMoved, bMoved], [aMoved, bMoved]);
    dispatchTouches(display, "touchend", [aMoved], [bMoved]);
    dispatchTouches(display, "touchend", [], [aMoved]);

    client.sendMouseState.mockClear();
    tap(display);

    expect(client.sendMouseState).toHaveBeenCalledWith(
      expect.objectContaining({ left: true }),
    );
  });
});

describe("GuacamoleDisplay focus", () => {
  it("keeps the soft keyboard focused through a tap's delayed release", async () => {
    const { client, ref } = await renderConnectedDisplay();
    const display = client.element;
    // The paste catcher is a textarea too; pick the soft keyboard by label.
    const textarea = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="remoteDesktop.toolbar.showKeyboard"]',
    )!;
    expect(textarea).not.toBeNull();
    vi.useFakeTimers();

    dispatchTouch(display, "touchstart", 100, 100);
    dispatchTouch(display, "touchend", 100, 100);

    expect(document.activeElement).toBe(display);
    expect(client.sendMouseState).toHaveBeenCalledWith(
      expect.objectContaining({ left: true }),
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => {
      ref.current!.openSoftKeyboard();
    });
    expect(document.activeElement).toBe(textarea);

    client.sendMouseState.mockClear();
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(client.sendMouseState).toHaveBeenCalledWith(
      expect.objectContaining({ left: false }),
    );
    expect(document.activeElement).toBe(textarea);
  });

  it("focuses the display on a real mousedown", async () => {
    const { client } = await renderConnectedDisplay();
    const display = client.element;
    expect(document.activeElement).not.toBe(display);

    act(() => {
      display.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });

    expect(document.activeElement).toBe(display);
  });

  it("focuses the display on a forwarded physical mouse move", async () => {
    const { client } = await renderConnectedDisplay();
    const display = client.element;
    expect(document.activeElement).not.toBe(display);

    act(() => {
      display.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 200,
          clientY: 150,
        }),
      );
    });

    expect(client.sendMouseState).toHaveBeenCalled();
    expect(document.activeElement).toBe(display);
  });
});
