import { describe, expect, it } from "vitest";
import {
  PINCH_PX,
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
});
