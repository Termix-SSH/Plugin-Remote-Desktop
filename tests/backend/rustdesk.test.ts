import { describe, expect, it } from "vitest";
import { usesBuiltinEngine } from "../../src/backend/display-gateway.js";
import {
  isRemoteProtocol,
  normalizeImportedHost,
  readHostSettings,
} from "../../src/backend/host-settings.js";
import { rustdeskSettings } from "../../src/backend/routes.js";
import { GuacamoleTokenService } from "../../src/backend/token-service.js";

function ctxWith(admin: Record<string, unknown>, host = {}) {
  return {
    settings: {
      get: async (key: string) => admin[key],
      getAll: async () => host,
    },
  } as never;
}

describe("RustDesk hosts", () => {
  it("is a remote protocol", () => {
    expect(isRemoteProtocol("rustdesk")).toBe(true);
    expect(isRemoteProtocol("rustdesk2")).toBe(false);
  });

  it("reads its host settings", async () => {
    const settings = await readHostSettings(
      ctxWith(
        {},
        {
          enableRustdesk: true,
          rustdeskId: " 123 456 789 ",
          rustdeskDirect: false,
        },
      ),
      1,
    );
    expect(settings.enableRustdesk).toBe(true);
    expect(settings.rustdeskId).toBe("123 456 789");
    expect(settings.rustdeskPort).toBe(21118);
    expect(settings.rustdeskIdServer).toBe("");
  });

  it("imports its settings", () => {
    expect(
      normalizeImportedHost({
        pluginSettings: {
          "remote-desktop": {
            enableRustdesk: true,
            rustdeskId: "987654321",
            rustdeskIdServer: "rs.example.com",
            rustdeskDirect: false,
          },
        },
      }),
    ).toEqual({
      enableRustdesk: true,
      rustdeskId: "987654321",
      rustdeskIdServer: "rs.example.com",
      rustdeskDirect: false,
    });
  });

  it("always runs in the built-in engine", () => {
    const token = { connection: { type: "rustdesk" as const, settings: {} } };
    expect(usesBuiltinEngine(token, "guacd", () => false)).toBe(true);
  });

  it("round trips a token", () => {
    const tokens = new GuacamoleTokenService();
    const raw = tokens.createRustdeskToken({ "rustdesk-id": "1" });
    expect(tokens.decryptToken(raw)?.connection).toMatchObject({
      type: "rustdesk",
      settings: { "rustdesk-id": "1" },
    });
  });
});

describe("rustdeskSettings", () => {
  const base = {
    enableRustdesk: true,
    rustdeskId: "123456789",
    rustdeskDirect: false,
    rustdeskIdServer: "",
    rustdeskRelayServer: "",
    rustdeskKey: "",
  };
  const input = {
    hostname: "10.0.0.5",
    port: 21118,
    password: "pw",
    guacConfig: { "disable-audio": true },
  };

  it("uses the admin's server when the host has none", async () => {
    const out = await rustdeskSettings(
      ctxWith({
        rustdeskIdServer: "rs.example.com",
        rustdeskRelayServer: "relay.example.com",
        rustdeskKey: "KEY=",
      }),
      base as never,
      { ...input, code: "12 34-56", codecs: "vp9,av1" },
    );
    expect(out).toMatchObject({
      "rustdesk-id": "123456789",
      "id-server": "rs.example.com",
      "relay-server": "relay.example.com",
      "server-key": "KEY=",
      password: "pw",
      code: "123456",
      codecs: "vp9,av1",
      "disable-audio": true,
    });
  });

  it("uses the host's own server, relay and key together", async () => {
    const out = await rustdeskSettings(
      ctxWith({ rustdeskIdServer: "admin", rustdeskKey: "ADMIN=" }),
      { ...base, rustdeskIdServer: "own", rustdeskKey: "OWN=" } as never,
      input,
    );
    expect(out["id-server"]).toBe("own");
    expect(out["server-key"]).toBe("OWN=");
    expect(out["relay-server"]).toBe("");
  });

  it("drops codec lists it does not trust", async () => {
    const out = await rustdeskSettings(ctxWith({}), base as never, {
      ...input,
      codecs: "vp9;rm -rf",
    });
    expect(out.codecs).toBeUndefined();
  });
});
