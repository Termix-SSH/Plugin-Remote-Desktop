import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  MoonlightError,
  type MoonlightClient,
  type MoonlightHost,
} from "../../../src/backend/moonlight/client.js";
import { registerMoonlightRoutes } from "../../../src/backend/moonlight/routes.js";
import type { PairJobs } from "../../../src/backend/moonlight/pairing.js";

const PC: MoonlightHost = {
  id: 5,
  name: "gaming",
  address: "10.0.0.9",
  port: 47989,
  paired: true,
  online: true,
  shared: true,
};

const ADMIN = {
  moonlightUrl: "http://moonlight.internal:8080",
  moonlightUsername: "termix",
  moonlightPassword: "hunter2",
};

const HOST = {
  enableMoonlight: true,
  moonlightHostId: 5,
  moonlightBitrate: 20000,
};

interface Options {
  client?: Partial<MoonlightClient>;
  pairJobs?: Partial<PairJobs>;
  admin?: Record<string, unknown>;
  host?: Record<string, unknown>;
  forced?: boolean;
  enabled?: boolean;
  target?: unknown;
  denied?: string[];
}

let servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  servers = [];
});

async function start(options: Options = {}) {
  const audit = vi.fn(async () => undefined);
  const denied = new Set(options.denied ?? []);
  const ctx = {
    rbac: {
      require:
        (permission: string) =>
        (
          _req: express.Request,
          res: express.Response,
          next: express.NextFunction,
        ) => {
          if (denied.has(permission)) {
            res.status(403).json({ error: "Forbidden" });
          } else next();
        },
    },
    currentActor: () => "user-1",
    settings: {
      getAll: async (scope: string) =>
        scope === "admin" ? (options.admin ?? ADMIN) : (options.host ?? HOST),
    },
    audit: { record: audit },
  } as unknown as PluginContext;
  const client: MoonlightClient = {
    check: async () => undefined,
    listHosts: async () => [PC],
    addHost: async () => PC,
    listApps: async () => [
      { id: 7, title: "Desktop" },
      { id: 8, title: "Steam" },
    ],
    pair: async () => ({ pin: "0000", result: Promise.resolve(true) }),
    ...options.client,
  };
  const router = express.Router();
  registerMoonlightRoutes(router, {
    ctx,
    log: { error: vi.fn() } as never,
    enabled: async () => options.enabled !== false,
    recordings: () => ({ isForced: async () => !!options.forced }) as never,
    resolveTarget: async () =>
      "target" in options ? options.target : { host: { id: 1 } },
    client,
    pairJobs: {
      start: async () => ({ id: "job-1", pin: "1234" }),
      state: () => "waiting",
      stopAll: () => undefined,
      ...options.pairJobs,
    },
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { request, audit };
}

describe("Moonlight launch", () => {
  it("returns the stream address and audits it", async () => {
    const { request, audit } = await start();

    const res = await request("POST", "/moonlight/launch/1");

    expect(res.status).toBe(200);
    expect(res.body.url).toBe(
      "http://moonlight.internal:8080/stream.html?hostId=5&appId=7&bitrate=20000",
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "moonlight_connect" }),
    );
  });

  it("uses the public address and the chosen app", async () => {
    const { request } = await start({
      admin: { ...ADMIN, moonlightPublicUrl: "https://ml.example.com" },
      host: { ...HOST, moonlightAppId: 8 },
    });

    const res = await request("POST", "/moonlight/launch/1");

    expect(res.body.url).toContain("https://ml.example.com/stream.html");
    expect(res.body.url).toContain("appId=8");
    expect(res.body.app).toBe("Steam");
  });

  it("stops when access is refused", async () => {
    const listHosts = vi.fn(async () => [PC]);
    const { request, audit } = await start({
      target: null,
      client: { listHosts },
    });

    // resolveTarget answers the request itself in the real plugin.
    await Promise.race([
      request("POST", "/moonlight/launch/1"),
      new Promise((done) => setTimeout(done, 100)),
    ]);

    expect(listHosts).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses when recording is required", async () => {
    const { request, audit } = await start({ forced: true });

    const res = await request("POST", "/moonlight/launch/1");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("recording-required");
    expect(audit).not.toHaveBeenCalled();
  });

  it("refuses when Moonlight is off for the host", async () => {
    const { request } = await start({ host: { enableMoonlight: false } });
    expect((await request("POST", "/moonlight/launch/1")).status).toBe(403);
  });

  it("refuses when Remote Desktop is off", async () => {
    const { request } = await start({ enabled: false });
    expect((await request("POST", "/moonlight/launch/1")).status).toBe(403);
  });

  it.each([
    ["not-linked", { host: { enableMoonlight: true } }],
    [
      "not-paired",
      { client: { listHosts: async () => [{ ...PC, paired: false }] } },
    ],
    [
      "offline",
      { client: { listHosts: async () => [{ ...PC, online: false }] } },
    ],
    ["no-apps", { client: { listApps: async () => [] } }],
  ] as [string, Options][])("answers %s", async (code, options) => {
    const { request } = await start(options);

    const res = await request("POST", "/moonlight/launch/1");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(code);
  });

  it("rejects a bad host id", async () => {
    const { request } = await start();
    expect((await request("POST", "/moonlight/launch/abc")).status).toBe(400);
  });
});

