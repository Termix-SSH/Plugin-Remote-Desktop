import http from "node:http";
import net, { type AddressInfo } from "node:net";
import express, { type Router } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMockCtx,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import type {
  PluginContext,
  PluginProtocolTarget,
} from "@termix-ssh/plugin-sdk/backend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { GuacamoleTokenService } from "../../src/backend/token-service.js";

const manifest = manifestJson as unknown as PluginManifest;

// Without a fixed key each token service picks its own.
process.env.GUACAMOLE_ENCRYPTION_KEY = "ab".repeat(32);

function target(
  overrides: Partial<PluginProtocolTarget["auth"]> = {},
): PluginProtocolTarget {
  return {
    host: {
      id: 7,
      name: "Win box",
      ip: "10.0.0.7",
      port: 22,
      ownerUserId: "user-1",
      jumpHosts: [],
    },
    shared: false,
    auth: {
      authType: "direct",
      username: "admin",
      password: "secret",
      fields: { domain: "CORP" },
      ...overrides,
    },
  };
}

interface Server {
  mock: MockPluginContext;
  request: (
    method: string,
    path: string,
    body?: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

let server: Server | null = null;

afterEach(async () => {
  delete process.env.REMOTE_DESKTOP_ENGINE;
  await server?.close();
  server = null;
});

async function start(
  options: {
    protocolTargets?: Record<string, PluginProtocolTarget>;
    services?: Record<string, object>;
    capabilities?: string[];
    permissions?: string[];
  } = {},
): Promise<Server> {
  let router: Router | null = null;
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: options.capabilities ?? manifest.capabilities,
    router: () => (router = express.Router()),
    protocolTargets: options.protocolTargets,
    services: options.services,
    permissions: options.permissions,
    hosts: [
      {
        id: 7,
        userId: "user-1",
        name: "Win box",
        ip: "10.0.0.7",
        port: 22,
        username: "admin",
        tags: null,
        folder: null,
        authType: "password",
      },
    ],
  });
  await activate(mock.ctx as PluginContext);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    mock.setActor(req.header("x-test-user") ?? "user-1");
    next();
  });
  app.use((req, res, next) => router!(req, res, next));
  const httpServer = http.createServer(app);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    mock,
    async request(method, path, body) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      for (const dispose of [...mock.disposals].reverse()) await dispose();
    },
  };
}

const tokens = new GuacamoleTokenService();

