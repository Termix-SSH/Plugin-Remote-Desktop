import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import type { Request, Response } from "express";
import type { MoonlightClient, MoonlightConfig } from "./client.js";

/**
 * Serves Moonlight Web's stream page through Termix, so the page is on
 * Termix's own address and a tab can frame it. Moonlight Web's sign in cookie
 * is SameSite=Strict, so a frame of the real server only works when both
 * share a parent domain. Here Termix signs in with the saved admin login and
 * the browser never sees that session.
 *
 * Only the stream page, its files and the calls it makes are passed on, and
 * only for someone who just launched a PC from Termix (a grant). Moonlight
 * Web's own admin and user pages stay out of reach.
 */

export const PROXY_HTTP_PATH = "/moonlight/web";
const PLUGIN_ID = "remote-desktop";
const HTTP_PREFIX = `/plugin-api/${PLUGIN_ID}${PROXY_HTTP_PATH}`;
const WS_PREFIX = `/plugin-ws/${PLUGIN_ID}${PROXY_HTTP_PATH}`;
const STREAM_SOCKET = "/api/host/stream/web_socket";
export const PROXY_WS_PATH = `${PROXY_HTTP_PATH}${STREAM_SOCKET}`;

/** How long a launch lets someone stream that PC through the proxy. */
const GRANT_MS = 12 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 30_000;
/** A stream request is a few hundred bytes; anything bigger is refused. */
const MAX_FIRST_FRAME = 64 * 1024;

const FILE =
  /^\/(?!admin|index)[\w.-]+\.(?:html|js|mjs|wasm|css|svg|png|ico|json|woff2?|ttf|map)$/;
const RESOURCE = /^\/resources\/[\w./-]+$/;
const API: Array<[RegExp, string[]]> = [
  [/^\/api\/authenticate$/, ["GET"]],
  [/^\/api\/role$/, ["GET"]],
  [/^\/api\/host\/stream\/webrtc$/, ["OPTIONS", "POST"]],
  [/^\/api\/host\/stream\/webrtc\/[\w-]+$/, ["PATCH", "DELETE"]],
];

/** Who may stream which Moonlight PC, from their launches. */
export function createGrants(now: () => number = Date.now) {
  const grants = new Map<string, Map<number, number>>();
  const live = (userId: string): Map<number, number> | undefined => {
    const hosts = grants.get(userId);
    if (!hosts) return undefined;
    for (const [hostId, until] of hosts) {
      if (until <= now()) hosts.delete(hostId);
    }
    if (hosts.size === 0) {
      grants.delete(userId);
      return undefined;
    }
    return hosts;
  };
  return {
    allow(userId: string, moonlightHostId: number) {
      const hosts = grants.get(userId) ?? new Map<number, number>();
      hosts.set(moonlightHostId, now() + GRANT_MS);
      grants.set(userId, hosts);
    },
    any(userId: string): boolean {
      return !!live(userId);
    },
    has(userId: string, moonlightHostId: number): boolean {
      return !!live(userId)?.has(moonlightHostId);
    },
  };
}
export type Grants = ReturnType<typeof createGrants>;

/** Whether the proxy passes this method and path on. */
export function allowedRequest(method: string, path: string): boolean {
  if (method === "GET" || method === "HEAD") {
    if (FILE.test(path) || RESOURCE.test(path)) return !path.includes("..");
  }
  return API.some(
    ([pattern, methods]) => pattern.test(path) && methods.includes(method),
  );
}

/**
 * Moonlight Web's config.js, pointed at the proxy. The page works out the
 * prefix from its own path, since Termix can sit behind a base path (the dev
 * server, a reverse proxy). It also moves the one WebSocket the page opens
 * from the HTTP path to Termix's plugin socket path under /plugin-ws.
 */
export function configScript(): string {
  const http = JSON.stringify(HTTP_PREFIX);
  const ws = JSON.stringify(WS_PREFIX);
  return `(function () {
  var path = location.pathname;
  var at = path.lastIndexOf(${http});
  var prefix = at < 0 ? ${http} : path.slice(0, at + ${http}.length);
  window.__CONFIG_JS__ = { path_prefix: prefix };
  // Moonlight Web asks for H.264 only by default, which some browsers can't
  // decode. Auto offers the host every codec this browser can play.
  try {
    var saved = JSON.parse(localStorage.getItem("mlSettings") || "null");
    if (!saved || typeof saved !== "object") saved = {};
    if (!saved.videoCodec) {
      saved.videoCodec = "auto";
      localStorage.setItem("mlSettings", JSON.stringify(saved));
    }
  } catch (e) {}
  var socketPrefix = prefix.slice(0, prefix.length - ${http}.length) + ${ws};
  var Native = window.WebSocket;
  var origin = location.origin.replace(/^http/, "ws");
  var from = origin + prefix + "/";
  var to = origin + socketPrefix + "/";
  function Moved(url, protocols) {
    var target = typeof url === "string" && url.indexOf(from) === 0 ? to + url.slice(from.length) : url;
    return protocols === undefined ? new Native(target) : new Native(target, protocols);
  }
  Moved.prototype = Native.prototype;
  Moved.CONNECTING = 0;
  Moved.OPEN = 1;
  Moved.CLOSING = 2;
  Moved.CLOSED = 3;
  window.WebSocket = Moved;
})();
`;
}

