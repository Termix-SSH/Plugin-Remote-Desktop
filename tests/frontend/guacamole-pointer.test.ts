import { describe, expect, it, vi } from "vitest";
import {
  bindPointerInput,
  COMPAT_MOUSE_SUPPRESS_MS,
  createTouchGestureGate,
} from "../../src/frontend/guacamole-pointer.js";
import type { GuacamolePointerState } from "../../src/frontend/guacamole-scroll.js";

function pointer(
  x: number,
  y: number,
  buttons: Partial<
    Pick<GuacamolePointerState, "left" | "middle" | "right" | "up" | "down">
  > = {},
): GuacamolePointerState {
  return {
    x,
    y,
    left: false,
    middle: false,
    right: false,
    up: false,
    down: false,
    ...buttons,
  };
}

const released = (x: number, y: number) => pointer(x, y);

describe("createTouchGestureGate", () => {
  it("forwards a normal single tap unchanged", () => {
    const sent: GuacamolePointerState[] = [];
    const gate = createTouchGestureGate((state) => sent.push(state));
    const down = pointer(10, 20, { left: true });
    const up = pointer(10, 20);

    gate.forward("touch", pointer(10, 20), 0);
    gate.forward("touch", down, 10);
    gate.forward("touch", up, 20);

    expect(sent).toEqual([pointer(10, 20), down, up]);
    expect(sent[1]).toBe(down);
    expect(gate.isSuppressing()).toBe(false);
  });

  it("drops the click a pinch with a stationary first finger ends in", () => {
    const sent: GuacamolePointerState[] = [];
    const gate = createTouchGestureGate((state) => sent.push(state));

    gate.forward("touch", pointer(50, 50), 0);
    gate.beginMultiTouch(100);
    gate.allTouchesEnded(400);
    // The emulator judges only the final first-finger position: a tap.
    gate.forward("touch", pointer(50, 50, { left: true }), 401);
    gate.forward("touch", pointer(50, 50), 402);

    expect(sent).toEqual([pointer(50, 50)]);
  });

  it("drops the long-press right click fired during a held pinch", () => {
    const sent: GuacamolePointerState[] = [];
    const gate = createTouchGestureGate((state) => sent.push(state));

    gate.beginMultiTouch(0);
    gate.forward("touch", pointer(5, 5, { right: true }), 500);
    gate.forward("touch", pointer(5, 5), 500);
    gate.forward("touch", pointer(9, 9), 600);

    expect(sent).toEqual([]);
    expect(gate.isMultiTouchActive()).toBe(true);
  });

  it("releases a held drag exactly once when a second finger arrives", () => {
    const sent: GuacamolePointerState[] = [];
    const gate = createTouchGestureGate((state) => sent.push(state));

    gate.forward("touch", pointer(1, 1, { left: true }), 0);
    gate.forward("touch", pointer(30, 40, { left: true }), 50);
    gate.beginMultiTouch(100);
    gate.beginMultiTouch(150);
    gate.forward("touch", pointer(30, 40), 200);
    gate.allTouchesEnded(300);
    gate.forward("touch", pointer(30, 40), 301);

    const releases = sent.slice(2);
    expect(releases).toEqual([released(30, 40)]);
  });

  it("does not send a release when nothing was held", () => {
    const sent: GuacamolePointerState[] = [];
    const gate = createTouchGestureGate((state) => sent.push(state));

    gate.forward("touch", pointer(3, 4), 0);
    gate.beginMultiTouch(10);

    expect(sent).toEqual([pointer(3, 4)]);
  });

  it("drops compatibility mouse presses only inside the window after the gesture", () => {
    const sent: GuacamolePointerState[] = [];
    const gate = createTouchGestureGate((state) => sent.push(state));

    gate.beginMultiTouch(0);
    gate.allTouchesEnded(1000);
    gate.forward("mouse", pointer(7, 7, { left: true }), 1010);
    gate.forward("mouse", pointer(7, 7), 1020);
    gate.forward(
      "mouse",
      pointer(8, 8, { left: true }),
      1000 + COMPAT_MOUSE_SUPPRESS_MS - 1,
    );
    expect(sent).toEqual([pointer(7, 7)]);

    gate.forward(
      "mouse",
      pointer(9, 9, { left: true }),
      1000 + COMPAT_MOUSE_SUPPRESS_MS,
    );
    expect(sent).toEqual([pointer(7, 7), pointer(9, 9, { left: true })]);
  });

  it("re-enables touch taps on a fresh single-finger touch", () => {
    const sent: GuacamolePointerState[] = [];
    const gate = createTouchGestureGate((state) => sent.push(state));

    gate.beginMultiTouch(0);
    gate.freshTouchStart(); // Fingers still down: stays suppressed.
    expect(gate.isSuppressing()).toBe(true);
    gate.allTouchesEnded(100);
    gate.forward("touch", pointer(2, 2, { left: true }), 5000);
    // The emulator's delayed release of that click.
    gate.forward("touch", pointer(2, 2), 5250);
    expect(sent).toEqual([]);

    gate.freshTouchStart();
    expect(gate.isSuppressing()).toBe(false);
    gate.forward("touch", pointer(2, 2, { left: true }), 5301);
    gate.forward("touch", pointer(2, 2), 5302);
    expect(sent).toEqual([pointer(2, 2, { left: true }), pointer(2, 2)]);
  });

  it("never drags with a button the emulator held across a gesture", () => {
    const sent: GuacamolePointerState[] = [];
    const gate = createTouchGestureGate((state) => sent.push(state));

    gate.beginMultiTouch(0);
    gate.allTouchesEnded(100);
    // The pinch's click; its delayed release is cancelled by the next touch.
    gate.forward("touch", pointer(50, 50, { left: true }), 101);
    gate.freshTouchStart();
    expect(gate.isSuppressing()).toBe(false);

    gate.forward("touch", pointer(120, 90, { left: true }), 150);
    gate.forward("touch", pointer(200, 200, { left: true }), 160);
    expect(sent).toEqual([]);

    gate.forward("touch", pointer(200, 200), 170);
    gate.forward("touch", pointer(210, 210, { left: true }), 400);
    gate.forward("touch", pointer(210, 210), 410);
    expect(sent).toEqual([
      pointer(200, 200),
      pointer(210, 210, { left: true }),
      pointer(210, 210),
    ]);
  });

  it("forwards a press that starts a fresh touch when nothing was held", () => {
    const sent: GuacamolePointerState[] = [];
    const gate = createTouchGestureGate((state) => sent.push(state));

    gate.beginMultiTouch(0);
    gate.allTouchesEnded(100);
    gate.freshTouchStart();
    gate.forward("touch", pointer(9, 9, { left: true }), 200);

    expect(sent).toEqual([pointer(9, 9, { left: true })]);
  });

  it("keeps a double-tap drag outside a gesture", () => {
    const sent: GuacamolePointerState[] = [];
    const gate = createTouchGestureGate((state) => sent.push(state));

    gate.freshTouchStart();
    gate.forward("touch", pointer(5, 5, { left: true }), 0);
    // Second tap within clickTimingThreshold keeps the button down.
    gate.freshTouchStart();
    gate.forward("touch", pointer(40, 40, { left: true }), 100);
    gate.forward("touch", pointer(40, 40), 200);

    expect(sent).toEqual([
      pointer(5, 5, { left: true }),
      pointer(40, 40, { left: true }),
      pointer(40, 40),
    ]);
  });
});

