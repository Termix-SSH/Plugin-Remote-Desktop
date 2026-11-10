import { clampGuacamoleZoom } from "./guacamole-zoom.ts";

/** Pure two-finger pinch/pan math for the VNC/ARD display. */

export interface Point {
  x: number;
  y: number;
}

/**
 * How far (CSS px) the finger spread has to change before a two-finger
 * gesture counts as a pinch rather than a pan.
 */
export const PINCH_PX = 8;

export type TwoFingerGesture = "undecided" | "pinch" | "pan";

/** The display's top-left in the scroll container's content coordinates. */
export function displayOffsetInContainer({
  containerRect,
  displayRect,
  scrollLeft,
  scrollTop,
}: {
  containerRect: { left: number; top: number };
  displayRect: { left: number; top: number };
  scrollLeft: number;
  scrollTop: number;
}): Point {
  return {
    x: displayRect.left - containerRect.left + scrollLeft,
    y: displayRect.top - containerRect.top + scrollTop,
  };
}

export function touchDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function touchMidpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Decides what a two-finger move is. A pinch stays a pinch and a pan stays a
 * pan for the rest of the gesture. While the spread is within PINCH_PX and the
 * fingers have not moved together yet, the gesture is left undecided so the
 * browser keeps it.
 */
export function classifyTwoFingerMove({
  startDistance,
  currentDistance,
  current = "undecided",
  moved = true,
}: {
  startDistance: number;
  currentDistance: number;
  /** What the gesture was classified as so far. */
  current?: TwoFingerGesture;
  /** Whether the midpoint has moved since the gesture started. */
  moved?: boolean;
}): TwoFingerGesture {
  if (current === "pinch" || current === "pan") return current;
  if (Math.abs(currentDistance - startDistance) > PINCH_PX) return "pinch";
  return moved ? "pan" : "undecided";
}

/** The zoom for the current finger spread, scaled from the gesture start. */
export function nextPinchZoom(
  startZoom: number,
  startDistance: number,
  currentDistance: number,
): number {
  if (startDistance === 0) return clampGuacamoleZoom(startZoom);
  return clampGuacamoleZoom(startZoom * (currentDistance / startDistance));
}

/**
 * The scroll offsets that keep the content under the fingers in place when
 * the scale changes. `fromX`/`fromY` and `pointX`/`pointY` are relative to
 * the container viewport. Offsets are the display's top-left in content
 * coordinates; they are needed when a smaller framebuffer is flex-centered
 * in the container, and `toOffset` must be measured after applyZoom.
 */
export function scrollAfterZoom({
  scrollLeft,
  scrollTop,
  pointX,
  pointY,
  oldScale,
  newScale,
  fromX = pointX,
  fromY = pointY,
  fromOffsetX = 0,
  fromOffsetY = 0,
  toOffsetX = 0,
  toOffsetY = 0,
}: {
  scrollLeft: number;
  scrollTop: number;
  pointX: number;
  pointY: number;
  oldScale: number;
  newScale: number;
  fromX?: number;
  fromY?: number;
  /** Display origin in content coordinates at the start of the zoom. */
  fromOffsetX?: number;
  fromOffsetY?: number;
  /** Display origin after applyZoom, which can change flex centering. */
  toOffsetX?: number;
  toOffsetY?: number;
}): { scrollLeft: number; scrollTop: number } {
  const ratio = oldScale === 0 ? 1 : newScale / oldScale;
  return {
    scrollLeft: (scrollLeft + fromX - fromOffsetX) * ratio + toOffsetX - pointX,
    scrollTop: (scrollTop + fromY - fromOffsetY) * ratio + toOffsetY - pointY,
  };
}

/**
 * Moves the viewport with the fingers. Not clamped: the browser clamps when
 * the result is assigned to scrollLeft/scrollTop.
 */
export function scrollAfterPan({
  scrollLeft,
  scrollTop,
  dx,
  dy,
}: {
  scrollLeft: number;
  scrollTop: number;
  dx: number;
  dy: number;
}): { scrollLeft: number; scrollTop: number } {
  return { scrollLeft: scrollLeft - dx, scrollTop: scrollTop - dy };
}
