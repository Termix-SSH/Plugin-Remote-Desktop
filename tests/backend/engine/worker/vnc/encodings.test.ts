import crypto from "node:crypto";
import zlib from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import wasmBytes from "../../../../../src/backend/engine/wasm/engine_bg.wasm";
import {
  loadWasm,
  type Wasm,
} from "../../../../../src/backend/engine/worker/wasm.js";
import { ByteReader } from "../../../../../src/backend/engine/worker/vnc/reader.js";
import {
  decodeCursor,
  decodeHextile,
  decodeRaw,
  decodeRre,
  decodeTight,
  decodeZrle,
  type Framebuffer,
  type InflateStream,
} from "../../../../../src/backend/engine/worker/vnc/encodings.js";
import { vncAuthResponse } from "../../../../../src/backend/engine/worker/vnc/des.js";
import {
  ardResponse,
  msLogonResponse,
  plainCredentials,
  ultraEncrypt,
} from "../../../../../src/backend/engine/worker/vnc/auth.js";

let wasm: Wasm;
beforeAll(() => {
  wasm = loadWasm(new WebAssembly.Module(wasmBytes as BufferSource));
});

class TestFb implements Framebuffer {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
  }
  view() {
    return this.data;
  }
  copy() {}
  jpeg() {
    return false;
  }
  px(x: number, y: number) {
    const o = (y * this.width + x) * 4;
    return [...this.data.subarray(o, o + 4)];
  }
}

const reader = (bytes: number[] | Buffer) => {
  const r = new ByteReader();
  r.push(Buffer.from(bytes));
  return r;
};

const RED = [255, 0, 0, 0];
const BLUE = [0, 0, 255, 0];

const inflater = (): InflateStream => {
  let inner = new wasm.Inflater();
  return {
    inflate: (input, expected) => inner.inflate(input, expected),
    reset: () => {
      inner.free();
      inner = new wasm.Inflater();
    },
  };
};

describe("VNC encodings", () => {
  it("decodes Raw", async () => {
    const fb = new TestFb(2, 1);
    await decodeRaw(reader([...RED, ...BLUE]), fb, { x: 0, y: 0, w: 2, h: 1 });
    expect(fb.px(0, 0)).toEqual([255, 0, 0, 255]);
    expect(fb.px(1, 0)).toEqual([0, 0, 255, 255]);
  });

  it("decodes RRE", async () => {
    const fb = new TestFb(4, 4);
    const bytes = [0, 0, 0, 1, ...RED, ...BLUE, 0, 1, 0, 1, 0, 2, 0, 2];
    await decodeRre(reader(bytes), fb, { x: 0, y: 0, w: 4, h: 4 });
    expect(fb.px(0, 0)).toEqual([255, 0, 0, 255]);
    expect(fb.px(1, 1)).toEqual([0, 0, 255, 255]);
    expect(fb.px(3, 3)).toEqual([255, 0, 0, 255]);
  });

  it("decodes Hextile with a background and coloured subrects", async () => {
    const fb = new TestFb(16, 16);
    // Background, any subrects, subrects coloured: one 2x2 blue at (4, 5).
    const bytes = [2 | 8 | 16, ...RED, 1, ...BLUE, (4 << 4) | 5, (1 << 4) | 1];
    await decodeHextile(reader(bytes), fb, { x: 0, y: 0, w: 16, h: 16 });
    expect(fb.px(0, 0)).toEqual([255, 0, 0, 255]);
    expect(fb.px(4, 5)).toEqual([0, 0, 255, 255]);
    expect(fb.px(5, 6)).toEqual([0, 0, 255, 255]);
    expect(fb.px(6, 6)).toEqual([255, 0, 0, 255]);
  });

  it("decodes ZRLE solid, packed palette and RLE tiles", async () => {
    const fb = new TestFb(4, 2);
    // One tile: palette of 2, 1 bit per pixel, rows padded to a byte.
    const tile = Buffer.from([2, 255, 0, 0, 0, 0, 255, 0b01010000, 0b10100000]);
    const zipped = zlib.deflateSync(tile);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(zipped.length);
    await decodeZrle(
      reader(Buffer.concat([head, zipped])),
      fb,
      { x: 0, y: 0, w: 4, h: 2 },
      inflater(),
    );
    expect(fb.px(0, 0)).toEqual([255, 0, 0, 255]);
    expect(fb.px(1, 0)).toEqual([0, 0, 255, 255]);
    expect(fb.px(0, 1)).toEqual([0, 0, 255, 255]);

    const rle = new TestFb(4, 2);
    // Plain RLE: blue for 3 pixels, then red for 5.
    const runs = Buffer.from([128, 0, 0, 255, 2, 255, 0, 0, 4]);
    const z2 = zlib.deflateSync(runs);
    const h2 = Buffer.alloc(4);
    h2.writeUInt32BE(z2.length);
    await decodeZrle(
      reader(Buffer.concat([h2, z2])),
      rle,
      { x: 0, y: 0, w: 4, h: 2 },
      inflater(),
    );
    expect(rle.px(2, 0)).toEqual([0, 0, 255, 255]);
    expect(rle.px(3, 0)).toEqual([255, 0, 0, 255]);
    expect(rle.px(3, 1)).toEqual([255, 0, 0, 255]);
  });

  it("decodes Tight fill, palette and zlib copy", async () => {
    const state = { streams: [0, 1, 2, 3].map(() => inflater()) };
    const fb = new TestFb(8, 2);
    await decodeTight(
      reader([0x80, 0, 255, 0]),
      fb,
      { x: 0, y: 0, w: 8, h: 2 },
      state,
    );
    expect(fb.px(7, 1)).toEqual([0, 255, 0, 255]);

    // Palette of two, one bit per pixel: under 12 bytes, so not compressed.
    await decodeTight(
      reader([0x40, 1, 1, 255, 0, 0, 0, 0, 255, 0b10000000, 0b00000001]),
      fb,
      { x: 0, y: 0, w: 8, h: 2 },
      state,
    );
    expect(fb.px(0, 0)).toEqual([0, 0, 255, 255]);
    expect(fb.px(1, 0)).toEqual([255, 0, 0, 255]);
    expect(fb.px(7, 1)).toEqual([0, 0, 255, 255]);

    // Copy filter through stream 1, with a compact length.
    const pixels = Buffer.alloc(8 * 2 * 3, 7);
    const zipped = zlib.deflateSync(pixels);
    await decodeTight(
      reader([0x10, zipped.length, ...zipped]),
      fb,
      { x: 0, y: 0, w: 8, h: 2 },
      state,
    );
    expect(fb.px(3, 1)).toEqual([7, 7, 7, 255]);
  });

  it("reads a cursor with its mask", async () => {
    const rgba = await decodeCursor(reader([...RED, ...BLUE, 0b10000000]), {
      x: 0,
      y: 0,
      w: 2,
      h: 1,
    });
    expect([...rgba]).toEqual([255, 0, 0, 255, 0, 0, 255, 0]);
  });
});