function listenedEvents(): {
  element: HTMLElement;
  events: () => string[];
} {
  const element = document.createElement("div");
  const seen: string[] = [];
  const original = element.addEventListener.bind(element);
  element.addEventListener = ((type: string, ...rest: unknown[]) => {
    seen.push(type);
    return (original as (t: string, ...r: unknown[]) => void)(type, ...rest);
  }) as typeof element.addEventListener;
  return { element, events: () => seen };
}

describe("bindPointerInput", () => {
  // A touchscreen laptop reports maxTouchPoints > 0 and still has a mouse.
  // Binding only the touch emulator left the pointer dead on those machines.
  it.each([
    ["no touch mode", null],
    ["touchscreen", "touchscreen" as const],
    ["touchpad", "touchpad" as const],
  ])("keeps the physical pointer bound with %s", (_label, touchMode) => {
    const { element, events } = listenedEvents();

    bindPointerInput(element, touchMode, vi.fn());

    expect(events()).toContain("mousedown");
    expect(events()).toContain("mousemove");
    expect(events()).toContain("mouseup");
  });

  it("adds touch listeners only when a touch mode is selected", () => {
    const withoutTouch = listenedEvents();
    bindPointerInput(withoutTouch.element, null, vi.fn());
    const plainTouchCount = withoutTouch
      .events()
      .filter((e) => e.startsWith("touch")).length;

    const withTouch = listenedEvents();
    bindPointerInput(withTouch.element, "touchscreen", vi.fn());
    const touchModeCount = withTouch
      .events()
      .filter((e) => e.startsWith("touch")).length;

    expect(touchModeCount).toBeGreaterThan(plainTouchCount);
  });

  it("does not forward a wheel flood as individual remote scroll clicks", () => {
    vi.useFakeTimers();
    const element = document.createElement("div");
    const onState = vi.fn();
    const dispose = bindPointerInput(element, null, onState);

    for (let i = 0; i < 30; i++) {
      element.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: 120,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    const presses = onState.mock.calls.filter(
      ([state]) => state.up === true || state.down === true,
    );
    expect(presses.length).toBeLessThanOrEqual(2);

    vi.advanceTimersByTime(40);
    const laterPresses = onState.mock.calls.filter(
      ([state]) => state.up === true || state.down === true,
    );
    expect(laterPresses.length).toBeLessThanOrEqual(4);

    dispose();
    vi.useRealTimers();
  });

  it("routes a supplied gate's releases to onState", () => {
    const element = document.createElement("div");
    const onState = vi.fn();
    const gate = createTouchGestureGate();
    const dispose = bindPointerInput(element, "touchpad", onState, gate);

    gate.forward("touch", pointer(4, 6, { left: true }));
    gate.beginMultiTouch();

    expect(onState).toHaveBeenCalledTimes(2);
    expect(onState.mock.calls[1][0]).toMatchObject(released(4, 6));
    dispose();
  });

  it("ends touch suppression on a fresh single-finger touchstart", () => {
    const element = document.createElement("div");
    const gate = createTouchGestureGate();
    const dispose = bindPointerInput(element, "touchpad", vi.fn(), gate);
    const touchStart = (count: number) => {
      const event = new Event("touchstart", {
        bubbles: true,
        cancelable: true,
      });
      const touches = Array.from({ length: count }, (_, i) => ({
        identifier: i,
        clientX: 0,
        clientY: 0,
        target: element,
      }));
      Object.defineProperty(event, "touches", { value: touches });
      Object.defineProperty(event, "changedTouches", { value: touches });
      element.dispatchEvent(event);
    };

    gate.beginMultiTouch();
    touchStart(1);
    expect(gate.isSuppressing()).toBe(true);

    gate.allTouchesEnded();
    touchStart(2);
    expect(gate.isSuppressing()).toBe(true);
    touchStart(1);
    expect(gate.isSuppressing()).toBe(false);

    dispose();
    gate.beginMultiTouch();
    gate.allTouchesEnded();
    touchStart(1);
    expect(gate.isSuppressing()).toBe(true);
  });

  describe("with the real touchscreen emulator", () => {
    type Point = { id: number; x: number; y: number };

    const dispatchTouch = (
      target: HTMLElement,
      type: "touchstart" | "touchmove" | "touchend",
      touches: Point[],
      changed: Point[],
    ) => {
      const toList = (points: Point[]) =>
        points.map((p) => ({
          identifier: p.id,
          clientX: p.x,
          clientY: p.y,
          target,
        }));
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: toList(touches) });
      Object.defineProperty(event, "changedTouches", {
        value: toList(changed),
      });
      target.dispatchEvent(event);
    };

    // The emulator hands out its own mutable currentState: copy on receipt.
    const pick = (state: GuacamolePointerState) =>
      pointer(state.x, state.y, {
        left: state.left,
        middle: state.middle,
        right: state.right,
        up: state.up,
        down: state.down,
      });
    const recorder = () => {
      const states: GuacamolePointerState[] = [];
      const onState = (state: GuacamolePointerState) => {
        states.push(pick(state));
      };
      return { states, onState };
    };

    // Like GuacamoleDisplay's capture-phase gesture handler, the container
    // keeps every multi-finger touchstart/touchend from the emulator, so it
    // only ever sees the first finger go down and the last one lift.
    const mountInGestureContainer = () => {
      const container = document.createElement("div");
      const element = document.createElement("div");
      container.appendChild(element);
      document.body.appendChild(container);
      const swallow = (event: Event) => {
        const { type, touches } = event as TouchEvent;
        if (
          (type === "touchstart" && touches.length > 1) ||
          (type === "touchend" && touches.length > 0)
        ) {
          event.stopPropagation();
        }
      };
      container.addEventListener("touchstart", swallow, true);
      container.addEventListener("touchend", swallow, true);
      return { element, remove: () => container.remove() };
    };

    it("does not drag with the click a pinch ended in", () => {
      vi.useFakeTimers();
      const { element, remove } = mountInGestureContainer();
      const { states, onState } = recorder();
      const gate = createTouchGestureGate();
      const emitted: GuacamolePointerState[] = [];
      const forward = gate.forward;
      gate.forward = (source, state, now) => {
        if (source === "touch") emitted.push(pick(state));
        forward(source, state, now);
      };
      const dispose = bindPointerInput(element, "touchscreen", onState, gate);
      try {
        const first = { id: 0, x: 50, y: 50 };
        const second = { id: 1, x: 150, y: 150 };
        dispatchTouch(element, "touchstart", [first], [first]);
        dispatchTouch(element, "touchstart", [first, second], [second]);
        gate.beginMultiTouch();
        dispatchTouch(element, "touchend", [first], [second]);
        dispatchTouch(element, "touchend", [], [first]);
        gate.allTouchesEnded();

        // The real emulator ended the gesture in a click whose release is
        // still pending: the leftover press this test is about.
        expect(emitted).toContainEqual(pointer(50, 50, { left: true }));

        // Inside clickTimingThreshold (no timers advanced).
        const fresh = { id: 2, x: 60, y: 60 };
        dispatchTouch(element, "touchstart", [fresh], [fresh]);
        const moved = { id: 2, x: 200, y: 200 };
        dispatchTouch(element, "touchmove", [moved], [moved]);
        dispatchTouch(element, "touchend", [], [moved]);

        expect(states.filter((s) => s.left)).toEqual([]);

        // The next tap still clicks.
        const tap = { id: 3, x: 80, y: 80 };
        dispatchTouch(element, "touchstart", [tap], [tap]);
        dispatchTouch(element, "touchend", [], [tap]);
        expect(states[states.length - 1]).toEqual(
          pointer(80, 80, { left: true }),
        );
      } finally {
        dispose();
        remove();
        vi.useRealTimers();
      }
    });

    it("still forwards a plain tap as a left press", () => {
      vi.useFakeTimers();
      const { element, remove } = mountInGestureContainer();
      const { states, onState } = recorder();
      const dispose = bindPointerInput(element, "touchscreen", onState);
      try {
        const finger = { id: 0, x: 50, y: 50 };
        dispatchTouch(element, "touchstart", [finger], [finger]);
        dispatchTouch(element, "touchend", [], [finger]);

        expect(states).toContainEqual(pointer(50, 50, { left: true }));
      } finally {
        dispose();
        remove();
        vi.useRealTimers();
      }
    });
  });
});
