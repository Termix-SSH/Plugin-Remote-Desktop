import http, { type IncomingMessage } from "node:http";
import https from "node:https";

const REQUEST_TIMEOUT_MS = 15_000;

export interface MoonlightConfig {
  url: string;
  username: string;
  password: string;
  ignoreCert: boolean;
}

export interface MoonlightHost {
  id: number;
  name: string;
  address: string;
  port: number | null;
  paired: boolean;
  online: boolean;
  shared: boolean;
}

export interface MoonlightApp {
  id: number;
  title: string;
}

export type MoonlightErrorCode =
  "not-configured" | "bad-login" | "unreachable" | "needs-admin" | "refused";

export class MoonlightError extends Error {
  constructor(
    readonly code: MoonlightErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MoonlightError";
  }
}

export interface MoonlightPairing {
  pin: string;
  /** Settles once Sunshine accepts or refuses the PIN. */
  result: Promise<boolean>;
}

export interface MoonlightClient {
  check(): Promise<void>;
  listHosts(): Promise<MoonlightHost[]>;
  addHost(address: string, port: number): Promise<MoonlightHost>;
  listApps(hostId: number): Promise<MoonlightApp[]>;
  pair(hostId: number, signal: AbortSignal): Promise<MoonlightPairing>;
}

interface RequestOptions {
  query?: Record<string, string | number>;
  json?: unknown;
  /** Zero leaves the socket waiting, for a PIN someone has yet to type. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

function apiUrl(
  config: MoonlightConfig,
  path: string,
  query: RequestOptions["query"],
): URL {
  const url = new URL(config.url);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api${path}`;
  url.search = "";
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

function open(
  config: MoonlightConfig,
  method: string,
  path: string,
  token: string | null,
  options: RequestOptions = {},
): Promise<IncomingMessage> {
  const url = apiUrl(config, path, options.query);
  const body =
    options.json === undefined ? undefined : JSON.stringify(options.json);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const failed = (error: Error) =>
      reject(
        new MoonlightError(
          "unreachable",
          `Could not reach Moonlight Web: ${error.message}`,
        ),
      );
    const send = url.protocol === "https:" ? https.request : http.request;
    const request = send(
      url,
      {
        method,
        signal: options.signal,
        rejectUnauthorized: !config.ignoreCert,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      resolve,
    );
    if (timeoutMs > 0) {
      request.setTimeout(timeoutMs, () =>
        request.destroy(new Error("timed out")),
      );
    }
    request.on("error", failed);
    request.end(body);
  });
}

async function readText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Yields each line of a streamed JSON response as it arrives. */
async function* readLines(response: IncomingMessage): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of response) {
    pending += Buffer.from(chunk).toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield line;
    }
  }
  if (pending.trim()) yield pending;
}

function sessionFrom(response: IncomingMessage): string | null {
  for (const cookie of response.headers["set-cookie"] ?? []) {
    const match = /^mlSession=([^;]+)/.exec(cookie);
    if (match) return match[1];
  }
  return null;
}

async function ensureOk(
  response: IncomingMessage,
  action: string,
): Promise<IncomingMessage> {
  const status = response.statusCode ?? 0;
  if (status >= 200 && status < 300) return response;
  response.resume();
  if (status === 403) {
    throw new MoonlightError(
      "needs-admin",
      "The saved Moonlight Web login must be an admin",
    );
  }
  throw new MoonlightError(
    "refused",
    `Moonlight Web could not ${action} (HTTP ${status})`,
  );
}

function toHost(raw: Record<string, unknown>): MoonlightHost {
  return {
    id: Number(raw.host_id),
    name: String(raw.name ?? ""),
    address: typeof raw.address === "string" ? raw.address : "",
    port: typeof raw.http_port === "number" ? raw.http_port : null,
    paired: raw.paired === "Paired",
    online: raw.server_state != null,
    shared: raw.owner === "Global",
  };
}