describe("POST /connect-host/:hostId", () => {
  it("mints a token from the resolved login and the host's own settings", async () => {
    server = await start({ protocolTargets: { "7:rdp": target() } });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    await server.mock.ctx.settings.setHost(7, "rdpPort", 3390);
    await server.mock.ctx.settings.setHost(7, "rdpSecurity", "nla");
    await server.mock.ctx.settings.setHost(7, "guacamoleConfig", {
      "color-depth": 16,
      "enable-wallpaper": "auto",
    });

    const response = await server.request("POST", "/connect-host/7", {
      protocol: "rdp",
    });

    expect(response.status).toBe(200);
    expect(response.body.termixConnectId).toEqual(expect.any(String));
    const token = tokens.decryptToken(response.body.token);
    expect(token?.connection.settings).toMatchObject({
      hostname: "10.0.0.7",
      port: 3390,
      username: "admin",
      password: "secret",
      domain: "CORP",
      security: "nla",
      "color-depth": 16,
    });
    expect(token?.connection.settings).not.toHaveProperty("enable-wallpaper");
    expect(token?.termixMeta).toMatchObject({
      hostId: 7,
      hostName: "Win box",
      protocol: "rdp",
    });
    expect(server.mock.audits.at(-1)).toMatchObject({
      action: "rdp_connect",
      success: true,
    });
  });

  it("puts the host's display settings under its own guacd settings", async () => {
    server = await start({ protocolTargets: { "7:rdp": target() } });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    await server.mock.ctx.settings.setHost(7, "guacamoleConfig", {
      "color-depth": 32,
    });
    // What the host follows from its defaults.
    await server.mock.ctx.settings.setHost(7, "colorDepth", "16");
    await server.mock.ctx.settings.setHost(7, "disableCopy", "on");

    const response = await server.request("POST", "/connect-host/7", {
      protocol: "rdp",
    });
    const settings = tokens.decryptToken(response.body.token)?.connection
      .settings;
    expect(settings?.["color-depth"]).toBe(32);
    expect(settings?.["disable-copy"]).toBe(true);
  });

  it("uses the prompted login when the host asks at connect time", async () => {
    server = await start({
      protocolTargets: { "7:rdp": target({ authType: "none", username: "" }) },
    });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);

    const response = await server.request("POST", "/connect-host/7", {
      protocol: "rdp",
      promptedUsername: "bob",
      promptedPassword: "pw",
      promptedDomain: "",
    });
    const settings = tokens.decryptToken(response.body.token)?.connection
      .settings;
    expect(settings).toMatchObject({ username: "bob", password: "pw" });
  });

  it("sends an ARD host to guacd as vnc and keeps ard in the session meta", async () => {
    server = await start({
      protocolTargets: { "7:ard": target({ username: "mac" }) },
    });
    await server.mock.ctx.settings.setHost(7, "enableArd", true);
    await server.mock.ctx.settings.setHost(7, "ardPort", 5901);

    const response = await server.request("POST", "/connect-host/7", {
      protocol: "ard",
    });
    expect(response.status).toBe(200);
    const token = tokens.decryptToken(response.body.token);
    expect(token?.connection.type).toBe("vnc");
    expect(token?.connection.settings).toMatchObject({
      hostname: "10.0.0.7",
      port: 5901,
      username: "mac",
      password: "secret",
    });
    expect(token?.termixMeta?.protocol).toBe("ard");
    expect(token?.recording).toBeUndefined();
  });

  it("refuses ARD while the host has it switched off", async () => {
    server = await start({ protocolTargets: { "7:ard": target() } });
    const response = await server.request("POST", "/connect-host/7", {
      protocol: "ard",
    });
    expect(response.status).toBe(400);
  });

  it("mints an ARD quick-connect token as a vnc connection", async () => {
    server = await start();
    const response = await server.request("POST", "/token", {
      type: "ard",
      hostname: "10.0.0.9",
      username: "mac",
      password: "pw",
    });
    expect(response.status).toBe(200);
    const token = tokens.decryptToken(response.body.token);
    expect(token?.connection.type).toBe("vnc");
    expect(token?.connection.settings).toMatchObject({
      hostname: "10.0.0.9",
      port: 5900,
      username: "mac",
    });
  });

  it("refuses a protocol the host has switched off", async () => {
    server = await start({ protocolTargets: { "7:vnc": target() } });
    const response = await server.request("POST", "/connect-host/7", {
      protocol: "vnc",
    });
    expect(response.status).toBe(400);
  });

  it("answers 404 when the caller cannot reach the host", async () => {
    server = await start();
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    const response = await server.request("POST", "/connect-host/7", {
      protocol: "rdp",
    });
    expect(response.status).toBe(404);
  });

  it("refuses everything while an admin has turned it off", async () => {
    server = await start({ protocolTargets: { "7:rdp": target() } });
    await server.mock.ctx.settings.set("enabled", false);
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);

    expect(
      (await server.request("POST", "/connect-host/7", { protocol: "rdp" }))
        .status,
    ).toBe(403);
    expect(
      (
        await server.request("POST", "/token", {
          type: "rdp",
          hostname: "10.0.0.9",
        })
      ).status,
    ).toBe(403);
    const status = await server.request("GET", "/status?probe=0");
    expect(status.body.enabled).toBe(false);
  });

  it("records only when session recording is on for the host", async () => {
    const enabledFor = async (hostId: number) => hostId === 7;
    server = await start({
      protocolTargets: { "7:rdp": target() },
      services: {
        "recordings.writer": {
          enabledFor,
          createFinished: async () => ({ id: 1 }),
        },
      },
    });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    const response = await server.request("POST", "/connect-host/7", {
      protocol: "rdp",
    });
    const token = tokens.decryptToken(response.body.token);
    expect(token?.recording).toMatchObject({ hostId: 7, protocol: "rdp" });
    expect(token?.connection.settings["recording-name"]).toEqual(
      expect.any(String),
    );
  });
});

