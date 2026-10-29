import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

const { launchNativeRdp } = await import("../../src/backend/native-rdp");

describe("launchNativeRdp", () => {
  it("opens mstsc with its window shown", async () => {
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const result = await launchNativeRdp(
      { host: "server.example.com", port: 3389 } as never,
      "win32",
    );
    expect(result).toEqual({ success: true });
    expect(spawn.mock.calls[0][0]).toBe("mstsc.exe");
    expect(spawn.mock.calls[0][2]).toMatchObject({ windowsHide: false });
  });
});
