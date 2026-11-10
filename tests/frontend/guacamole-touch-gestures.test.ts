import { describe, expect, it } from "vitest";
import {
  PINCH_PX,
  displayOffsetInContainer,
  classifyTwoFingerMove,
  nextPinchZoom,
  scrollAfterPan,
  scrollAfterZoom,
  touchDistance,
  touchMidpoint,
} from "../../src/frontend/guacamole-touch-gestures.js";

describe("guacamole touch gestures", () => {
  it("measures distance and midpoint", () => {
    expect(touchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(touchMidpoint({ x: 0, y: 2 }, { x: 4, y: 6 })).toEqual({
      x: 2,
      y: 4,
    });
  });

  it("stays undecided until the spread changes or the midpoint moves", () => {
    expect(
      classifyTwoFingerMove({
        startDistance: 40,
        currentDistance: 40 + PINCH_PX,
        moved: false,
      }),
    ).toBe("undecided");
    expect(
      classifyTwoFingerMove({
        startDistance: 40,
        currentDistance: 40 + PINCH_PX + 0.5,
        moved: false,
      }),
    ).toBe("pinch");
    expect(
      classifyTwoFingerMove({
        startDistance: 40,
        currentDistance: 42,
        moved: true,
      }),
    ).toBe("pan");
  });

  it("keeps a decided pinch or pan for the rest of the gesture", () => {
    expect(
      classifyTwoFingerMove({
        startDistance: 40,
        currentDistance: 80,
        current: "pan",
        moved: true,
      }),
    ).toBe("pan");
    expect(
      classifyTwoFingerMove({
        startDistance: 40,
        currentDistance: 40,
        current: "pinch",
        moved: true,
      }),
    ).toBe("pinch");
  });

  it("scales pinch zoom from the starting spread and clamps it", () => {
    expect(nextPinchZoom(1, 40, 80)).toBe(2);
    expect(nextPinchZoom(1, 40, 8)).toBe(0.5);
    expect(nextPinchZoom(1, 40, 400)).toBe(4);
    expect(nextPinchZoom(1.25, 0, 80)).toBe(1.25);
  });

  it("keeps the point under the fingers when zooming", () => {
    expect(
      scrollAfterZoom({
        scrollLeft: 100,
        scrollTop: 40,
        pointX: 50,
        pointY: 20,
        oldScale: 1,
        newScale: 2,
      }),
    ).toEqual({ scrollLeft: 250, scrollTop: 100 });
  });

  it("tracks the fingers when the midpoint moves during a pinch", () => {
    expect(
      scrollAfterZoom({
        scrollLeft: 100,
        scrollTop: 40,
        fromX: 50,
        fromY: 20,
        pointX: 70,
        pointY: 30,
        oldScale: 1,
        newScale: 2,
      }),
    ).toEqual({ scrollLeft: 230, scrollTop: 90 });
  });

  it("uses the clamped zoom when the spread would go past the bounds", () => {
    const zoom = nextPinchZoom(1, 10, 1000);
    expect(zoom).toBe(4);
    expect(
      scrollAfterZoom({
        scrollLeft: 0,
        scrollTop: 0,
        pointX: 10,
        pointY: 10,
        oldScale: 1,
        newScale: zoom,
      }),
    ).toEqual({ scrollLeft: 30, scrollTop: 30 });
  });

  it("pans by subtracting the midpoint delta", () => {
    expect(
      scrollAfterPan({
        scrollLeft: 80,
        scrollTop: 60,
        dx: 12,
        dy: -4,
      }),
    ).toEqual({ scrollLeft: 68, scrollTop: 64 });
  });

  it("measures the display offset in scroll-content coordinates", () => {
    // A 1000x600 display centered vertically in a 1000x1000 container.
    expect(
      displayOffsetInContainer({
        containerRect: { left: 0, top: 0 },
        displayRect: { left: 0, top: 200 },
        scrollLeft: 0,
        scrollTop: 0,
      }),
    ).toEqual({ x: 0, y: 200 });
    expect(
      displayOffsetInContainer({
        containerRect: { left: 10, top: 20 },
        displayRect: { left: 10, top: 80 },
        scrollLeft: 0,
        scrollTop: 40,
      }),
    ).toEqual({ x: 0, y: 100 });
  });

  it("zooms around the fingers when a centered display becomes scrollable", () => {
    // 1000x600 display centered in a 1000x1000 container, pinched 1 -> 2
    // around a stationary center at y = 500. Content y = 300 doubles to 600;
    // after zoom the display fills the height (offset 0), so scrollTop = 100.
    expect(
      scrollAfterZoom({
        scrollLeft: 0,
        scrollTop: 0,
        fromX: 500,
        fromY: 500,
        pointX: 500,
        pointY: 500,
        oldScale: 1,
        newScale: 2,
        fromOffsetX: 0,
        fromOffsetY: 200,
        toOffsetX: 0,
        toOffsetY: 0,
      }),
    ).toEqual({ scrollLeft: 500, scrollTop: 100 });
  });

  it("keeps a still-centered axis centered while zooming", () => {
    // Zooming 1 -> 1.2 leaves a 600-tall display (now 720) centered in a
    // 1000-tall container: offset 200 -> 140, so no vertical scroll is needed.
    expect(
      scrollAfterZoom({
        scrollLeft: 0,
        scrollTop: 0,
        fromX: 500,
        fromY: 500,
        pointX: 500,
        pointY: 500,
        oldScale: 1,
        newScale: 1.2,
        fromOffsetX: 0,
        fromOffsetY: 200,
        toOffsetX: 0,
        toOffsetY: 140,
      }),
    ).toEqual({ scrollLeft: 100, scrollTop: 0 });
  });
});