function upstreamUrl(
  config: MoonlightConfig,
  path: string,
  search: string,
): URL {
  const url = new URL(config.url);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = search;
  return url;
}

/**
 * Maps a Location from Moonlight Web onto the proxy, as a path relative to the
 * stream page so it resolves under whatever base path Termix is served on.
 */
export function proxyLocation(
  location: string,
  config: MoonlightConfig,
): string {
  const base = new URL(config.url);
  const basePath = base.pathname.replace(/\/+$/, "");
  let path: string;
  try {
    const url = new URL(location, base);
    if (url.origin !== base.origin) return location;
    path = url.pathname + url.search;
  } catch {
    return location;
  }
  if (basePath && path.startsWith(basePath)) {
    path = path.slice(basePath.length);
  }
  return path.replace(/^\/+/, "");
}

const PASS_REQUEST = [
  "accept",
  "content-type",
  "if-none-match",
  "if-modified-since",
];
const PASS_RESPONSE = [
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "pragma",
  "link",
];

function send(
  config: MoonlightConfig,
  method: string,
  url: URL,
  headers: OutgoingHttpHeaders,
): http.ClientRequest {
  const request = (url.protocol === "https:" ? https.request : http.request)(
    url,
    {
      method,
      headers,
      rejectUnauthorized: !config.ignoreCert,
    },
  );
  request.setTimeout(UPSTREAM_TIMEOUT_MS, () =>
    request.destroy(new Error("timed out")),
  );
  return request;
}

function bodyOf(req: Request): Buffer | null {
  // Core parses JSON and form bodies before the plugin sees them.
  const parsed = (req as Request & { _body?: boolean })._body;
  if (!parsed) return null;
  return Buffer.from(JSON.stringify(req.body ?? {}));
}

/** Most offers are a few kilobytes. */
const MAX_OFFER_BYTES = 256 * 1024;

function readBody(req: Request, limit: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

/** The Moonlight PC a WebRTC offer names, from its x-moonlight-host-id line. */
export function sdpHostId(sdp: string): number | null {
  const match = /^a=x-moonlight-host-id:(\d+)\s*$/m.exec(sdp);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

export interface ProxyDeps {
  client: MoonlightClient;
  grants: Grants;
  /** Checks a WebRTC offer or socket request names a PC the user may stream. */
  hostIdOf?: (text: string) => number | null;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

/** The HTTP side: stream page, its files and its API calls. */
export function createHttpProxy(deps: ProxyDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const userId = (req as Request & { userId?: string }).userId;
    if (!userId || !deps.grants.any(userId)) {
      res.status(403).json({ error: "Open this PC from Termix first" });
      return;
    }
    const path = req.path || "/";
    if (path === "/config.js") {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.send(configScript());
      return;
    }
    if (!allowedRequest(req.method, path)) {
      res.status(404).json({ error: "Not available through Termix" });
      return;
    }

    const parsed = bodyOf(req);
    // A WebRTC offer is SDP text; read it to check which PC it names.
    let offer: Buffer | null = null;
    if (
      req.method === "POST" &&
      path === "/api/host/stream/webrtc" &&
      !parsed
    ) {
      offer = await readBody(req, MAX_OFFER_BYTES);
      const hostId = offer ? sdpHostId(offer.toString("utf8")) : null;
      if (hostId === null || !deps.grants.has(userId, hostId)) {
        deps.log?.("Moonlight stream offer named a PC that was not launched", {
          hostId,
        });
        res.status(403).json({ error: "Open this PC from Termix first" });
        return;
      }
    }
    const body = parsed ?? offer;
    const run = async (retry: boolean): Promise<void> => {
      let session: { config: MoonlightConfig; token: string };
      try {
        session = await deps.client.session();
      } catch (error) {
        res.status(502).json({
          error:
            error instanceof Error
              ? error.message
              : "Moonlight Web is not reachable",
        });
        return;
      }
      const { config, token } = session;
      const search = req.originalUrl.includes("?")
        ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
        : "";
      const headers: OutgoingHttpHeaders = { cookie: `mlSession=${token}` };
      for (const name of PASS_REQUEST) {
        const value = req.headers[name];
        if (value) headers[name] = value;
      }
      if (parsed) {
        headers["content-type"] = "application/json";
        headers["content-length"] = parsed.length;
      } else if (offer) {
        headers["content-length"] = offer.length;
      } else if (req.headers["content-length"]) {
        headers["content-length"] = req.headers["content-length"];
      } else if (req.headers["transfer-encoding"]) {
        headers["transfer-encoding"] = req.headers["transfer-encoding"];
      }

      const upstream = send(
        config,
        req.method,
        upstreamUrl(config, path, search),
        headers,
      );
      upstream.on("error", (error) => {
        if (!res.headersSent) {
          res
            .status(502)
            .json({ error: `Could not reach Moonlight Web: ${error.message}` });
        } else {
          res.destroy(error);
        }
      });
      upstream.on("response", (answer: IncomingMessage) => {
        const status = answer.statusCode ?? 502;
        // A stale session: sign in again once, for requests with no body.
        if (status === 401 && retry && !body && req.method === "GET") {
          answer.resume();
          deps.client.forget();
          void run(false);
          return;
        }
        res.status(status);
        for (const name of PASS_RESPONSE) {
          const value = answer.headers[name];
          if (value !== undefined) res.setHeader(name, value);
        }
        const location = answer.headers.location;
        if (location)
          res.setHeader("location", proxyLocation(location, config));
        answer.pipe(res);
      });

      if (body) upstream.end(body);
      else if (
        req.method === "GET" ||
        req.method === "HEAD" ||
        req.method === "DELETE"
      )
        upstream.end();
      else req.pipe(upstream);
    };
    await run(true);
  };
}

/** Reads one complete masked client frame from the start of a buffer. */
export function readClientFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; size: number } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(MAX_FIRST_FRAME))
      return { opcode, payload: Buffer.alloc(0), size: -1 };
    length = Number(big);
    offset = 10;
  }
  if (!masked) return { opcode, payload: Buffer.alloc(0), size: -1 };
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.alloc(length);
  for (let i = 0; i < length; i++)
    payload[i] = buffer[offset + 4 + i] ^ mask[i % 4];
  return { opcode, payload, size: offset + 4 + length };
}

