import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  parseListening,
  registerOperations,
  tcpOpen,
} from "../../src/backend/operations.js";

describe("tcpOpen", () => {
  it("sees an open and a closed port", async () => {
    const server = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as net.AddressInfo).port;
    expect(await tcpOpen("127.0.0.1", port)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await tcpOpen("127.0.0.1", port, 1000)).toBe(false);
  });
});

describe("parseListening", () => {
  it("reads ss and netstat addresses", () => {
    const ports = parseListening(
      "0.0.0.0:5901\n[::]:3389\n*.5900\n127.0.0.53%lo:53\nSTREAM\n",
    );
    expect([...ports].sort((a, b) => a - b)).toEqual([53, 3389, 5900, 5901]);
  });
});

function checkPorts(
  settings: Record<string, unknown>,
  exec: () => Promise<unknown>,
) {
  let run: ((input: unknown, context: unknown) => Promise<unknown>) | null =
    null;
  const ctx = {
    operations: {
      register: (_id: string, handler: { run: typeof run }) => {
        run = handler.run;
      },
    },
    hosts: {
      probeTargets: async () => [{ id: 1, ip: "127.0.0.1", jumpHosts: [] }],
    },
    settings: { getAll: async () => settings },
    ssh: { exec: vi.fn(exec) },
  } as unknown as PluginContext;
  registerOperations(ctx);
  return { ctx, result: run!({}, { hostId: 1 }) as Promise<{ data: never }> };
}

describe("remote-desktop.check-ports", () => {
  it("reads the VNC port over SSH and never dials it", async () => {
    const server = net.createServer();
    const connected = vi.fn();
    server.on("connection", connected);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as net.AddressInfo).port;
    const { ctx, result } = checkPorts(
      { enableVnc: true, vncPort: port },
      async () => ({ code: 0, stdout: `0.0.0.0:${port}\n`, stderr: "" }),
    );
    expect((await result).data).toMatchObject({
      status: "ok",
      rows: [{ protocol: "vnc", open: "yes" }],
    });
    expect(ctx.ssh.exec).toHaveBeenCalledTimes(1);
    expect(connected).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("says not checked when SSH fails", async () => {
    const { result } = checkPorts({ enableVnc: true, vncPort: 5901 }, () =>
      Promise.reject(new Error("no login")),
    );
    expect((await result).data).toMatchObject({
      status: "unknown",
      rows: [{ protocol: "vnc", open: "unknown" }],
    });
  });

  it("reports a VNC port nothing listens on", async () => {
    const { result } = checkPorts(
      { enableVnc: true, vncPort: 5901 },
      async () => ({
        code: 0,
        stdout: "0.0.0.0:22\n",
        stderr: "",
      }),
    );
    expect((await result).data).toMatchObject({ status: "fail" });
  });
});