describe("without session recording", () => {
  it("connects when the recording service is gone", async () => {
    server = await start({
      protocolTargets: { "7:rdp": target() },
      services: {
        "recordings.writer": {
          enabledFor: async () => {
            throw new Error(
              'Service "recordings.writer" is no longer provided',
            );
          },
          createFinished: async () => ({ id: 1 }),
        },
      },
    });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    const response = await server.request("POST", "/connect-host/7", {
      protocol: "rdp",
    });
    expect(response.status).toBe(200);
    const token = tokens.decryptToken(response.body.token);
    expect(token?.recording).toBeUndefined();
  });
});

describe("the rest of the routes", () => {
  it("mints a quick connect token with the caller's defaults", async () => {
    server = await start();
    await server.mock.ctx.settings.setUser("user-1", "colorDepth", "24");
    const response = await server.request("POST", "/token", {
      type: "rdp",
      hostname: "10.0.0.9",
      username: "u",
      password: "p",
    });
    expect(response.status).toBe(200);
    expect(
      tokens.decryptToken(response.body.token)?.connection.settings,
    ).toMatchObject({ hostname: "10.0.0.9", port: 3389, "color-depth": 24 });
  });

  it("ignores guacd and path settings a quick connect tries to set", async () => {
    server = await start();
    const response = await server.request("POST", "/token", {
      type: "rdp",
      hostname: "10.0.0.9",
      guacdHost: "attacker.example",
      guacdPort: 4822,
      "drive-path": "/etc",
      "recording-path": "/tmp/x",
      width: 800,
    });
    expect(response.status).toBe(200);
    const token = tokens.decryptToken(response.body.token);
    expect(token?.connection.guacdHost).toBeUndefined();
    expect(token?.connection.guacdPort).toBeUndefined();
    expect(token?.connection.settings["drive-path"]).toBeUndefined();
    expect(token?.connection.settings["recording-path"]).toBeUndefined();
    expect(token?.connection.settings.width).toBe(800);
  });

  it("drops VNC listen mode from a quick connect", async () => {
    server = await start();
    const response = await server.request("POST", "/token", {
      type: "vnc",
      hostname: "10.0.0.9",
      "reverse-connect": true,
      "listen-timeout": 60000,
    });
    expect(response.status).toBe(200);
    const settings = tokens.decryptToken(response.body.token)?.connection
      .settings;
    expect(settings?.["reverse-connect"]).toBeUndefined();
    expect(settings?.["listen-timeout"]).toBeUndefined();
  });

  it("needs the sessions permission to mint a token", async () => {
    server = await start({ permissions: [] });
    const quick = await server.request("POST", "/token", {
      type: "rdp",
      hostname: "10.0.0.9",
    });
    expect(quick.status).toBe(403);
    const saved = await server.request("POST", "/connect-host/1", {});
    expect(saved.status).toBe(403);
  });

  it("offers native RDP only in the desktop app", async () => {
    server = await start();
    expect((await server.request("GET", "/native-rdp")).body).toEqual({
      available: false,
    });
    expect(
      (await server.request("POST", "/native-rdp", { host: "10.0.0.7" }))
        .status,
    ).toBe(404);
  });

  it("does not hand out another user's session id", async () => {
    server = await start();
    const response = await server.request("GET", "/connection/unknown");
    expect(response.body).toEqual({ guacamoleConnectionId: null });
  });
});