export function createMoonlightClient(
  readConfig: () => Promise<MoonlightConfig | null>,
): MoonlightClient {
  let session: { key: string; token: string } | null = null;

  const requireConfig = async (): Promise<MoonlightConfig> => {
    const config = await readConfig();
    if (!config) {
      throw new MoonlightError(
        "not-configured",
        "Moonlight Web is not set up in the admin settings",
      );
    }
    return config;
  };

  const login = async (config: MoonlightConfig): Promise<string> => {
    const key = `${config.url}\n${config.username}\n${config.password}`;
    if (session?.key === key) return session.token;
    const response = await open(config, "POST", "/login", null, {
      json: { name: config.username, password: config.password },
    });
    response.resume();
    const status = response.statusCode ?? 0;
    if (status === 401 || status === 404) {
      throw new MoonlightError(
        "bad-login",
        "Moonlight Web refused the saved login",
      );
    }
    const token = sessionFrom(response);
    if (status < 200 || status >= 300 || !token) {
      throw new MoonlightError(
        "refused",
        `Moonlight Web could not sign in (HTTP ${status})`,
      );
    }
    session = { key, token };
    return token;
  };

  /** Signs in again once when the saved session has expired. */
  const call = async (
    method: string,
    path: string,
    action: string,
    options?: RequestOptions,
  ): Promise<IncomingMessage> => {
    const config = await requireConfig();
    const first = await open(
      config,
      method,
      path,
      await login(config),
      options,
    );
    if (first.statusCode !== 401) return ensureOk(first, action);
    first.resume();
    session = null;
    return ensureOk(
      await open(config, method, path, await login(config), options),
      action,
    );
  };

  const hostDetails = async (host: MoonlightHost): Promise<MoonlightHost> => {
    try {
      const response = await call("GET", "/host", "read a PC", {
        query: { host_id: host.id },
      });
      const parsed = JSON.parse(await readText(response)) as {
        host: Record<string, unknown>;
      };
      return { ...toHost(parsed.host), online: host.online };
    } catch {
      return host;
    }
  };

  const listHosts = async (): Promise<MoonlightHost[]> => {
    const response = await call("GET", "/hosts", "list PCs");
    const hosts = new Map<number, MoonlightHost>();
    // The first line lists every host, each later line updates one.
    for await (const line of readLines(response)) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const rows = Array.isArray(parsed.hosts)
        ? (parsed.hosts as Record<string, unknown>[])
        : [parsed];
      for (const row of rows) {
        const host = toHost(row);
        hosts.set(host.id, host);
      }
    }
    return Promise.all([...hosts.values()].map(hostDetails));
  };

  const share = async (hostId: number): Promise<void> => {
    const response = await call("PATCH", "/host", "share a PC", {
      json: { host_id: hostId, change_owner: true, owner: null },
    });
    response.resume();
  };

  return {
    check: async () => {
      await login(await requireConfig());
    },

    listHosts,

    addHost: async (address, port) => {
      const known = (await listHosts()).find(
        (host) => host.address === address && host.port === port,
      );
      if (known) {
        if (!known.shared) await share(known.id);
        return { ...known, shared: true };
      }
      const response = await call("POST", "/host", "add the PC", {
        json: { address, http_port: port },
      });
      const parsed = JSON.parse(await readText(response)) as {
        host: Record<string, unknown>;
      };
      const added = toHost(parsed.host);
      // A private host and its pairing only work for the login that added it.
      await share(added.id);
      return { ...added, shared: true };
    },

    listApps: async (hostId) => {
      const response = await call("GET", "/apps", "list apps", {
        query: { host_id: hostId },
      });
      const parsed = JSON.parse(await readText(response)) as {
        apps?: { app_id: number; title: string }[];
      };
      return (parsed.apps ?? []).map((app) => ({
        id: app.app_id,
        title: app.title,
      }));
    },

    pair: async (hostId, signal) => {
      const response = await call("POST", "/pair", "start pairing", {
        json: { host_id: hostId },
        timeoutMs: 0,
        signal,
      });
      const lines = readLines(response);
      const first = await lines.next();
      const pin = first.done
        ? ""
        : String((JSON.parse(first.value) as { Pin?: unknown }).Pin ?? "");
      if (!pin) {
        response.destroy();
        throw new MoonlightError(
          "refused",
          "Moonlight Web did not give a pairing PIN",
        );
      }
      const result = lines
        .next()
        .then((next) => {
          if (next.done) return false;
          const outcome = JSON.parse(next.value) as unknown;
          return (
            !!outcome && typeof outcome === "object" && "Paired" in outcome
          );
        })
        .catch(() => false);
      return { pin, result };
    },
  };
}

export interface MoonlightStreamOptions {
  hostId: number;
  appId: number;
  bitrate?: number;
  fps?: number;
  transport?: string;
}

/** The page a browser opens, signed in to Moonlight Web with its own cookie. */
export function moonlightStreamUrl(
  baseUrl: string,
  options: MoonlightStreamOptions,
): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/stream.html`;
  url.search = "";
  url.searchParams.set("hostId", String(options.hostId));
  url.searchParams.set("appId", String(options.appId));
  if (options.bitrate) url.searchParams.set("bitrate", String(options.bitrate));
  if (options.fps) url.searchParams.set("fps", String(options.fps));
  if (options.transport && options.transport !== "auto") {
    url.searchParams.set("dataTransport", options.transport);
  }
  return url.toString();
}
