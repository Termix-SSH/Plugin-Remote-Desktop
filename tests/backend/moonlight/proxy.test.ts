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
    const ticket = grants.allow("u1", 5);
    expect(grants.has("u1", 5)).toBe(true);
    expect(grants.has("u1", 6)).toBe(false);
    expect(grants.has("u2", 5)).toBe(false);
    expect(grants.userOf(ticket)).toBe("u1");
    now = 13 * 60 * 60 * 1000;
    expect(grants.userOf(ticket)).toBeNull();
    expect(grants.has("u1", 5)).toBe(false);
  });

  it("gives each person one unguessable ticket while they have a grant", () => {
    const grants = createGrants();
    const ticket = grants.allow("u1", 5);
    expect(ticket).toMatch(/^[\w-]{32}$/);
    expect(grants.allow("u1", 6)).toBe(ticket);
    expect(grants.allow("u2", 5)).not.toBe(ticket);
    expect(grants.userOf("")).toBeNull();
    expect(grants.userOf("guess")).toBeNull();
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
    const window: Record<string, unknown> = {
      WebSocket: FakeSocket,
      location: { pathname, origin: "http://termix.test" },
    };
    window.window = window;
    vm.runInNewContext(configScript("T1"), window);
    return { window, opened };
  };

  it("works out the prefix under any base path and moves the socket", () => {
    const { window, opened } = run(
      "/__termix_api/30001/plugin-api/remote-desktop/moonlight/web/T1/stream.html",
    );
    expect((window.__CONFIG_JS__ as { path_prefix: string }).path_prefix).toBe(
      "/__termix_api/30001/plugin-api/remote-desktop/moonlight/web/T1",
    );
    const Socket = window.WebSocket as new (url: string) => unknown;
    new Socket(
      "ws://termix.test/__termix_api/30001/plugin-api/remote-desktop/moonlight/web/T1/api/host/stream/web_socket",
    );
    expect(opened[0]).toBe(
      "ws://termix.test/__termix_api/30001/plugin-ws/remote-desktop/moonlight/web/api/host/stream/web_socket?ticket=T1",
    );
  });

  it("gives a sandboxed page storage and drops cookies from its calls", async () => {
    const calls: unknown[] = [];
    const window: Record<string, unknown> = {
      WebSocket: class {},
      location: { pathname: "/x", origin: "http://termix.test" },
      fetch: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve("ok");
      },
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError");
      },
    });
    window.window = window;
    vm.runInNewContext(configScript("T1"), window);

    const storage = window.localStorage as Storage;
    expect(JSON.parse(storage.getItem("mlSettings") as string)).toEqual({
      videoCodec: "auto",
    });
    storage.setItem("a", "1");
    expect(storage.getItem("a")).toBe("1");
    storage.removeItem("a");
    expect(storage.getItem("a")).toBeNull();

    const fetch = window.fetch as (url: string, init?: object) => unknown;
    await fetch("/api/role", { method: "GET", credentials: "include" });
    await fetch("/api/role");
    expect(calls).toEqual([
      ["/api/role", { method: "GET", credentials: "same-origin" }],
      ["/api/role", undefined],
    ]);
  });
});

describe("configScript in a sandboxed frame", () => {
  it("starts the page's workers from a script of its own and keeps gamepads optional", () => {
    const started: Array<[string, unknown]> = [];
    class FakeWorker {
      constructor(url: string, options?: unknown) {
        started.push([url, options]);
      }
    }
    const blobs: string[] = [];
    class FakeBlob {
      constructor(parts: string[]) {
        blobs.push(parts.join(""));
      }
    }
    const FakeURL = Object.assign(
      function (this: URL, input: string, base?: string) {
        return new URL(input, base);
      } as unknown as typeof URL,
      { createObjectURL: () => "blob:termix/1" },
    );
    const window: Record<string, unknown> = {
      WebSocket: class {},
      Worker: FakeWorker,
      Blob: FakeBlob,
      URL: FakeURL,
      location: {
        pathname: "/plugin-api/remote-desktop/moonlight/web/T1/stream.html",
        origin: "http://termix.test",
        href: "http://termix.test/plugin-api/remote-desktop/moonlight/web/T1/stream.html",
      },
      navigator: {
        getGamepads: () => {
          throw new Error("disallowed by permissions policy");
        },
      },
    };
    window.window = window;
    vm.runInNewContext(configScript("T1"), window);

    const Worker = window.Worker as new (url: unknown, o?: unknown) => unknown;
    new Worker(
      "http://termix.test/plugin-api/remote-desktop/moonlight/web/T1/478.js",
      { type: undefined },
    );
    new Worker("https://elsewhere.test/w.js");
    expect(started).toEqual([
      ["blob:termix/1", { type: undefined }],
      ["https://elsewhere.test/w.js", undefined],
    ]);
    expect(blobs).toEqual([
      'importScripts("http://termix.test/plugin-api/remote-desktop/moonlight/web/T1/478.js");',
    ]);
    const nav = window.navigator as { getGamepads: () => unknown };
    expect(nav.getGamepads()).toEqual([]);
  });
});