describe("activate", () => {
  it("fails closed without network:serve", async () => {
    await expect(
      start({
        capabilities: manifest.capabilities.filter(
          (capability) => capability !== "network:serve",
        ),
      }),
    ).rejects.toThrow(/network:serve/);
  });

  it("cannot read a host's login without credentials:read", async () => {
    server = await start({
      protocolTargets: { "7:rdp": target() },
      capabilities: manifest.capabilities.filter(
        (capability) => capability !== "credentials:read",
      ),
    });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    const response = await server.request("POST", "/connect-host/7", {
      protocol: "rdp",
    });
    expect(response.status).toBe(500);
    expect(server.mock.checked).toContain("credentials:read");
  });

  it("provides sessions.live for rdp, vnc, ard and telnet", async () => {
    server = await start();
    expect([...server.mock.services.keys()].sort()).toEqual(
      expect.arrayContaining([
        "sessions.live#ard",
        "sessions.live#rdp",
        "sessions.live#telnet",
        "sessions.live#vnc",
      ]),
    );
  });
});

describe("saved host guacd status", () => {
  it("probes the same override used by the connection token", async () => {
    const guacd = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => guacd.listen(0, "127.0.0.1", resolve));
    try {
      const port = (guacd.address() as AddressInfo).port;
      server = await start({ protocolTargets: { "7:rdp": target() } });
      await server.mock.ctx.settings.setHost(7, "enableRdp", true);
      const saved = await server.request("PUT", "/guacd-host/7", {
        hostname: "127.0.0.1",
        port,
      });
      expect(saved.status).toBe(200);
      const status = await server.request(
        "GET",
        "/status?hostId=7&protocol=rdp",
      );
      expect(status.status).toBe(200);
      expect(status.body.guacd).toEqual({
        host: "127.0.0.1",
        port,
        status: "connected",
      });
      const result = await server.request("POST", "/connect-host/7", {
        protocol: "rdp",
      });
      expect(tokens.decryptToken(result.body.token)?.connection).toMatchObject({
        guacdHost: status.body.guacd.host,
        guacdPort: status.body.guacd.port,
      });
    } finally {
      await new Promise<void>((resolve) => guacd.close(() => resolve()));
    }
  });

  it("keeps the global port for a host-only override and global config when absent", async () => {
    process.env.REMOTE_DESKTOP_ENGINE = "guacd";
    server = await start({ protocolTargets: { "7:rdp": target() } });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    const global = await server.request("GET", "/status?probe=0");
    const inherited = await server.request(
      "GET",
      "/status?probe=0&hostId=7&protocol=rdp",
    );
    expect(inherited.body.guacd).toEqual(global.body.guacd);
    await server.request("PUT", "/guacd-host/7", {
      hostname: "custom.example",
    });
    const overridden = await server.request(
      "GET",
      "/status?probe=0&hostId=7&protocol=rdp",
    );
    expect(overridden.body.guacd).toEqual({
      ...global.body.guacd,
      host: "custom.example",
    });
  });

  it("refuses a host the caller cannot resolve", async () => {
    server = await start();
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    const result = await server.request("GET", "/status?hostId=7&protocol=rdp");
    expect(result.status).toBe(404);
    expect(result.body.guacd).toBeUndefined();
  });

  it("refuses disabled protocols", async () => {
    server = await start({ protocolTargets: { "7:rdp": target() } });
    const result = await server.request("GET", "/status?hostId=7&protocol=rdp");
    expect(result.status).toBe(400);
  });

  it.each([
    "hostId=bad&protocol=rdp",
    "hostId=0&protocol=rdp",
    "hostId=7&protocol=ssh",
    "hostId=7",
  ])("rejects invalid queries: %s", async (query) => {
    server = await start();
    expect((await server.request("GET", `/status?${query}`)).status).toBe(400);
  });
});

