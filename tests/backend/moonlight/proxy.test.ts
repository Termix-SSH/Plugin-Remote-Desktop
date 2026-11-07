import http from "node:http";
import type { AddressInfo } from "node:net";
import vm from "node:vm";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { MoonlightClient } from "../../../src/backend/moonlight/client.js";
import {
  allowedRequest,
  configScript,
  createGrants,
  createHttpProxy,
  hostIdFromJson,
  proxyLocation,
  readClientFrame,
  sdpHostId,
} from "../../../src/backend/moonlight/proxy.js";

const CONFIG = {
  url: "http://moonlight.test:8090",
  username: "admin",
  password: "secret",
  ignoreCert: false,
};

describe("allowedRequest", () => {
  it("passes the stream page, its files and its calls", () => {
    expect(allowedRequest("GET", "/stream.html")).toBe(true);
    expect(allowedRequest("GET", "/stream.js")).toBe(true);
    expect(allowedRequest("GET", "/resources/moonlight.svg")).toBe(true);
    expect(allowedRequest("GET", "/api/authenticate")).toBe(true);
    expect(allowedRequest("POST", "/api/host/stream/webrtc")).toBe(true);
    expect(allowedRequest("PATCH", "/api/host/stream/webrtc/0")).toBe(true);
    expect(allowedRequest("DELETE", "/api/host/stream/webrtc/0")).toBe(true);
  });

  it("keeps Moonlight Web's own pages and other calls out", () => {
    expect(allowedRequest("GET", "/admin.html")).toBe(false);
    expect(allowedRequest("GET", "/index.html")).toBe(false);
    expect(allowedRequest("GET", "/api/user")).toBe(false);
    expect(allowedRequest("POST", "/api/host")).toBe(false);
    expect(allowedRequest("GET", "/resources/../data.json")).toBe(false);
    expect(allowedRequest("DELETE", "/api/host/stream/webrtc")).toBe(false);
  });
});

describe("proxyLocation", () => {
  it("makes a Moonlight Web location relative to the stream page", () => {
    expect(proxyLocation("/api/host/stream/webrtc/0", CONFIG)).toBe(
      "api/host/stream/webrtc/0",
    );
    expect(
      proxyLocation(
        "http://moonlight.test:8090/api/host/stream/webrtc/3",
        CONFIG,
      ),
    ).toBe("api/host/stream/webrtc/3");
  });

  it("strips a base path and leaves other sites alone", () => {
    const sub = { ...CONFIG, url: "https://example.test/moonlight/" };
    expect(proxyLocation("/moonlight/api/host/stream/webrtc/1", sub)).toBe(
      "api/host/stream/webrtc/1",
    );
    expect(proxyLocation("https://elsewhere.test/x", CONFIG)).toBe(
      "https://elsewhere.test/x",
    );
  });
});

describe("host ids", () => {
  it("reads the offer's x-moonlight-host-id line", () => {
    const sdp =
      "v=0\r\na=x-moonlight-app-id:7\r\na=x-moonlight-host-id:3838911079\r\n";
    expect(sdpHostId(sdp)).toBe(3838911079);
    expect(sdpHostId("v=0\r\n")).toBeNull();
  });

  it("reads the socket's first message", () => {
    expect(hostIdFromJson('{"Request":{"host_id":42,"app_id":1}}')).toBe(42);
    expect(hostIdFromJson('{"hostId":5}')).toBe(5);
    expect(hostIdFromJson("not json")).toBeNull();
    expect(hostIdFromJson('{"Request":{}}')).toBeNull();
  });
});

describe("readClientFrame", () => {
  const masked = (text: string) => {
    const payload = Buffer.from(text);
    const mask = Buffer.from([1, 2, 3, 4]);
    const head =
      payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.from([
            0x81,
            0x80 | 126,
            payload.length >> 8,
            payload.length & 0xff,
          ]);
    const body = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
    return Buffer.concat([head, mask, body]);
  };

  it("unmasks a whole frame and waits for a partial one", () => {
    const frame = masked('{"Request":{"host_id":9}}');
    const read = readClientFrame(frame);
    expect(read?.opcode).toBe(1);
    expect(read?.payload.toString()).toBe('{"Request":{"host_id":9}}');
    expect(readClientFrame(frame.subarray(0, 5))).toBeNull();
  });

  it("handles 16 bit lengths", () => {
    const text = JSON.stringify({
      Request: { host_id: 1, pad: "x".repeat(300) },
    });
    expect(readClientFrame(masked(text))?.payload.toString()).toBe(text);
  });
});

