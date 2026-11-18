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
  /** Send one all-up state if the remote may still hold a button. */
  releaseButtons(): void;
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

function snapshot(state: GuacamolePointerState): GuacamolePointerState {
  return {
    x: state.x,
    y: state.y,
    left: state.left,
    middle: state.middle,
    right: state.right,
    up: state.up,
    down: state.down,
  };
}

/**
 * Guacamole's touch emulators judge a gesture from the first finger only: a
 * pinch whose first finger stayed still ends in a left click, and the
 * long-press timer can fire a right click during a held pinch. Rather than
 * rely on emulator internals, drop every emulator state from the moment a
 * multi-touch gesture is claimed until the next fresh single-finger touch.
 *
 * Rule: a finger left over after a claimed gesture never presses a button on
 * the remote. The click a pinch ends in is a press plus a delayed release,
 * and a touchstart inside that delay cancels the release, so the emulator can
 * still hold a button the remote never saw when touches are re-enabled.
 * bindPointerInput retires the emulator before calling freshTouchStart(); as a
 * second line of defence the gate records every emulator state, including
 * dropped ones, and if the emulator holds a click button the remote never saw
 * pressed when touches are re-enabled, it keeps dropping touch states until
 * one has every click button released. That state and everything after it
 * (such as a real new press) are forwarded. The emulator's report is used
 * rather than the first state after re-enabling because a genuine tap can
 * start with a press when the pointer has not moved.
 */
export function createTouchGestureGate(
  onState?: (state: GuacamolePointerState) => void,
): TouchGestureGate {
  let sink = onState ?? null;
  let active = false;
  let suppressTouch = false;
  let mouseBlockUntil = 0;
  /** Last state actually delivered to the sink, i.e. what the remote saw. */
  let last: GuacamolePointerState | null = null;
  /** Last state the touch emulator reported, forwarded or dropped. */
  let emulator: GuacamolePointerState | null = null;
  /** Dropping a button the emulator held across a claimed gesture. */
  let dropStaleTouch = false;

  const send = (state: GuacamolePointerState) => {
    last = snapshot(state);
    sink?.(state);
  };

  const holdsUnseenClickButton = (state: GuacamolePointerState) =>
    (state.left && !last?.left) ||
    (state.middle && !last?.middle) ||
    (state.right && !last?.right);

  const releaseButtons = () => {
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
  };

  return {
    forward(source, state, now = Date.now()) {
      if (source === "touch") {
        emulator = snapshot(state);
        if (suppressTouch) return;
        if (dropStaleTouch) {
          if (hasClickButton(state)) return;
          dropStaleTouch = false;
        }
      } else if (hasClickButton(state) && (active || now < mouseBlockUntil)) {
        return;
      }
      send(state);
    },
    beginMultiTouch() {
      active = true;
      suppressTouch = true;
      dropStaleTouch = false;
      releaseButtons();
    },
    allTouchesEnded(now = Date.now()) {
      active = false;
      suppressTouch = true;
      mouseBlockUntil = now + COMPAT_MOUSE_SUPPRESS_MS;
    },
    freshTouchStart() {
      if (active) return;
      if (suppressTouch && emulator && holdsUnseenClickButton(emulator)) {
        dropStaleTouch = true;
      }
      suppressTouch = false;
    },
    releaseButtons,
    isSuppressing: () => suppressTouch,
    isMultiTouchActive: () => active,
    setSink(next) {
      sink = next;
    },
  };
}

type TouchEmulator = Guacamole.Mouse.Touchscreen | Guacamole.Mouse.Touchpad;

/**
 * A stand-in element for one touch emulator. It records the listeners the
 * emulator adds instead of attaching them to the page, so a retired emulator
 * never sees another touch event, and it delegates the layout members the
 * emulators and Guacamole.Position.fromClientPosition read to the real
 * element.
 */