describe("per-host guacd address", () => {
  it("ignores a guacd address written into the host's guacamoleConfig", async () => {
    server = await start({ protocolTargets: { "7:rdp": target() } });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    const global = await server.request("GET", "/status?probe=0");
    await server.mock.ctx.settings.setHost(7, "guacamoleConfig", {
      "guacd-hostname": "attacker.example",
      "guacd-port": "6000",
    });

    const status = await server.request(
      "GET",
      "/status?probe=0&hostId=7&protocol=rdp",
    );
    expect(status.body.guacd).toEqual(global.body.guacd);
    const result = await server.request("POST", "/connect-host/7", {
      protocol: "rdp",
    });
    const connection = tokens.decryptToken(result.body.token)?.connection;
    expect(connection?.guacdHost).toBeUndefined();
    expect(connection?.settings).not.toHaveProperty("guacd-hostname");
  });

  it("lets only admins set it", async () => {
    server = await start({
      protocolTargets: { "7:rdp": target() },
      permissions: ["remote-desktop.sessions"],
    });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    const global = await server.request("GET", "/status?probe=0");

    const denied = await server.request("PUT", "/guacd-host/7", {
      hostname: "attacker.example",
    });
    expect(denied.status).toBe(403);
    const read = await server.request("GET", "/guacd-host/7");
    expect(read.body).toEqual({ hostname: "", port: null, canEdit: false });
    const status = await server.request(
      "GET",
      "/status?probe=0&hostId=7&protocol=rdp",
    );
    expect(status.body.guacd).toEqual(global.body.guacd);
  });

  it("saves, reads back and clears an admin's address", async () => {
    server = await start({
      protocolTargets: { "7:rdp": target() },
      permissions: ["remote-desktop.sessions", "admin.plugins.manage"],
    });
    const saved = await server.request("PUT", "/guacd-host/7", {
      hostname: " guacd-2 ",
      port: "4823",
    });
    expect(saved.body).toEqual({
      hostname: "guacd-2",
      port: 4823,
      canEdit: true,
    });
    expect(
      await server.mock.ctx.settings.getHost(7, "guacamoleConfig"),
    ).toEqual({ "guacd-hostname": "guacd-2", "guacd-port": "4823" });
    expect((await server.request("GET", "/guacd-host/7")).body).toEqual(
      saved.body,
    );

    await server.request("PUT", "/guacd-host/7", { hostname: "", port: null });
    expect((await server.request("GET", "/guacd-host/7")).body).toEqual({
      hostname: "",
      port: null,
      canEdit: true,
    });
  });

  it("keeps addresses hosts already had, once", async () => {
    const { migrateGuacdHosts } =
      await import("../../src/backend/guacd-host.js");
    server = await start({ protocolTargets: { "7:rdp": target() } });
    const ctx = server.mock.ctx as PluginContext;
    await ctx.settings.set("hostGuacdMigrated", false);
    await ctx.settings.setHost(7, "guacamoleConfig", {
      "guacd-hostname": "old-guacd",
      "guacd-port": "4900",
    });
    await migrateGuacdHosts(ctx);
    expect((await server.request("GET", "/guacd-host/7")).body).toMatchObject({
      hostname: "old-guacd",
      port: 4900,
    });

    // Written after the move, it no longer counts.
    await ctx.settings.setHost(8, "guacamoleConfig", {
      "guacd-hostname": "new-guacd",
    });
    await migrateGuacdHosts(ctx);
    expect(await ctx.settings.get("hostGuacd")).toEqual({
      "7": { hostname: "old-guacd", port: 4900 },
    });
  });
});

