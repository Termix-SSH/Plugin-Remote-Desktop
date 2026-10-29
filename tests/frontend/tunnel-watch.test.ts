import { afterEach, describe, expect, it, vi } from "vitest";
import { watchTunnel } from "../../src/frontend/tunnel-watch";

afterEach(() => vi.useRealTimers());

function tunnel() {
  return {
    state: 1,
    oninstruction: vi.fn() as ((opcode: string, args: string[]) => void) | null,
    onstatechange: vi.fn() as ((state: number) => void) | null,
  };
}

describe("watchTunnel", () => {
  it("keeps the client's handlers and reports a closed tunnel once", () => {
    const t = tunnel();
    const clientInstruction = t.oninstruction;
    const clientState = t.onstatechange;
    const onLost = vi.fn();
    watchTunnel(t, onLost);
    t.oninstruction?.("sync", ["1"]);
    expect(clientInstruction).toHaveBeenCalledWith("sync", ["1"]);
    t.onstatechange?.(1);
    expect(onLost).not.toHaveBeenCalled();
    t.onstatechange?.(2);
    t.onstatechange?.(2);
    expect(clientState).toHaveBeenCalledWith(2);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith("closed");
  });

  it("after the page comes back, silence means the socket is dead", () => {
    vi.useFakeTimers();
    const t = tunnel();
    const onLost = vi.fn();
    const watch = watchTunnel(t, onLost, { checkMs: 8000 });

    watch.checkAlive();
    vi.advanceTimersByTime(3000);
    t.oninstruction?.("nop", []);
    vi.advanceTimersByTime(5000);
    expect(onLost).not.toHaveBeenCalled();

    watch.checkAlive();
    vi.advanceTimersByTime(8000);
    expect(onLost).toHaveBeenCalledWith("stale");
  });

  it("a tunnel that is not open is stale at once; stop ends the watch", () => {
    vi.useFakeTimers();
    const t = tunnel();
    const onLost = vi.fn();
    const watch = watchTunnel(t, onLost);
    t.state = 3;
    watch.checkAlive();
    expect(onLost).toHaveBeenCalledWith("stale");

    const quiet = vi.fn();
    const other = watchTunnel(tunnel(), quiet);
    other.checkAlive();
    other.stop();
    vi.advanceTimersByTime(60000);
    expect(quiet).not.toHaveBeenCalled();
  });

  it("works with a tunnel that has no handlers or state yet", () => {
    vi.useFakeTimers();
    const bare: { onstatechange?: ((s: number) => void) | null } = {};
    const onLost = vi.fn();
    const watch = watchTunnel(bare, onLost, { checkMs: 100 });
    watch.checkAlive();
    vi.advanceTimersByTime(100);
    expect(onLost).toHaveBeenCalledWith("stale");
    bare.onstatechange?.(2);
    expect(onLost).toHaveBeenCalledTimes(1);
  });
});
