import Guacamole from "guacamole-common-js";
import {
  createScrollCoalescer,
  isScrollButtonState,
  type GuacamolePointerState,
} from "./guacamole-scroll.js";

export type GuacamoleTouchMode = "touchscreen" | "touchpad";

export type PointerSource = "touch" | "mouse";

/**
 * How long after a claimed multi-touch gesture ends button presses from the
 * physical-mouse path are dropped. Browsers may synthesize a compatibility
 * mousedown/mouseup/click after the touch sequence.
 */
export const COMPAT_MOUSE_SUPPRESS_MS = 800;

export interface TouchGestureGate {
  /** Forward a state from the touch emulators ("touch") or Guacamole.Mouse. */
  forward(
    source: PointerSource,
    state: GuacamolePointerState,
    now?: number,
  ): void;
  /** A two-finger gesture (pan/pinch/undecided) was claimed. */
  beginMultiTouch(now?: number): void;
  /** The last finger of a claimed gesture lifted. */
  allTouchesEnded(now?: number): void;
  /** A new single-finger touch began after every finger was up. */
  freshTouchStart(): void;
  isSuppressing(): boolean;
  isMultiTouchActive(): boolean;
  /** Where forwarded states go. bindPointerInput installs its own sink. */
  setSink(sink: ((state: GuacamolePointerState) => void) | null): void;
}

function hasAnyButton(state: GuacamolePointerState): boolean {
  return state.left || state.middle || state.right || state.up || state.down;
}

function hasClickButton(state: GuacamolePointerState): boolean {
  return state.left || state.middle || state.right;
}

/**
 * Guacamole's touch emulators judge a gesture from the first finger only: a
 * pinch whose first finger stayed still ends in a left click, and the
 * long-press timer can fire a right click during a held pinch. Rather than
 * rely on emulator internals, drop every emulator state from the moment a
 * multi-touch gesture is claimed until the next fresh single-finger touch.
 */
export function createTouchGestureGate(
  onState?: (state: GuacamolePointerState) => void,
): TouchGestureGate {
  let sink = onState ?? null;
  let active = false;
  let suppressTouch = false;
  let mouseBlockUntil = 0;
  let last: GuacamolePointerState | null = null;

  const send = (state: GuacamolePointerState) => {
    last = {
      x: state.x,
      y: state.y,
      left: state.left,
      middle: state.middle,
      right: state.right,
      up: state.up,
      down: state.down,
    };
    sink?.(state);
  };

  return {
    forward(source, state, now = Date.now()) {
      if (source === "touch") {
        if (suppressTouch) return;
      } else if (hasClickButton(state) && (active || now < mouseBlockUntil)) {
        return;
      }
      send(state);
    },
    beginMultiTouch() {
      active = true;
      suppressTouch = true;
      if (last && hasAnyButton(last)) {
        send({
          x: last.x,
          y: last.y,
          left: false,
          middle: false,
          right: false,
          up: false,
          down: false,
        });
      }
    },
    allTouchesEnded(now = Date.now()) {
      active = false;
      suppressTouch = true;
      mouseBlockUntil = now + COMPAT_MOUSE_SUPPRESS_MS;
    },
    freshTouchStart() {
      if (active) return;
      suppressTouch = false;
    },
    isSuppressing: () => suppressTouch,
    isMultiTouchActive: () => active,
    setSink(next) {
      sink = next;
    },
  };
}

/**
 * Guacamole.Mouse listens for mousedown/mousemove/mouseup; the Touchscreen and
 * Touchpad emulators listen only for touch events. The two sets do not overlap,
 * so binding one instead of the other leaves that input dead.
 *
 * A touch-capable device is not a device without a pointer: laptops with a
 * touchscreen report maxTouchPoints > 0 and are still driven by a mouse. The
 * physical pointer is therefore always bound, and a touch emulator is layered
 * on top when one is selected.
 *
 * Every state passes through a TouchGestureGate before the scroll coalescer;
 * the gate's sink is replaced with this binding's handler.
 */
export function bindPointerInput(
  element: HTMLElement,
  touchMode: GuacamoleTouchMode | null | undefined,
  onState: (state: Guacamole.Mouse.State) => void,
  gate: TouchGestureGate = createTouchGestureGate(),
): () => void {
  const coalescer = createScrollCoalescer((state) => {
    onState(state as Guacamole.Mouse.State);
  });
  let expectingScrollRelease = false;

  const handleState = (state: GuacamolePointerState) => {
    coalescer.notePointer(state);
    if (isScrollButtonState(state)) {
      coalescer.ingestClick(state.down ? 1 : -1);
      expectingScrollRelease = true;
      return;
    }
    if (
      expectingScrollRelease &&
      !state.left &&
      !state.middle &&
      !state.right
    ) {
      expectingScrollRelease = false;
      return;
    }
    expectingScrollRelease = false;
    onState(state as Guacamole.Mouse.State);
  };
  gate.setSink(handleState);

  const mouse = new Guacamole.Mouse(element);
  mouse.onmousedown =
    mouse.onmouseup =
    mouse.onmousemove =
      (state) => gate.forward("mouse", state);

  let removeTouchStart: (() => void) | null = null;
  if (touchMode === "touchscreen" || touchMode === "touchpad") {
    const emulator =
      touchMode === "touchscreen"
        ? new Guacamole.Mouse.Touchscreen(element)
        : new Guacamole.Mouse.Touchpad(element);
    emulator.onEach(["mousedown", "mousemove", "mouseup"], (event) =>
      gate.forward("touch", event.state),
    );
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1 && !gate.isMultiTouchActive()) {
        gate.freshTouchStart();
      }
    };
    element.addEventListener("touchstart", onTouchStart, {
      capture: true,
      passive: true,
    });
    removeTouchStart = () =>
      element.removeEventListener("touchstart", onTouchStart, true);
  }

  return () => {
    removeTouchStart?.();
    gate.setSink(null);
    coalescer.dispose();
  };
}