function createEmulatorHost(element: HTMLElement): {
  host: HTMLElement;
  dispatch: (event: Event) => void;
} {
  const listeners: {
    type: string;
    listener: EventListenerOrEventListenerObject;
  }[] = [];
  const host = {
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
    ) {
      if (listener) listeners.push({ type, listener });
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
    ) {
      const index = listeners.findIndex(
        (l) => l.type === type && l.listener === listener,
      );
      if (index >= 0) listeners.splice(index, 1);
    },
    get offsetLeft() {
      return element.offsetLeft;
    },
    get offsetTop() {
      return element.offsetTop;
    },
    get offsetParent() {
      return element.offsetParent;
    },
    get offsetWidth() {
      return element.offsetWidth;
    },
    get offsetHeight() {
      return element.offsetHeight;
    },
    getBoundingClientRect: () => element.getBoundingClientRect(),
  };
  return {
    host: host as unknown as HTMLElement,
    dispatch(event) {
      for (const { type, listener } of [...listeners]) {
        if (type !== event.type) continue;
        if (typeof listener === "function") listener.call(element, event);
        else listener.handleEvent(event);
      }
    },
  };
}

/**
 * Layers a Guacamole touch emulator on the element, feeding its states to the
 * gate.
 *
 * The emulators keep private timers and gesture flags that reset() does not
 * clear: after a quick pinch the Touchpad stays mid-gesture and measures the
 * next touch's first move from the pinch's finger (a jump of hundreds of
 * pixels), and the Touchscreen has no touchcancel listener, so a cancelled
 * touch's long-press timer later right-clicks. So instead of resetting it, the
 * emulator is retired and replaced by a fresh one when touches are re-enabled
 * after a claimed gesture and when every touch is cancelled. Touch events
 * reach only the current emulator, and states from a retired one (its stale
 * timers) are dropped forever.
 */
function bindTouchEmulator(
  element: HTMLElement,
  touchMode: GuacamoleTouchMode,
  gate: TouchGestureGate,
): () => void {
  type Instance = {
    emulator: TouchEmulator;
    dispatch: (event: Event) => void;
  };
  let current: Instance | null = null;

  const create = (previous?: TouchEmulator) => {
    const { host, dispatch } = createEmulatorHost(element);
    const emulator =
      touchMode === "touchscreen"
        ? new Guacamole.Mouse.Touchscreen(host)
        : new Guacamole.Mouse.Touchpad(host);
    if (previous) {
      // The Touchpad moves relative to its own state: keep the cursor put.
      emulator.currentState.x = previous.currentState.x;
      emulator.currentState.y = previous.currentState.y;
    }
    const instance: Instance = { emulator, dispatch };
    emulator.onEach(["mousedown", "mousemove", "mouseup"], (event) => {
      if (current === instance) gate.forward("touch", event.state);
    });
    current = instance;
  };

  const retire = () => {
    if (!current) return;
    const previous = current.emulator;
    // Report the old emulator's buttons as released while it is still
    // current, so the gate does not take a held button for a stale press on
    // the fresh emulator (the gate drops this while it is suppressing).
    previous.reset();
    create(previous);
  };

  create();

  // Capture phase, so these run before the emulator sees the event.
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1 || gate.isMultiTouchActive()) return;
    // The click a claimed gesture ended in may still be pending, with the
    // emulator mid-gesture: start the fresh touch on a fresh emulator.
    if (gate.isSuppressing()) retire();
    gate.freshTouchStart();
  };
  const onTouchCancel = (event: TouchEvent) => {
    if (event.touches.length !== 0) return;
    retire();
    gate.releaseButtons();
  };
  const forward = (event: Event) => current?.dispatch(event);
  const touchTypes = ["touchstart", "touchmove", "touchend"] as const;

  const capture = { capture: true, passive: true };
  element.addEventListener("touchstart", onTouchStart, capture);
  element.addEventListener("touchcancel", onTouchCancel, capture);
  for (const type of touchTypes) element.addEventListener(type, forward);

  return () => {
    element.removeEventListener("touchstart", onTouchStart, true);
    element.removeEventListener("touchcancel", onTouchCancel, true);
    for (const type of touchTypes) element.removeEventListener(type, forward);
    current = null;
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

  const disposeTouch =
    touchMode === "touchscreen" || touchMode === "touchpad"
      ? bindTouchEmulator(element, touchMode, gate)
      : null;

  return () => {
    disposeTouch?.();
    gate.setSink(null);
    coalescer.dispose();
  };
}
