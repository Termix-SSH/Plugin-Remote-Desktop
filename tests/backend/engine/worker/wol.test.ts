import dgram from "node:dgram";
import { describe, expect, it } from "vitest";
import {
  magicPacket,
  normalizeLineEndings,
  sendMagicPacket,
} from "../../../../src/backend/engine/worker/wol.js";

describe("wake on lan", () => {
  it("builds the magic packet", () => {
    const packet = magicPacket("01:23:45:67:89:ab")!;
    expect(packet.length).toBe(102);
    expect(packet.subarray(0, 6).toString("hex")).toBe("ffffffffffff");
    expect(packet.subarray(96).toString("hex")).toBe("0123456789ab");
    expect(magicPacket("nope")).toBeNull();
  });

  it("sends it over UDP", async () => {
    const server = dgram.createSocket("udp4");
    await new Promise<void>((r) => server.bind(0, "127.0.0.1", () => r()));
    const got = new Promise<Buffer>((r) => server.once("message", r));
    await sendMagicPacket(
      "01-23-45-67-89-ab",
      "127.0.0.1",
      server.address().port,
    );
    expect((await got).length).toBe(102);
    server.close();
  });
});

describe("normalizeLineEndings", () => {
  it("follows guacd's modes", () => {
    expect(normalizeLineEndings("a\r\nb\rc\nd", "unix")).toBe("a\nb\nc\nd");
    expect(normalizeLineEndings("a\r\nb\nc", "windows")).toBe("a\r\nb\r\nc");
    expect(normalizeLineEndings("a\nb", "preserve")).toBe("a\nb");
  });
});