describe("built-in engine", () => {
  it("reports a connected guacd so older clients still connect", async () => {
    server = await start();
    const status = await server.request("GET", "/status");
    expect(status.body).toMatchObject({
      enabled: true,
      engine: "builtin",
      guacd: { status: "connected" },
    });
  });

  it("reports guacd when REMOTE_DESKTOP_ENGINE says so", async () => {
    process.env.REMOTE_DESKTOP_ENGINE = "guacd";
    server = await start();
    const status = await server.request("GET", "/status?probe=0");
    expect(status.body.engine).toBe("guacd");
    expect(status.body.guacd.status).toBe("disconnected");
  });

  it("returns the session id up front for a saved host", async () => {
    server = await start({ protocolTargets: { "7:rdp": target() } });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    const response = await server.request("POST", "/connect-host/7", {
      protocol: "rdp",
    });
    expect(response.body.guacamoleConnectionId).toBe(
      `$${response.body.termixConnectId}`,
    );
  });

  it("keeps a host with its own guacd on guacd", async () => {
    server = await start({ protocolTargets: { "7:rdp": target() } });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    await server.request("PUT", "/guacd-host/7", { hostname: "guacd.lan" });
    const status = await server.request(
      "GET",
      "/status?probe=0&hostId=7&protocol=rdp",
    );
    expect(status.body.engine).toBe("guacd");
    const response = await server.request("POST", "/connect-host/7", {
      protocol: "rdp",
    });
    expect(response.body.guacamoleConnectionId).toBeNull();
  });

  it("tunnels jump hosts on loopback, where the engine dials", async () => {
    const forward = vi.fn(
      async (_hop: number, target: { bindHost?: string }) => ({
        bindHost: target.bindHost ?? "",
        bindPort: 4444,
        close: async () => {},
      }),
    );
    const jumped = target();
    jumped.host.jumpHosts = [{ hostId: 3 }] as never;
    server = await start({
      protocolTargets: { "7:rdp": jumped },
      services: { "tunnels.access": { forward } },
    });
    await server.mock.ctx.settings.setHost(7, "enableRdp", true);
    const response = await server.request("POST", "/connect-host/7", {
      protocol: "rdp",
    });
    expect(forward.mock.calls[0][1]).toMatchObject({
      targetHost: "10.0.0.7",
      targetPort: 3389,
      bindHost: "127.0.0.1",
    });
    expect(
      tokens.decryptToken(response.body.token)?.connection.settings,
    ).toMatchObject({ hostname: "127.0.0.1", port: 4444 });
  });

  it("sends RD Gateway hosts to a configured guacd", async () => {
    process.env.GUACD_HOST = "guacd.lan";
    try {
      server = await start({ protocolTargets: { "7:rdp": target() } });
      await server.mock.ctx.settings.setHost(7, "enableRdp", true);
      await server.mock.ctx.settings.setHost(7, "guacamoleConfig", {
        "gateway-hostname": "gw.example.com",
      });
      const response = await server.request("POST", "/connect-host/7", {
        protocol: "rdp",
      });
      expect(
        tokens.decryptToken(response.body.token)?.connection.guacdHost,
      ).toBe("guacd.lan");
      expect(response.body.guacamoleConnectionId).toBeNull();
    } finally {
      delete process.env.GUACD_HOST;
    }
  });

  it("records VNC sessions", async () => {
    const createFinished = vi.fn();
    server = await start({
      protocolTargets: { "7:vnc": target({ username: "" }) },
      services: {
        "recordings.writer": {
          enabledFor: async () => true,
          createFinished,
        },
      },
    });
    await server.mock.ctx.settings.setHost(7, "enableVnc", true);
    const response = await server.request("POST", "/connect-host/7", {
      protocol: "vnc",
    });
    const token = tokens.decryptToken(response.body.token);
    expect(token?.recording).toMatchObject({ protocol: "vnc" });
    // No macOS banner proxy: the engine dials the host itself.
    expect(token?.connection.settings).toMatchObject({
      hostname: "10.0.0.7",
      port: 5900,
    });
  });
});
