import { describe, expect, it } from "vitest";
import {
  codePointLength,
  encode,
  Parser,
} from "../../../src/backend/engine/protocol.js";
import {
  mergeSettings,
  parseQueryInt,
} from "../../../src/backend/engine/defaults.js";

describe("Guacamole protocol", () => {
  it("encodes lengths in code points", () => {
    expect(encode("size", 0, 1024, 768)).toBe("4.size,1.0,4.1024,3.768;");
    expect(encode("", "ping", 12)).toBe("0.,4.ping,2.12;");
    expect(codePointLength("a😀b")).toBe(3);
    expect(encode("clipboard", "😀")).toBe("9.clipboard,1.😀;");
  });

  it("parses instructions split across messages", () => {
    const parser = new Parser();
    expect(parser.receive("4.sync,3.1")).toEqual([]);
    expect(parser.receive("23;5.mouse,2.10,2.20,1.1;3.k")).toEqual([
      { opcode: "sync", args: ["123"] },
      { opcode: "mouse", args: ["10", "20", "1"] },
    ]);
    expect(parser.receive("ey,1.😀,1.1;")).toEqual([
      { opcode: "key", args: ["😀", "1"] },
    ]);
  });

  it("parses the empty internal opcode", () => {
    expect(new Parser().receive("0.,4.ping,3.123;")).toEqual([
      { opcode: "", args: ["ping", "123"] },
    ]);
  });

  it("rejects malformed input and runaway instructions", () => {
    expect(() => new Parser().receive("x.sync;")).toThrow();
    expect(() => new Parser().receive("4.syncX")).toThrow();
    expect(() => new Parser(8).receive("100.aaaaaaaaaaaaa")).toThrow();
  });
});

describe("connection settings", () => {
  it("reads the leading integer of old mobile query values", () => {
    expect(parseQueryInt("720?")).toBe(720);
    expect(parseQueryInt("1280")).toBe(1280);
    expect(parseQueryInt("abc")).toBeNull();
    expect(parseQueryInt("0")).toBeNull();
    expect(parseQueryInt(null)).toBeNull();
  });

  it("layers defaults, token settings and the client size", () => {
    const merged = mergeSettings(
      "rdp",
      { hostname: "h", "color-depth": 16, audio: ["a", "b"], skip: null },
      new URLSearchParams("width=1600&height=900?&dpi=120&password=x"),
    );
    expect(merged).toMatchObject({
      hostname: "h",
      port: "3389",
      security: "any",
      "color-depth": "16",
      audio: "a,b",
      width: "1600",
      height: "900",
      dpi: "120",
    });
    expect(merged).not.toHaveProperty("skip");
    // Only size comes from the URL.
    expect(merged).not.toHaveProperty("password");
  });

  it("ignores dpi in the URL for VNC", () => {
    const merged = mergeSettings("vnc", {}, new URLSearchParams("dpi=200"));
    expect(merged).not.toHaveProperty("dpi");
    expect(merged.port).toBe("5900");
  });
});