describe("grants", () => {
  it("lets a user stream only the PCs they launched, for a while", () => {
    let now = 0;
    const grants = createGrants(() => now);
    expect(grants.any("u1")).toBe(false);
    grants.allow("u1", 5);
    expect(grants.has("u1", 5)).toBe(true);
    expect(grants.has("u1", 6)).toBe(false);
    expect(grants.has("u2", 5)).toBe(false);
    now = 13 * 60 * 60 * 1000;
    expect(grants.any("u1")).toBe(false);
  });
});

describe("configScript", () => {
  const run = (pathname: string) => {
    const opened: string[] = [];
    class FakeSocket {
      constructor(url: string) {
        opened.push(url);
      }
    }
    const window: Record<string, unknown> = { WebSocket: FakeSocket };
    vm.runInNewContext(configScript(), {
      window,
      location: { pathname, origin: "http://termix.test" },
    });
    return { window, opened };
  };

  it("works out the prefix under any base path and moves the socket", () => {
    const { window, opened } = run(
      "/__termix_api/30001/plugin-api/remote-desktop/moonlight/web/stream.html",
    );
    expect((window.__CONFIG_JS__ as { path_prefix: string }).path_prefix).toBe(
      "/__termix_api/30001/plugin-api/remote-desktop/moonlight/web",
    );
    const Socket = window.WebSocket as new (url: string) => unknown;
    new Socket(
      "ws://termix.test/__termix_api/30001/plugin-api/remote-desktop/moonlight/web/api/host/stream/web_socket",
    );
    expect(opened[0]).toBe(
      "ws://termix.test/__termix_api/30001/plugin-ws/remote-desktop/moonlight/web/api/host/stream/web_socket",
    );
  });
});

describe("createHttpProxy", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise((r) => s.close(r))),
    );
  });

  const listen = async (server: http.Server) => {
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  const setup = async () => {
    const seen: Array<{
      method?: string;
      url?: string;
      cookie?: string;
      body: string;
    }> = [];
    const upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({
          method: req.method,
          url: req.url,
          cookie: req.headers.cookie,
          body,
        });
        if (req.url === "/api/host/stream/webrtc") {
          res.writeHead(201, { location: "/api/host/stream/webrtc/0" });
          res.end("answer");
          return;
        }
        res.writeHead(200, {
          "content-type": "text/html",
          "set-cookie": "mlSession=leak",
        });
        res.end("page");
      });
    });
    const upstreamUrl = await listen(upstream);
    const grants = createGrants();
    const client = {
      session: async () => ({
        config: { ...CONFIG, url: upstreamUrl },
        token: "tok",
      }),
      forget: () => undefined,
    } as unknown as MoonlightClient;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { userId?: string }).userId = "u1";
      next();
    });
    app.use(
      "/web",
      createHttpProxy({ client, grants, hostIdOf: hostIdFromJson }),
    );
    const base = await listen(http.createServer(app));
    return { base, grants, seen };
  };

  it("refuses anyone who has not launched a PC", async () => {
    const { base } = await setup();
    const res = await fetch(`${base}/web/stream.html`);
    expect(res.status).toBe(403);
  });

  it("passes the page with Termix's session and never the browser's cookies", async () => {
    const { base, grants, seen } = await setup();
    grants.allow("u1", 9);
    const res = await fetch(`${base}/web/stream.html?hostId=9`, {
      headers: { cookie: "jwt=termix-session" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("page");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen[0]).toMatchObject({
      url: "/stream.html?hostId=9",
      cookie: "mlSession=tok",
    });
  });

  it("keeps admin pages out and serves its own config", async () => {
    const { base, grants, seen } = await setup();
    grants.allow("u1", 9);
    expect((await fetch(`${base}/web/admin.html`)).status).toBe(404);
    const config = await fetch(`${base}/web/config.js`);
    expect(await config.text()).toContain("path_prefix");
    expect(seen).toHaveLength(0);
  });

  it("checks the offer names a launched PC and rewrites its location", async () => {
    const { base, grants, seen } = await setup();
    grants.allow("u1", 9);
    const other = await fetch(`${base}/web/api/host/stream/webrtc`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v=0\r\na=x-moonlight-host-id:10\r\n",
    });
    expect(other.status).toBe(403);
    const ok = await fetch(`${base}/web/api/host/stream/webrtc`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v=0\r\na=x-moonlight-host-id:9\r\n",
    });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("location")).toBe("api/host/stream/webrtc/0");
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toContain("x-moonlight-host-id:9");
  });
});
