import {
  isElectron,
  linkedServerUrl,
  resolveConnectionOrigin,
} from "@termix-ssh/plugin-sdk/ui";
import { apiError, guacamoleApi } from "./guacamole-api";

export interface MoonlightStatus {
  configured: boolean;
  reachable: boolean;
  code?: string;
  error?: string;
}

export interface MoonlightPc {
  id: number;
  name: string;
  address: string;
  port: number | null;
  paired: boolean;
  online: boolean;
}

export interface MoonlightPcApp {
  id: number;
  title: string;
}

export type MoonlightPairState = "waiting" | "paired" | "failed" | "expired";

type Origin = Parameters<typeof guacamoleApi>[0];

/** On the desktop, Moonlight Web is set up on the linked server when there is one. */
export async function moonlightOrigin(
  connectionOrigin?: "local" | "remote" | null,
): Promise<Origin> {
  if (!isElectron()) return "local";
  return resolveConnectionOrigin(
    { connectionOrigin },
    { defaultRemote: !!(await linkedServerUrl()) },
  );
}

async function request<T>(
  action: string,
  send: () => Promise<{ data: unknown }>,
): Promise<T> {
  try {
    return (await send()).data as T;
  } catch (error) {
    throw apiError(error, action);
  }
}

export function getMoonlightStatus(origin: Origin): Promise<MoonlightStatus> {
  return request("check Moonlight Web", () =>
    guacamoleApi(origin).get("/moonlight/status"),
  );
}

export async function listMoonlightPcs(origin: Origin): Promise<MoonlightPc[]> {
  const data = await request<{ hosts: MoonlightPc[] }>("list PCs", () =>
    guacamoleApi(origin).get("/moonlight/hosts"),
  );
  return data.hosts;
}

export async function addMoonlightPc(
  origin: Origin,
  address: string,
  port: number,
): Promise<MoonlightPc> {
  const data = await request<{ host: MoonlightPc }>("add the PC", () =>
    guacamoleApi(origin).post("/moonlight/hosts", { address, port }),
  );
  return data.host;
}

export async function listMoonlightApps(
  origin: Origin,
  pcId: number,
): Promise<MoonlightPcApp[]> {
  const data = await request<{ apps: MoonlightPcApp[] }>("list apps", () =>
    guacamoleApi(origin).get(`/moonlight/hosts/${pcId}/apps`),
  );
  return data.apps;
}

export function startMoonlightPairing(
  origin: Origin,
  pcId: number,
): Promise<{ id: string; pin: string }> {
  return request("start pairing", () =>
    guacamoleApi(origin).post(`/moonlight/hosts/${pcId}/pair`, {}),
  );
}

export async function getMoonlightPairing(
  origin: Origin,
  job: string,
): Promise<MoonlightPairState> {
  const data = await request<{ state: MoonlightPairState }>(
    "check pairing",
    () => guacamoleApi(origin).get(`/moonlight/pair/${job}`),
  );
  return data.state;
}

export function launchMoonlight(
  origin: Origin,
  hostId: number | string,
): Promise<{ url: string; proxyUrl?: string; app: string }> {
  return request("open the stream", () =>
    guacamoleApi(origin).post(`/moonlight/launch/${hostId}`, {}),
  );
}

/**
 * Where this frontend reaches the backend, in front of /plugin-api. Empty when
 * it is the page's own origin, a prefix behind the dev server, or a full
 * address in the desktop app.
 */
export function apiBase(origin: Origin): string {
  const client = guacamoleApi(origin) as { defaults?: { baseURL?: string } };
  return (client.defaults?.baseURL ?? "").replace(/\/+$/, "");
}
