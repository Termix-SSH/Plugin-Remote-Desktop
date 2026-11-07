import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMoonlightClient,
  moonlightStreamUrl,
  MoonlightError,
  type MoonlightConfig,
} from "../../../src/backend/moonlight/client.js";

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) => void;

let servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  servers = [];
});

async function fakeServer(handler: Handler): Promise<MoonlightConfig> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () =>
      handler(req, res, Buffer.concat(chunks).toString("utf8")),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    username: "termix",
    password: "secret",
    ignoreCert: false,
  };
}

function signIn(res: ServerResponse, token = "tok1") {
  res.setHeader(
    "set-cookie",
    `mlSession=${token}; HttpOnly; SameSite=Strict; Path=`,
  );
  res.end();
}

const HOST_ROW = {
  host_id: 5,
  owner: "Global",
  name: "gaming",
  paired: "Paired",
  server_state: null,
};

const DETAIL = {
  ...HOST_ROW,
  address: "10.0.0.9",
  http_port: 47989,
  server_state: "Free",
};

describe("Moonlight client", () => {
  it("signs in once and sends the session as a Bearer", async () => {
    const logins: string[] = [];
    const auth: (string | undefined)[] = [];
    const config = await fakeServer((req, res, body) => {
      if (req.url === "/api/login") {
        logins.push(body);
        return signIn(res);
      }
      auth.push(req.headers.authorization);
      res.end(JSON.stringify({ apps: [{ app_id: 1, title: "Desktop" }] }));
    });
    const client = createMoonlightClient(async () => config);

    expect(await client.listApps(5)).toEqual([{ id: 1, title: "Desktop" }]);
    await client.listApps(5);

    expect(logins).toEqual([
      JSON.stringify({ name: "termix", password: "secret" }),
    ]);
    expect(auth).toEqual(["Bearer tok1", "Bearer tok1"]);
  });

  it("signs in again once when the session expired", async () => {
    let logins = 0;
    const config = await fakeServer((req, res) => {
      if (req.url === "/api/login") {
        logins += 1;
        return signIn(res, `tok${logins}`);
      }
      if (req.headers.authorization === "Bearer tok1") {
        res.statusCode = 401;
        return res.end();
      }
      res.end(JSON.stringify({ apps: [] }));
    });
    const client = createMoonlightClient(async () => config);

    await expect(client.listApps(5)).resolves.toEqual([]);
    expect(logins).toBe(2);
  });

  it("reports a bad login and a missing setup by code", async () => {
    const config = await fakeServer((_req, res) => {
      res.statusCode = 401;
      res.end();
    });
    await expect(
      createMoonlightClient(async () => config).check(),
    ).rejects.toMatchObject({ code: "bad-login" });
    await expect(
      createMoonlightClient(async () => null).check(),
    ).rejects.toMatchObject({ code: "not-configured" });
  });

  it("reports an unreachable server", async () => {
    const client = createMoonlightClient(async () => ({
      url: "http://127.0.0.1:1",
      username: "a",
      password: "b",
      ignoreCert: false,
    }));
    const error = await client.check().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MoonlightError);
    expect((error as MoonlightError).code).toBe("unreachable");
  });

  it("merges the streamed host list with details", async () => {
    const config = await fakeServer((req, res) => {
      if (req.url === "/api/login") return signIn(res);
      if (req.url === "/api/hosts") {
        res.write(`${JSON.stringify({ hosts: [HOST_ROW] })}\n`);
        res.end(`${JSON.stringify({ ...HOST_ROW, server_state: "Free" })}\n`);
        return;
      }
      res.end(JSON.stringify({ host: DETAIL }));
    });
    const client = createMoonlightClient(async () => config);

    expect(await client.listHosts()).toEqual([
      {
        id: 5,
        name: "gaming",
        address: "10.0.0.9",
        port: 47989,
        paired: true,
        online: true,
        shared: true,
      },
    ]);
  });

  it("makes a new PC global so other users share its pairing", async () => {
    const calls: string[] = [];
    const config = await fakeServer((req, res, body) => {
      if (req.url === "/api/login") return signIn(res);
      if (req.url === "/api/hosts") {
        return res.end(`${JSON.stringify({ hosts: [] })}\n`);
      }
      calls.push(`${req.method} ${req.url} ${body}`);
      if (req.method === "POST") {
        return res.end(
          JSON.stringify({ host: { ...DETAIL, owner: "ThisUser" } }),
        );
      }
      res.end();
    });
    const client = createMoonlightClient(async () => config);

    const host = await client.addHost("10.0.0.9", 47989);

    expect(host.shared).toBe(true);
    expect(calls).toEqual([
      `POST /api/host ${JSON.stringify({ address: "10.0.0.9", http_port: 47989 })}`,
      `PATCH /api/host ${JSON.stringify({ host_id: 5, change_owner: true, owner: null })}`,
    ]);
  });

  it("reuses a PC Moonlight Web already has", async () => {
    let posts = 0;
    const config = await fakeServer((req, res) => {
      if (req.url === "/api/login") return signIn(res);
      if (req.url === "/api/hosts") {
        return res.end(`${JSON.stringify({ hosts: [HOST_ROW] })}\n`);
      }
      if (req.method === "POST") posts += 1;
      res.end(JSON.stringify({ host: DETAIL }));
    });
    const client = createMoonlightClient(async () => config);

    expect((await client.addHost("10.0.0.9", 47989)).id).toBe(5);
    expect(posts).toBe(0);
  });

  it("says the saved login must be an admin when sharing is refused", async () => {
    const config = await fakeServer((req, res) => {
      if (req.url === "/api/login") return signIn(res);
      if (req.url === "/api/hosts") {
        return res.end(`${JSON.stringify({ hosts: [] })}\n`);
      }
      if (req.method === "PATCH") {
        res.statusCode = 403;
        return res.end();
      }
      res.end(JSON.stringify({ host: DETAIL }));
    });
    const client = createMoonlightClient(async () => config);

    await expect(client.addHost("10.0.0.9", 47989)).rejects.toMatchObject({
      code: "needs-admin",
    });
  });

  it("returns the PIN before pairing ends", async () => {
    let finish = () => {};
    const config = await fakeServer((req, res) => {
      if (req.url === "/api/login") return signIn(res);
      res.write(`${JSON.stringify({ Pin: "1234" })}\n`);
      finish = () => res.end(`${JSON.stringify({ Paired: DETAIL })}\n`);
    });
    const client = createMoonlightClient(async () => config);

    const pairing = await client.pair(5, new AbortController().signal);
    expect(pairing.pin).toBe("1234");

    finish();
    await expect(pairing.result).resolves.toBe(true);
  });

  it("treats a refused PIN as a failed pairing", async () => {
    const config = await fakeServer((req, res) => {
      if (req.url === "/api/login") return signIn(res);
      res.write(`${JSON.stringify({ Pin: "1234" })}\n`);
      res.end(`${JSON.stringify("PairError")}\n`);
    });
    const client = createMoonlightClient(async () => config);

    const pairing = await client.pair(5, new AbortController().signal);
    await expect(pairing.result).resolves.toBe(false);
  });

  it("settles a pairing that gets aborted", async () => {
    const config = await fakeServer((req, res) => {
      if (req.url === "/api/login") return signIn(res);
      res.write(`${JSON.stringify({ Pin: "1234" })}\n`);
    });
    const client = createMoonlightClient(async () => config);
    const abort = new AbortController();

    const pairing = await client.pair(5, abort.signal);
    abort.abort();

    await expect(pairing.result).resolves.toBe(false);
  });
});

describe("Moonlight stream address", () => {
  it("keeps a path prefix and leaves out defaults", () => {
    expect(
      moonlightStreamUrl("https://example.com/moonlight/", {
        hostId: 5,
        appId: 9,
        transport: "auto",
      }),
    ).toBe("https://example.com/moonlight/stream.html?hostId=5&appId=9");
  });

  it("adds the stream options", () => {
    const url = new URL(
      moonlightStreamUrl("http://10.0.0.1:8080", {
        hostId: 5,
        appId: 9,
        bitrate: 20000,
        fps: 120,
        transport: "websocket",
      }),
    );
    expect(url.searchParams.get("bitrate")).toBe("20000");
    expect(url.searchParams.get("fps")).toBe("120");
    expect(url.searchParams.get("dataTransport")).toBe("websocket");
  });
});