describe("Moonlight status", () => {
  it("says when it is not set up", async () => {
    const { request } = await start({
      client: {
        check: async () => {
          throw new MoonlightError("not-configured", "not set up");
        },
      },
    });

    const res = await request("GET", "/moonlight/status");

    expect(res.body).toMatchObject({ configured: false, reachable: false });
  });

  it("never returns the saved login", async () => {
    const { request } = await start({
      client: {
        check: async () => {
          throw new MoonlightError("bad-login", "refused");
        },
      },
    });

    const res = await request("GET", "/moonlight/status");

    expect(res.body).toMatchObject({ configured: true, code: "bad-login" });
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });
});

describe("Moonlight set up", () => {
  it("needs the set up permission to add or pair", async () => {
    const { request } = await start({ denied: ["moonlight"] });

    const add = await request("POST", "/moonlight/hosts", { address: "a" });
    const pair = await request("POST", "/moonlight/hosts/5/pair", {});

    expect(add.status).toBe(403);
    expect(pair.status).toBe(403);
  });

  it("still lists PCs without the set up permission", async () => {
    const { request } = await start({ denied: ["moonlight"] });
    expect((await request("GET", "/moonlight/hosts")).body.hosts).toEqual([PC]);
  });

  it("checks the address and port", async () => {
    const { request } = await start();

    const noAddress = await request("POST", "/moonlight/hosts", {});
    const badPort = await request("POST", "/moonlight/hosts", {
      address: "10.0.0.9",
      port: 70000,
    });

    expect(noAddress.status).toBe(400);
    expect(badPort.status).toBe(400);
  });

  it("uses the Sunshine default port", async () => {
    const addHost = vi.fn(async () => PC);
    const { request } = await start({ client: { addHost } });

    await request("POST", "/moonlight/hosts", { address: "10.0.0.9" });

    expect(addHost).toHaveBeenCalledWith("10.0.0.9", 47989);
  });

  it("passes on a Moonlight Web error by code", async () => {
    const { request } = await start({
      client: {
        addHost: async () => {
          throw new MoonlightError("needs-admin", "must be an admin");
        },
      },
    });

    const res = await request("POST", "/moonlight/hosts", { address: "a" });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("needs-admin");
  });

  it("starts pairing and reads the job", async () => {
    const { request } = await start();

    const job = await request("POST", "/moonlight/hosts/5/pair", {});
    const state = await request("GET", "/moonlight/pair/job-1");

    expect(job.body).toEqual({ id: "job-1", pin: "1234" });
    expect(state.body).toEqual({ state: "waiting" });
  });

  it("answers 404 for an unknown job", async () => {
    const { request } = await start({ pairJobs: { state: () => null } });
    expect((await request("GET", "/moonlight/pair/x")).status).toBe(404);
  });
});
