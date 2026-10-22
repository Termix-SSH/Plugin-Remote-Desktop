import net, { type AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import wasmBytes from "../../../../../src/backend/engine/wasm/engine_bg.wasm";
import {
  loadWasm,
  type Wasm,
} from "../../../../../src/backend/engine/worker/wasm.js";
import {
  VncClient,
  chooseSecurity,
  chooseVencrypt,
  chooseVersion,
  encodingList,
} from "../../../../../src/backend/engine/worker/vnc/client.js";
import {
  Settings,
  type RemoteHost,
} from "../../../../../src/backend/engine/worker/remote.js";
import { ByteReader } from "../../../../../src/backend/engine/worker/vnc/reader.js";
import { vncAuthResponse } from "../../../../../src/backend/engine/worker/vnc/des.js";

let wasm: Wasm;
beforeAll(() => {
  wasm = loadWasm(new WebAssembly.Module(wasmBytes as BufferSource));
});

describe("negotiation choices", () => {
  it("answers each server version", () => {
    expect(chooseVersion("RFB 003.003\n").reply).toBe("RFB 003.003\n");
    expect(chooseVersion("RFB 003.007\n").reply).toBe("RFB 003.007\n");
    expect(chooseVersion("RFB 003.008\n").reply).toBe("RFB 003.008\n");
    expect(chooseVersion("RFB 004.001\n").minor).toBe(8);
    expect(chooseVersion("RFB 003.889\n").reply).toBe("RFB 003.008\n");
    expect(() => chooseVersion("SSH-2.0-x\r\n")).toThrow();
  });

  it("picks the login from what the server offers", () => {
    expect(chooseSecurity([1, 2, 30], "u", "p")).toBe(30);
    expect(chooseSecurity([1, 2, 30], "", "p")).toBe(2);
    expect(chooseSecurity([1, 2], "", "")).toBe(1);
    expect(chooseSecurity([2, 19], "", "p")).toBe(19);
    expect(chooseSecurity([5, 6], "", "")).toBeNull();
    expect(chooseVencrypt([257, 258, 261], "")).toBe(261);
    expect(chooseVencrypt([256, 259], "u")).toBe(259);
  });

  it("asks for the named encodings plus the pseudo ones", () => {
    const list = encodingList("zrle hextile bogus", true, 6);
    expect(list.slice(0, 3)).toEqual([16, 5, 0]);
    expect(list).toContain(-239);
    expect(list).toContain(-308);
    expect(list).toContain(-32 + 6);
    expect(encodingList("", false, 9)).not.toContain(-239);
  });
});

/** A small RFB 3.8 server with VncAuth that sends one update. */
function fakeServer(
  onClient: (socket: net.Socket, r: ByteReader) => Promise<void>,
) {
  const server = net.createServer((socket) => {
    const r = new ByteReader();
    socket.on("data", (d) => r.push(d as Buffer));
    socket.on("error", () => {});
    onClient(socket, r).catch(() => socket.destroy());
  });
  return new Promise<net.Server>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

function host(port: number, settings: Record<string, string> = {}) {
  const events: string[] = [];
  const display = {
    lossless: false,
    resize: vi.fn((w: number, h: number) => events.push(`resize ${w}x${h}`)),
    setSource: vi.fn(),
    damage: vi.fn(),
    copy: vi.fn(),
    cursorDot: vi.fn(),
    cursorHidden: vi.fn(),
    setCursor: vi.fn(),
  };
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  const h = {
    wasm,
    display,
    settings: new Settings({
      hostname: "127.0.0.1",
      port: String(port),
      password: "secret",
      ...settings,
    }),
    drive: null,
    log: vi.fn(),
    ready: vi.fn(() => resolveReady()),
    fail: vi.fn((m: string) => events.push(`fail ${m}`)),
    closed: vi.fn(),
    clipboard: vi.fn(),
    sendFile: vi.fn(),
    audio: vi.fn(),
  };
  return { h: h as unknown as RemoteHost, display, events, ready, raw: h };
}

let servers: net.Server[] = [];
let clients: VncClient[] = [];
afterEach(() => {
  for (const c of clients) c.stop();
  for (const s of servers) s.close();
  clients = [];
  servers = [];
});

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((r) => setTimeout(r, 10));
};

describe("VncClient", () => {
  it("logs in with VncAuth, draws an update and resizes", async () => {
    const challenge = Buffer.alloc(16, 7);
    const received: number[] = [];
    let serverSocket!: net.Socket;
    const server = await fakeServer(async (socket, r) => {
      serverSocket = socket;
      socket.write("RFB 003.008\n");
      expect((await r.bytes(12)).toString()).toBe("RFB 003.008\n");
      socket.write(Buffer.from([1, 2]));
      expect(await r.u8()).toBe(2);
      socket.write(challenge);
      const answer = await r.bytes(16);
      expect(Buffer.from(answer)).toEqual(
        Buffer.from(vncAuthResponse("secret", challenge)),
      );
      socket.write(Buffer.alloc(4));
      await r.u8(); // shared
      const init = Buffer.alloc(24 + 4);
      init.writeUInt16BE(4, 0);
      init.writeUInt16BE(2, 2);
      init.writeUInt32BE(4, 20);
      init.write("test", 24);
      socket.write(init);
      for (;;) received.push(await r.u8());
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const { h, display, ready, raw } = host(port);
    const client = new VncClient(h);
    clients.push(client);
    client.start();
    await ready;
    expect(display.resize).toHaveBeenCalledWith(4, 2);
    expect(display.cursorDot).toHaveBeenCalled();

    // Raw rect, then ExtendedDesktopSize to 8x4.
    const update = Buffer.alloc(4 + 12 + 4 * 4 + 12 + 4 + 16);
    let o = 0;
    update[o] = 0;
    update.writeUInt16BE(2, 2);
    o = 4;
    update.writeUInt16BE(1, o + 4);
    update.writeUInt16BE(1, o + 6);
    update.writeInt32BE(0, o + 8);
    o += 12;
    update.set([255, 0, 0, 0], o);
    o += 4;
    // ExtendedDesktopSize: x = reason 0, y = status 0.
    update.writeUInt16BE(8, o + 4);
    update.writeUInt16BE(4, o + 6);
    update.writeInt32BE(-308, o + 8);
    o += 12;
    update[o] = 1;
    o += 4;
    update.writeUInt32BE(42, o);
    update.writeUInt16BE(8, o + 8);
    update.writeUInt16BE(4, o + 10);
    serverSocket.write(update.subarray(0, o + 16));
    await until(() => display.resize.mock.calls.length >= 2);
    expect(display.damage).toHaveBeenCalledWith({ x: 0, y: 0, w: 1, h: 1 });
    expect(display.resize).toHaveBeenLastCalledWith(8, 4);
    expect(raw.fail).not.toHaveBeenCalled();

    client.resize(10, 6);
    client.key(0x61, true);
    client.mouse(3, 2, 1);
    await until(
      () =>
        received.includes(251) && received.includes(4) && received.includes(5),
    );
    expect(received).toContain(251);

    serverSocket.end();
    await until(
      () => (raw.closed as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    );
    expect(raw.closed).toHaveBeenCalled();
  });

  it("reports a refused login as unauthorized", async () => {
    const server = await fakeServer(async (socket, r) => {
      socket.write("RFB 003.008\n");
      await r.bytes(12);
      socket.write(Buffer.from([1, 2]));
      await r.u8();
      socket.write(Buffer.alloc(16));
      await r.bytes(16);
      const reason = Buffer.from("Wrong password");
      const out = Buffer.alloc(8);
      out.writeUInt32BE(1, 0);
      out.writeUInt32BE(reason.length, 4);
      socket.write(Buffer.concat([out, reason]));
    });
    servers.push(server);
    const { h, raw } = host((server.address() as AddressInfo).port);
    const client = new VncClient(h);
    clients.push(client);
    client.start();
    await until(
      () => (raw.fail as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    );
    expect(raw.fail).toHaveBeenCalledWith("Wrong password", 0x301);
  });

  it("logs in with no password on RFB 3.3", async () => {
    const server = await fakeServer(async (socket, r) => {
      socket.write("RFB 003.003\n");
      expect((await r.bytes(12)).toString()).toBe("RFB 003.003\n");
      socket.write(Buffer.from([0, 0, 0, 1]));
      await r.u8();
      const init = Buffer.alloc(24);
      init.writeUInt16BE(2, 0);
      init.writeUInt16BE(2, 2);
      socket.write(init);
      await r.bytes(1000);
    });
    servers.push(server);
    const { h, ready } = host((server.address() as AddressInfo).port, {
      password: "",
    });
    const client = new VncClient(h);
    clients.push(client);
    client.start();
    await ready;
  });

  it("fails cleanly when nothing listens", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const { h, raw } = host(port);
    const client = new VncClient(h);
    clients.push(client);
    client.start();
    await until(
      () => (raw.fail as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    );
    expect(raw.fail).toHaveBeenCalledWith(
      "Could not reach the VNC server",
      0x207,
    );
  });
});
