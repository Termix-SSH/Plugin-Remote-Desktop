import { describe, expect, it } from "vitest";
import {
  buildRdpFile,
  launchNativeRdp,
  validateNativeRdpOptions,
} from "../../src/backend/native-rdp";

describe("native Windows RDP", () => {
  it("creates a credential-prompting RDP file without a password", () => {
    const result = buildRdpFile({
      host: "server.example.com",
      port: 3390,
      username: "alice",
      domain: "EXAMPLE",
      password: "must-not-be-written",
    } as never);

    expect(result).toContain("full address:s:server.example.com:3390");
    expect(result).toContain("username:s:EXAMPLE\\alice");
    expect(result).toContain("prompt for credentials:i:1");
    expect(result).not.toContain("must-not-be-written");
  });

  it("brackets an IPv6 address", () => {
    expect(buildRdpFile({ host: "fe80::1" })).toContain(
      "full address:s:[fe80::1]:3389",
    );
  });

  it("rejects unsafe host and port values", () => {
    expect(() =>
      validateNativeRdpOptions({ host: "bad\r\nvalue" }),
    ).not.toThrow();
    expect(() => validateNativeRdpOptions({ host: "server/path" })).toThrow();
    expect(() =>
      validateNativeRdpOptions({ host: "server", port: 70000 }),
    ).toThrow();
  });

  it("only opens on Windows", async () => {
    expect(await launchNativeRdp({ host: "server" }, "linux")).toMatchObject({
      success: false,
    });
  });
});
