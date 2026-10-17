import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Display,
  type PixelSource,
} from "../../../../src/backend/engine/worker/display.js";
import { Output } from "../../../../src/backend/engine/worker/output.js";
import { DirtyRegion } from "../../../../src/backend/engine/worker/rects.js";
import type { FromWorker } from "../../../../src/backend/engine/messages.js";

function setup() {
  const posted: FromWorker[] = [];
  const out = new Output({ post: (m) => posted.push(m) });
  let now = 1000;
  const display = new Display(out, {
    rgbaPng: () => new Uint8Array([1, 2, 3]),
    now: () => now,
  });
  const calls: string[] = [];
  const source: PixelSource = {
    width: 100,
    height: 100,
    png: (x, y, w, h) => {
      calls.push(`png ${x},${y},${w},${h}`);
      return new Uint8Array([9]);
    },
    jpeg: (x, y, w, h) => {
      calls.push(`jpeg ${x},${y},${w},${h}`);
      return new Uint8Array([8]);
    },
  };
  display.setSource(source);
  const text = () =>
    posted
      .filter((m) => m.t === "out")
      .map((m) => (m as { data: string }).data)
      .join("");
  return { display, posted, calls, text, tick: (ms: number) => (now += ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DirtyRegion", () => {
  it("merges touching rects and keeps far ones apart", () => {
    const region = new DirtyRegion();
    region.add({ x: 0, y: 0, w: 10, h: 10 });
    region.add({ x: 10, y: 0, w: 10, h: 10 });
    region.add({ x: 500, y: 500, w: 10, h: 10 });
    expect(region.take()).toEqual([
      { x: 0, y: 0, w: 20, h: 10 },
      { x: 500, y: 500, w: 10, h: 10 },
    ]);
    expect(region.empty).toBe(true);
  });

  it("collapses into one rect past the limit", () => {
    const region = new DirtyRegion(4);
    for (let i = 0; i < 5; i++) region.add({ x: i * 100, y: 0, w: 5, h: 5 });
    expect(region.take()).toEqual([{ x: 0, y: 0, w: 405, h: 5 }]);
  });
});

describe("Display", () => {
  it("draws damage as PNG and ends the frame with sync", () => {
    vi.useFakeTimers();
    const { display, calls, text } = setup();
    display.addUser("a");
    display.resize(100, 100);
    vi.advanceTimersByTime(20);
    expect(calls).toEqual(["png 0,0,100,100"]);
    expect(text()).toContain("4.size,1.0,3.100,3.100;");
    expect(text()).toMatch(
      /3\.img,\d+\.\d+,2\.14,1\.0,9\.image\/png,1\.0,1\.0;/,
    );
    expect(text()).toMatch(/4\.sync,4\.1000;$/);
  });

  it("holds frames while a client lags, then sends merged damage", () => {
    vi.useFakeTimers();
    const { display, calls, tick } = setup();
    display.addUser("a");
    display.resize(100, 100);
    for (let i = 0; i < 3; i++) {
      display.damage({ x: i, y: 0, w: 1, h: 1 });
      vi.advanceTimersByTime(20);
      tick(20);
    }
    const sent = calls.length;
    display.damage({ x: 50, y: 50, w: 2, h: 2 });
    display.damage({ x: 52, y: 50, w: 2, h: 2 });
    vi.advanceTimersByTime(100);
    expect(calls.length).toBe(sent);
    display.ack("a", Number.MAX_SAFE_INTEGER);
    vi.advanceTimersByTime(20);
    expect(calls.at(-1)).toBe("png 50,50,4,2");
  });

  it("ignores a client that stopped answering", () => {
    vi.useFakeTimers();
    const { display, calls, tick } = setup();
    display.addUser("a");
    display.resize(100, 100);
    for (let i = 0; i < 3; i++) {
      display.damage({ x: i, y: 0, w: 1, h: 1 });
      vi.advanceTimersByTime(20);
    }
    tick(5000);
    display.damage({ x: 70, y: 70, w: 1, h: 1 });
    vi.advanceTimersByTime(20);
    expect(calls.at(-1)).toBe("png 70,70,1,1");
  });

  it("sends large busy regions as JPEG unless lossless", () => {
    vi.useFakeTimers();
    const { display, calls } = setup();
    display.addUser("a");
    display.resize(256, 256);
    for (let i = 0; i < 6; i++) {
      display.damage({ x: 0, y: 0, w: 256, h: 256 });
      display.ack("a", Number.MAX_SAFE_INTEGER);
      vi.advanceTimersByTime(20);
    }
    expect(calls.at(-1)).toBe("jpeg 0,0,256,256");
    display.lossless = true;
    display.damage({ x: 0, y: 0, w: 256, h: 256 });
    display.ack("a", Number.MAX_SAFE_INTEGER);
    vi.advanceTimersByTime(20);
    expect(calls.at(-1)).toBe("png 0,0,256,256");
  });

  it("gives a joiner the size, the screen, the cursor and a sync", () => {
    const { display } = setup();
    display.resize(100, 100);
    const snapshot = display.snapshot();
    expect(snapshot.startsWith("4.size,1.0,3.100,3.100;")).toBe(true);
    expect(snapshot).toContain("6.cursor,");
    expect(snapshot).toMatch(/4\.sync,4\.\d+;$/);
  });

  it("forwards CopyRect as a copy and repaints stale pixels", () => {
    vi.useFakeTimers();
    const { display, calls, text } = setup();
    display.addUser("a");
    display.resize(100, 100);
    vi.advanceTimersByTime(20);
    display.ack("a", Number.MAX_SAFE_INTEGER);
    calls.length = 0;
    display.copy({ x: 0, y: 0, w: 10, h: 10 }, 20, 20);
    vi.advanceTimersByTime(20);
    expect(text()).toContain(
      "4.copy,1.0,1.0,1.0,2.10,2.10,2.12,1.0,2.20,2.20;",
    );
    expect(calls).toEqual([]);
  });
});
