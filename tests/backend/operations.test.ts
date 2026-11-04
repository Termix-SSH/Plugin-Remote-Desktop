import net from "node:net";
import { describe, expect, it } from "vitest";
import { tcpOpen } from "../../src/backend/operations.js";

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
