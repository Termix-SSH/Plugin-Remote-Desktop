import net, { type AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import wasmBytes from "../../../../../src/backend/engine/wasm/engine_bg.wasm";
import {
  loadWasm,
  type Wasm,
} from "../../../../../src/backend/engine/worker/wasm.js";
import {
  DO,
  IAC,
  OPT,
  SB,
  SE,
  TelnetCodec,
  WILL,
  WONT,
} from "../../../../../src/backend/engine/worker/telnet/protocol.js";
import { keyBytes } from "../../../../../src/backend/engine/worker/telnet/keys.js";
import { parseColorScheme } from "../../../../../src/backend/engine/worker/telnet/palette.js";
import { TelnetClient } from "../../../../../src/backend/engine/worker/telnet/client.js";
import {
  Settings,
  type RemoteHost,
} from "../../../../../src/backend/engine/worker/remote.js";

let wasm: Wasm;
beforeAll(() => {
  wasm = loadWasm(new WebAssembly.Module(wasmBytes as BufferSource));
});

describe("TelnetCodec", () => {
  function codec(username = "") {
    const sent: Buffer[] = [];
    const c = new TelnetCodec(
      {
        terminalType: "xterm-256color",
        username,
        size: () => ({ cols: 80, rows: 24 }),
      },
      (b) => sent.push(b),
    );
    return { c, sent };
  }

  it("splits data from negotiation and answers it", () => {
    const { c, sent } = codec();
    const data = c.receive(
      Buffer.from([
        0x68,
        IAC,
        DO,
        OPT.NAWS,
        0x69,
        IAC,
        IAC,
        IAC,
        WILL,
        OPT.ECHO,
        IAC,
        DO,
        99,
      ]),
    );
    expect([...data]).toEqual([0x68, 0x69, IAC]);
    expect(Buffer.concat(sent)).toEqual(
      Buffer.from([
        IAC,
        WILL,
        OPT.NAWS,
        IAC,
        SB,
        OPT.NAWS,
        0,
        80,
        0,
        24,
        IAC,
        SE,
        IAC,
        DO,
        OPT.ECHO,
        IAC,
        WONT,
        99,
      ]),
    );
  });

  it("sends the terminal type and the user", () => {
    const { c, sent } = codec("bob");
    c.receive(Buffer.from([IAC, SB, OPT.TTYPE, 1, IAC, SE]));
    c.receive(
      Buffer.from([
        IAC,
        DO,
        OPT.NEW_ENVIRON,
        IAC,
        SB,
        OPT.NEW_ENVIRON,
        1,
        IAC,
        SE,
      ]),
    );
    const all = Buffer.concat(sent).toString("latin1");
    expect(all).toContain("xterm-256color");
    expect(all).toContain("USER\x01bob");
  });

  it("doubles IAC in input", () => {
    const { c } = codec();
    expect([...c.encode(Buffer.from([1, IAC, 2]))]).toEqual([1, IAC, IAC, 2]);
  });
});

describe("terminal keys", () => {
  const modes = {
    ctrl: false,
    alt: false,
    shift: false,
    applicationCursor: false,
    backspace: 127,
  };
  it("maps keys to the bytes a terminal sends", () => {
    expect(keyBytes(0xff52, modes)).toBe("\x1b[A");
    expect(keyBytes(0xff52, { ...modes, applicationCursor: true })).toBe(
      "\x1bOA",
    );
    expect(keyBytes(0x63, { ...modes, ctrl: true })).toBe("\x03");
    expect(keyBytes(0x78, { ...modes, alt: true })).toBe("\x1bx");
    expect(keyBytes(0xff08, { ...modes, backspace: 8 })).toBe("\b");
    expect(keyBytes(0xffe1, modes)).toBeNull();
  });

  it("reads guacd color schemes", () => {
    expect(parseColorScheme("black-white").background).toEqual([255, 255, 255]);
    const custom = parseColorScheme(
      "foreground: rgb:ff/00/00; background: color4",
    );
    expect(custom.foreground).toEqual([255, 0, 0]);
  });
});

describe("TelnetClient", () => {
  let server: net.Server | null = null;
  let client: TelnetClient | null = null;
  afterEach(() => {
    client?.stop();
    server?.close();
    client = null;
    server = null;
  });

  it("logs in with guacd's prompts and fails on the failure pattern", async () => {
    const received: string[] = [];
    server = net.createServer((socket) => {
      socket.write("Welcome\r\nlogin: ");
      socket.on("data", (d) => {
        const text = d.toString();
        received.push(text);
        if (text.includes("alice")) socket.write("Password: ");
        if (text.includes("pw")) socket.write("\r\nLogin incorrect\r\n");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const fail = vi.fn();
    const ready = vi.fn();
    const display = {
      resize: vi.fn(),
      setSource: vi.fn(),
      damage: vi.fn(),
      cursorDefault: vi.fn(),
    };
    const host = {
      wasm,
      display,
      settings: new Settings({
        hostname: "127.0.0.1",
        port: String((server.address() as AddressInfo).port),
        username: "alice",
        password: "pw",
        "login-failure-regex": "incorrect",
        width: "640",
        height: "400",
      }),
      log: vi.fn(),
      ready,
      fail,
      closed: vi.fn(),
      clipboard: vi.fn(),
    } as unknown as RemoteHost;
    client = new TelnetClient(host);
    client.start();
    for (let i = 0; i < 200 && fail.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(ready).toHaveBeenCalled();
    expect(received.join("")).toContain("alice\r");
    expect(received.join("")).toContain("pw\r");
    expect(fail).toHaveBeenCalledWith("Telnet login failed", 0x301);
    expect(display.resize).toHaveBeenCalledWith(640, 400);
    expect(display.damage).toHaveBeenCalled();
  });
});
