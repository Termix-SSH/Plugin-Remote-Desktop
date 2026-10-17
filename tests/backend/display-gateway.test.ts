import { describe, expect, it, vi } from "vitest";
import {
  createDisplayGateway,
  usesBuiltinEngine,
} from "../../src/backend/display-gateway.js";
import { GuacamoleTokenService } from "../../src/backend/token-service.js";

describe("usesBuiltinEngine", () => {
  const none = () => false;

  it("follows the engine mode for a new session", () => {
    const token = { connection: { type: "rdp" as const, settings: {} } };
    expect(usesBuiltinEngine(token, "builtin", none)).toBe(true);
    expect(usesBuiltinEngine(token, "guacd", none)).toBe(false);
  });

  it("keeps a host with its own guacd on guacd", () => {
    const token = {
      connection: { type: "rdp" as const, guacdHost: "g", settings: {} },
    };
    expect(usesBuiltinEngine(token, "builtin", none)).toBe(false);
  });

  it("sends a join to wherever its session lives", () => {
    const token = { connection: { join: "$a", settings: {} } };
    expect(usesBuiltinEngine(token, "guacd", (id) => id === "$a")).toBe(true);
    expect(usesBuiltinEngine(token, "builtin", none)).toBe(false);
  });
});

describe("createDisplayGateway", () => {
  function setup() {
    const tokens = new GuacamoleTokenService();
    const builtin = { has: () => false, handleUpgrade: vi.fn() };
    const guacd = { handleUpgrade: vi.fn() };
    const gateway = createDisplayGateway({
      tokens,
      mode: () => "builtin",
      builtin,
      guacd,
    });
    const socket = { write: vi.fn(), destroy: vi.fn() };
    return { tokens, builtin, guacd, gateway, socket };
  }

  const request = (token: string) =>
    ({ url: `/display?token=${encodeURIComponent(token)}` }) as never;

  it("refuses a missing, forged or spent token", () => {
    const { tokens, gateway, socket, builtin, guacd } = setup();
    gateway({ url: "/display" } as never, socket as never, Buffer.alloc(0));
    gateway(request("nope"), socket as never, Buffer.alloc(0));
    const token = tokens.createRdpToken("h", "u", "p");
    gateway(request(token), socket as never, Buffer.alloc(0));
    gateway(request(token), socket as never, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalledTimes(3);
    expect(socket.write.mock.calls[0][0]).toContain("401");
    expect(builtin.handleUpgrade).toHaveBeenCalledOnce();
    expect(guacd.handleUpgrade).not.toHaveBeenCalled();
  });

  it("sends a per-host guacd token to guacd", () => {
    const { tokens, gateway, socket, guacd } = setup();
    const token = tokens.createRdpToken("h", "u", "p", { guacdHost: "g" });
    gateway(request(token), socket as never, Buffer.alloc(0));
    expect(guacd.handleUpgrade).toHaveBeenCalledOnce();
  });
});