describe("VNC authentication", () => {
  it("answers VncAuth with the first 8 password characters", () => {
    // Only the first 8 characters of a VNC password count.
    const challenge = Buffer.alloc(16, 0);
    const answer = Buffer.from(vncAuthResponse("password", challenge));
    expect(answer.subarray(0, 8)).toEqual(answer.subarray(8, 16));
    expect(answer.length).toBe(16);
    expect(Buffer.from(vncAuthResponse("passwordEXTRA", challenge))).toEqual(
      answer,
    );
  });

  it("builds an ARD response the server can decrypt", () => {
    const server = crypto.createDiffieHellman(512);
    server.generateKeys();
    const prime = server.getPrime();
    const reply = ardResponse(
      Buffer.from([0, 2]),
      prime,
      server.getPublicKey(),
      "alice",
      "secret",
    );
    const clientKey = reply.subarray(128);
    const secret = server.computeSecret(clientKey);
    const padded = Buffer.concat([
      Buffer.alloc(prime.length - secret.length),
      secret,
    ]);
    const key = crypto.createHash("md5").update(padded).digest();
    const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([
      decipher.update(reply.subarray(0, 128)),
      decipher.final(),
    ]);
    expect(plain.subarray(0, 6).toString()).toBe("alice\0");
    expect(plain.subarray(64, 71).toString()).toBe("secret\0");
  });

  it("agrees on an MS-Logon II key with the server", () => {
    const mod = 0xfffffffffffffc5n;
    const gen = 5n;
    const serverPriv = 0x1234567n;
    const pow = (b: bigint, e: bigint) => {
      let r = 1n;
      let x = b % mod;
      for (let k = e; k > 0n; k >>= 1n) {
        if (k & 1n) r = (r * x) % mod;
        x = (x * x) % mod;
      }
      return r;
    };
    const u64 = (n: bigint) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(n);
      return b;
    };
    const reply = msLogonResponse(
      u64(gen),
      u64(mod),
      u64(pow(gen, serverPriv)),
      "alice",
      "secret",
      0x9abcdefn,
    );
    expect(reply.length).toBe(8 + 256 + 64);
    const shared = u64(pow(reply.readBigUInt64BE(0), serverPriv));
    const user = Buffer.alloc(256);
    user.write("alice", "latin1");
    expect(reply.subarray(8, 264)).toEqual(ultraEncrypt(user, shared));
    expect(reply.subarray(8, 16)).not.toEqual(user.subarray(0, 8));
  });

  it("packs VeNCrypt Plain credentials", () => {
    expect(plainCredentials("ab", "c")).toEqual(
      Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 0x61, 0x62, 0x63]),
    );
  });
});
