import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Cipher,
  FrameReader,
  frameHeader,
  kxVersionFor,
  parseAddress,
  splitKey,
} from "../../../../../src/backend/engine/worker/rustdesk/transport.js";
import {
  PbMessage,
  PbWriter,
} from "../../../../../src/backend/engine/worker/rustdesk/pb.js";
import {
  openSigned,
  passwordHash,
} from "../../../../../src/backend/engine/worker/rustdesk/handshake.js";
import {
  CK,
  Modifiers,
  keysymTarget,
  mouseActions,
} from "../../../../../src/backend/engine/worker/rustdesk/input.js";
import {
  frameChunks,
  parseDecodings,
  toPcm16,
  FRAME_END,
  FRAME_KEY,
} from "../../../../../src/backend/engine/worker/rustdesk/client.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("framing", () => {
  it("round trips every header size, split across chunks", () => {
    for (const size of [0, 1, 63, 64, 16383, 16384, 70000]) {
      const body = crypto.randomBytes(size);
      const wire = Buffer.concat([frameHeader(size), body]);
      const reader = new FrameReader();
      const frames = [
        ...reader.push(wire.subarray(0, 1)),
        ...reader.push(wire.subarray(1)),
      ];
      expect(frames).toHaveLength(1);
      expect(frames[0].equals(body)).toBe(true);
    }
  });

  it("matches RustDesk's header bytes", () => {
    expect(hex(frameHeader(5))).toBe("14");
    expect(hex(frameHeader(64))).toBe("0101");
    expect(hex(frameHeader(16384))).toBe("020001");
  });

  it("reads several frames from one chunk", () => {
    const reader = new FrameReader();
    const wire = Buffer.concat([
      frameHeader(2),
      Buffer.from("ab"),
      frameHeader(1),
      Buffer.from("c"),
    ]);
    expect(reader.push(wire).map((f) => f.toString())).toEqual(["ab", "c"]);
  });
});

describe("encryption", () => {
  // Wire vectors from RustDesk's own tests (hbb_common tcp.rs).
  it("seals like RustDesk's version 0 scheme", () => {
    const cipher = new Cipher(new Uint8Array(32).fill(0x11));
    expect(hex(cipher.seal(Buffer.from("hello")))).toBe(
      "3b768f827fdcc4af555b9e42533be6611e2c333481",
    );
  });

  it("splits keys like RustDesk's version 1 scheme", () => {
    const key = new Uint8Array(32).fill(0x11);
    const t = {
      initiatorPk: new Uint8Array(32).fill(0x22),
      responderPk: new Uint8Array(32).fill(0x33),
      advertised: 1,
      picked: 1,
    };
    expect(hex(splitKey(key, 1, t))).toBe(
      "c189ec6e1935c0751cfc85a0f075405cae507d7925bb19687caf56cbb54e0ecf",
    );
    expect(hex(splitKey(key, 2, t))).toBe(
      "8a62648e9195cb10ea900c0a24d2a166c1e982347a2dc6833c3e756bf5715d36",
    );
    expect(hex(splitKey(key, 1, { ...t, advertised: 3 }))).toBe(
      "25b0778ae600f9731c7fa457d1cc5d40071b0aa3d34c90b53e1d5344b0e7123a",
    );
  });

  it("keeps a counter per direction and leaves tiny frames alone", () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    const client = new Cipher(a, b);
    const peer = new Cipher(b, a);
    for (const text of ["one", "two", "three"]) {
      expect(
        Buffer.from(peer.open(client.seal(Buffer.from(text)))).toString(),
      ).toBe(text);
    }
    expect(client.open(peer.seal(Buffer.from("back"))).length).toBe(4);
    expect(client.open(new Uint8Array([7]))).toEqual(new Uint8Array([7]));
    expect(() => client.open(new Uint8Array(40))).toThrow();
  });

  it("picks the highest shared key exchange version", () => {
    expect(kxVersionFor(0)).toBe(0);
    expect(kxVersionFor(1)).toBe(1);
    expect(kxVersionFor(9)).toBe(1);
  });

  it("hashes the password with salt then challenge", () => {
    const first = crypto.createHash("sha256").update("pw").update("salt");
    const expected = crypto
      .createHash("sha256")
      .update(first.digest())
      .update("chal")
      .digest();
    expect(hex(passwordHash("pw", "salt", "chal"))).toBe(hex(expected));
    expect(passwordHash("", "salt", "chal")).toHaveLength(0);
  });

  it("only opens messages signed by the given key", () => {
    const signer = crypto.generateKeyPairSync("ed25519");
    const raw = signer.publicKey.export({ format: "der", type: "spki" });
    const pk = new Uint8Array(raw.subarray(raw.length - 32));
    const msg = Buffer.from("idpk");
    const signed = Buffer.concat([
      crypto.sign(null, msg, signer.privateKey),
      msg,
    ]);
    expect(Buffer.from(openSigned(signed, pk)!).toString()).toBe("idpk");
    expect(openSigned(signed, new Uint8Array(32).fill(9))).toBeNull();
    expect(Buffer.from(openSigned(signed, null)!).toString()).toBe("idpk");
  });
});