function refuse(socket: Duplex, status: string): void {
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

/** The WebSocket side: the stream page's fallback transport. */
export function createSocketProxy(deps: ProxyDeps) {
  return (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    userId: string,
  ): void => {
    if (!userId || !deps.grants.any(userId)) {
      refuse(socket, "403 Forbidden");
      return;
    }
    void deps.client
      .session()
      .then(({ config, token }) => {
        const url = upstreamUrl(config, STREAM_SOCKET, "");
        const headers: OutgoingHttpHeaders = {
          connection: "Upgrade",
          upgrade: "websocket",
          cookie: `mlSession=${token}`,
        };
        // No extensions, so frames stay uncompressed and the first one can be read.
        for (const name of [
          "sec-websocket-key",
          "sec-websocket-version",
          "sec-websocket-protocol",
        ]) {
          const value = request.headers[name];
          if (value) headers[name] = value;
        }
        const upstream = send(config, "GET", url, headers);
        upstream.on("error", () => refuse(socket, "502 Bad Gateway"));
        upstream.on("response", (answer) => {
          answer.resume();
          refuse(socket, `${answer.statusCode ?? 502} Refused`);
        });
        upstream.on("upgrade", (answer, remote, remoteHead) => {
          const lines = ["HTTP/1.1 101 Switching Protocols"];
          for (let i = 0; i < answer.rawHeaders.length; i += 2) {
            lines.push(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}`);
          }
          socket.write(`${lines.join("\r\n")}\r\n\r\n`);
          if (remoteHead.length) socket.write(remoteHead);
          const close = () => {
            remote.destroy();
            socket.destroy();
          };
          remote.on("error", close);
          socket.on("error", close);
          remote.on("close", close);
          socket.on("close", close);
          remote.pipe(socket);

          // The first message names the PC; only pass it when it is one the
          // user launched, then hand the socket over untouched.
          let pending = head.length ? Buffer.from(head) : Buffer.alloc(0);
          const onData = (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            if (pending.length > MAX_FIRST_FRAME + 16) return close();
            const frame = readClientFrame(pending);
            if (!frame) return;
            if (frame.size < 0) return close();
            const hostId =
              frame.opcode === 1 && deps.hostIdOf
                ? deps.hostIdOf(frame.payload.toString("utf8"))
                : null;
            if (hostId === null || !deps.grants.has(userId, hostId)) {
              deps.log?.(
                "Moonlight stream socket named a PC that was not launched",
                { hostId },
              );
              return close();
            }
            socket.off("data", onData);
            remote.write(pending);
            socket.pipe(remote);
          };
          socket.on("data", onData);
          if (pending.length) onData(Buffer.alloc(0));
        });
        upstream.end();
      })
      .catch(() => refuse(socket, "502 Bad Gateway"));
  };
}

/**
 * The Moonlight PC a stream request names, from its JSON. The socket's first
 * message is {"Request":{"host_id":..}}, so the id is looked for one level in.
 */
export function hostIdFromJson(text: string): number | null {
  const idOf = (value: unknown): number | null => {
    if (!value || typeof value !== "object") return null;
    const record = value as { hostId?: unknown; host_id?: unknown };
    const id = record.hostId ?? record.host_id;
    return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
  };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const direct = idOf(parsed);
    if (direct !== null) return direct;
    for (const inner of Object.values(parsed)) {
      const id = idOf(inner);
      if (id !== null) return id;
    }
    return null;
  } catch {
    return null;
  }
}