describe("configScript codec", () => {
  const PAGE = "/plugin-api/remote-desktop/moonlight/web/T1/stream.html";
  const page = (store: Map<string, string>) => {
    const window: Record<string, unknown> = {
      WebSocket: class {},
      location: { pathname: PAGE, origin: "http://termix.test" },
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
      },
    };
    window.window = window;
    return window;
  };
  const run = (saved: string | null) => {
    const store = new Map<string, string>();
    if (saved !== null) store.set("mlSettings", saved);
    vm.runInNewContext(configScript("T1"), page(store));
    return JSON.parse(store.get("mlSettings") ?? "null") as Record<
      string,
      unknown
    >;
  };

  it("starts on auto so the browser offers what it can play", () => {
    expect(run(null)).toEqual({ videoCodec: "auto" });
    expect(run('{"language":"en"}')).toEqual({
      language: "en",
      videoCodec: "auto",
    });
  });

  it("keeps a codec someone picked", () => {
    expect(run('{"videoCodec":"h264"}')).toEqual({ videoCodec: "h264" });
  });

  it("leaves broken saved settings to the page", () => {
    const store = new Map([["mlSettings", "{oops"]]);
    expect(() =>
      vm.runInNewContext(configScript("T1"), page(store)),
    ).not.toThrow();
    expect(store.get("mlSettings")).toBe("{oops");
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

  const setup = async (mayStream?: (userId: string) => Promise<boolean>) => {
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
    app.use(
      "/web",
      createHttpProxy({ client, grants, mayStream, hostIdOf: hostIdFromJson }),
    );
    const base = await listen(http.createServer(app));
    return { base, grants, seen };
  };

  it("refuses anyone who has not launched a PC", async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/web/stream.html`)).status).toBe(403);
    expect((await fetch(`${base}/web/guess/stream.html`)).status).toBe(403);
  });

  it("stops a ticket once its owner may no longer open sessions", async () => {
    let allowed = true;
    const { base, grants } = await setup(async () => allowed);
    const ticket = grants.allow("u1", 9);
    expect((await fetch(`${base}/web/${ticket}/stream.html`)).status).toBe(200);
    allowed = false;
    expect((await fetch(`${base}/web/${ticket}/stream.html`)).status).toBe(403);
  });

  it("passes the page with Termix's session and never the browser's cookies", async () => {
    const { base, grants, seen } = await setup();
    const ticket = grants.allow("u1", 9);
    const res = await fetch(`${base}/web/${ticket}/stream.html?hostId=9`, {
      headers: { cookie: "jwt=termix-session" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("page");
    expect(res.headers.get("set-cookie")).toBeNull();
    // Framed inside the sandboxed plugin frame, read over CORS.
    expect(res.headers.get("content-security-policy")).not.toContain(
      "frame-ancestors",
    );
    expect(res.headers.get("access-control-expose-headers")).toBe(
      "Location, Link",
    );
    expect(seen[0]).toMatchObject({
      url: "/stream.html?hostId=9",
      cookie: "mlSession=tok",
    });
  });

  it("keeps admin pages out and serves its own config", async () => {
    const { base, grants, seen } = await setup();
    const ticket = grants.allow("u1", 9);
    expect((await fetch(`${base}/web/${ticket}/admin.html`)).status).toBe(404);
    const config = await fetch(`${base}/web/${ticket}/config.js`);
    expect(await config.text()).toContain(JSON.stringify(ticket));
    expect(seen).toHaveLength(0);
  });

  it("checks the offer names a launched PC and rewrites its location", async () => {
    const { base, grants, seen } = await setup();
    const ticket = grants.allow("u1", 9);
    const other = await fetch(`${base}/web/${ticket}/api/host/stream/webrtc`, {
      method: "POST",
      headers: { "content-type": "application/sdp" },
      body: "v=0\r\na=x-moonlight-host-id:10\r\n",
    });
    expect(other.status).toBe(403);
    const ok = await fetch(`${base}/web/${ticket}/api/host/stream/webrtc`, {
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