describe("protobuf", () => {
  it("round trips the field kinds RustDesk uses", () => {
    const data = new PbWriter()
      .uint(1, 300)
      .sint(2, -5)
      .string(3, "héllo")
      .bool(4, true)
      .message(5, new PbWriter().uint(1, 7))
      .packed(6, [1, 2, 300])
      .finish();
    const m = PbMessage.decode(data);
    expect(m.int(1)).toBe(300);
    expect(m.sint(2)).toBe(-5);
    expect(m.string(3)).toBe("héllo");
    expect(m.bool(4)).toBe(true);
    expect(m.message(5)!.int(1)).toBe(7);
    expect(m.int(9)).toBe(0);
    expect(m.message(9)).toBeNull();
  });

  it("reads negative int32 and skips fixed fields", () => {
    // field 1 = -1 as a 10 byte varint, field 2 a double, field 3 = 4.
    const data = Buffer.concat([
      Buffer.from([
        0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
      ]),
      Buffer.from([0x11, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f]),
      Buffer.from([0x18, 0x04]),
    ]);
    const m = PbMessage.decode(data);
    expect(m.int(1)).toBe(-1);
    expect(m.int(3)).toBe(4);
  });

  it("refuses truncated input", () => {
    expect(() => PbMessage.decode(Buffer.from([0x0a, 0x05, 1]))).toThrow();
  });
});

describe("input", () => {
  it("maps keysyms to control keys and characters", () => {
    expect(keysymTarget(0xff0d)).toEqual({ controlKey: CK.Return });
    expect(keysymTarget(0xffbe)).toEqual({ controlKey: CK.F1 });
    expect(keysymTarget(0xffc0)).toEqual({ controlKey: 14 });
    expect(keysymTarget(0xffc8)).toEqual({ controlKey: CK.F11 });
    expect(keysymTarget(0xffb5)).toEqual({ controlKey: CK.Numpad0 + 5 });
    expect(keysymTarget(0x61)).toEqual({ chr: 0x61 });
    expect(keysymTarget(0xe9)).toEqual({ chr: 0xe9 });
    expect(keysymTarget(0x010020ac)).toEqual({ chr: 0x20ac });
    expect(keysymTarget(0x12345)).toBeNull();
  });

  it("tracks held modifiers", () => {
    const mods = new Modifiers();
    mods.update({ controlKey: CK.Control }, true);
    mods.update({ controlKey: CK.Shift }, true);
    mods.update({ chr: 0x61 }, true);
    expect(mods.list().sort()).toEqual([CK.Control, CK.Shift].sort());
    mods.update({ controlKey: CK.Shift }, false);
    expect(mods.list()).toEqual([CK.Control]);
    expect(mods.clear()).toEqual([CK.Control]);
    expect(mods.list()).toEqual([]);
  });

  it("turns Guacamole mouse states into RustDesk events", () => {
    expect(mouseActions(0, 0, 10, 20, true)).toEqual([
      { mask: 0, x: 10, y: 20 },
    ]);
    expect(mouseActions(0, 1, 10, 20, false)).toEqual([
      { mask: (1 << 3) | 1, x: 10, y: 20 },
    ]);
    expect(mouseActions(1, 0, 10, 20, false)).toEqual([
      { mask: (1 << 3) | 2, x: 10, y: 20 },
    ]);
    // Right is Guacamole bit 4 and RustDesk button 2.
    expect(mouseActions(0, 4, 1, 1, false)[0].mask).toBe((2 << 3) | 1);
    expect(mouseActions(0, 2, 1, 1, false)[0].mask).toBe((4 << 3) | 1);
    expect(mouseActions(0, 8, 1, 1, false)).toEqual([{ mask: 3, x: 0, y: 1 }]);
    expect(mouseActions(0, 16, 1, 1, false)).toEqual([
      { mask: 3, x: 0, y: -1 },
    ]);
    expect(mouseActions(8, 8, 1, 1, false)).toEqual([]);
  });
});

describe("client helpers", () => {
  it("reads the browser's codecs, VP9 when it says nothing", () => {
    expect(parseDecodings("vp9,av1")).toEqual({
      vp9: true,
      vp8: false,
      av1: true,
    });
    expect(parseDecodings("")).toEqual({ vp9: true, vp8: false, av1: false });
  });

  it("splits big frames and marks the last chunk", () => {
    const small = frameChunks(Buffer.from([1, 2, 3]), true);
    expect(small).toHaveLength(1);
    expect(small[0][0]).toBe(FRAME_KEY | FRAME_END);
    const big = frameChunks(Buffer.alloc(400 * 1024, 5), false);
    expect(big.length).toBe(3);
    expect(big.slice(0, -1).every((c) => c[0] === 0)).toBe(true);
    expect(big.at(-1)![0]).toBe(FRAME_END);
    expect(big.reduce((n, c) => n + c.length - 1, 0)).toBe(400 * 1024);
    expect(frameChunks(new Uint8Array(0), false)).toHaveLength(1);
  });

  it("interleaves float audio into 16 bit PCM", () => {
    const pcm = toPcm16(
      [Float32Array.from([1, -1]), Float32Array.from([0, 0.5])],
      2,
    );
    expect([...new Int16Array(pcm.buffer, pcm.byteOffset, 4)]).toEqual([
      32767, 0, -32767, 16384,
    ]);
  });

  it("parses server addresses", () => {
    expect(parseAddress("rs.example.com", 21116)).toEqual({
      host: "rs.example.com",
      port: 21116,
    });
    expect(parseAddress("1.2.3.4:9000", 21116)).toEqual({
      host: "1.2.3.4",
      port: 9000,
    });
    expect(parseAddress("[::1]:9", 1)).toEqual({ host: "::1", port: 9 });
  });
});
