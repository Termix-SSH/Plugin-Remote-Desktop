import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRdpReadyGate } from "../../src/frontend/guacamole-ready.js";

describe("RDP ready gate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is ready on the second sync", () => {
    const onReady = vi.fn();
    const gate = createRdpReadyGate(onReady, 1500);
    gate.sync();
    expect(onReady).not.toHaveBeenCalled();
    gate.sync();
    gate.sync();
    vi.advanceTimersByTime(2000);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("is ready after the wait when no second sync comes", () => {
    const onReady = vi.fn();
    const gate = createRdpReadyGate(onReady, 1500);
    gate.sync();
    vi.advanceTimersByTime(1499);
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReady).toHaveBeenCalledOnce();
    gate.sync();
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("never fires once cancelled", () => {
    const onReady = vi.fn();
    const gate = createRdpReadyGate(onReady, 1500);
    gate.sync();
    gate.cancel();
    vi.advanceTimersByTime(2000);
    gate.sync();
    expect(onReady).not.toHaveBeenCalled();
  });
});
