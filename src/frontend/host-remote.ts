import type {
  HostProtocolAuthSummary,
  PluginHostRecord,
  QuickConnectLogin,
} from "@termix-ssh/plugin-sdk/frontend";
import type { GuacamoleConfig } from "./guacamole-config";

export const PLUGIN_ID = "remote-desktop";

export type Protocol = "rdp" | "vnc" | "ard" | "telnet" | "rustdesk";

/** Moonlight opens a Moonlight Web page, so it has no Guacamole session. */
export type HostProtocol = Protocol | "moonlight";

/** This plugin's host settings, as they arrive on host.pluginSettings. */
export interface RemoteHostOptions {
  enableRdp: boolean;
  enableVnc: boolean;
  enableArd: boolean;
  enableTelnet: boolean;
  enableRustdesk: boolean;
  enableMoonlight: boolean;
  rdpPort: number;
  vncPort: number;
  ardPort: number;
  telnetPort: number;
  rustdeskPort: number;
  rustdeskId: string;
  rustdeskDirect: boolean;
  rustdeskIdServer: string;
  rustdeskRelayServer: string;
  rustdeskKey: string;
  moonlightPort: number;
  moonlightHostId: number;
  moonlightAppId: number;
  moonlightBitrate: number;
  moonlightFps: number;
  moonlightTransport: string;
  rdpSecurity: string;
  rdpIgnoreCert: boolean;
  guacamoleConfig: GuacamoleConfig;
  enableToolbar: boolean;
}

export const ENABLE_KEY = {
  rdp: "enableRdp",
  vnc: "enableVnc",
  ard: "enableArd",
  telnet: "enableTelnet",
  rustdesk: "enableRustdesk",
  moonlight: "enableMoonlight",
} as const satisfies Record<HostProtocol, keyof RemoteHostOptions>;

export const PORT_KEY = {
  rdp: "rdpPort",
  vnc: "vncPort",
  ard: "ardPort",
  telnet: "telnetPort",
  rustdesk: "rustdeskPort",
  moonlight: "moonlightPort",
} as const satisfies Record<HostProtocol, keyof RemoteHostOptions>;

export const DEFAULT_PORT: Record<HostProtocol, number> = {
  rdp: 3389,
  vnc: 5900,
  ard: 5900,
  telnet: 23,
  rustdesk: 21118,
  moonlight: 47989,
};

/**
 * The host fields a session reads. Each protocol's login is core's, under
 * protocolAuth, since this plugin declares its protocols in the manifest.
 */
export interface RemoteHostLogin {
  id?: number | string;
  name?: string | null;
  ip?: string;
  syncId?: string | null;
  connectionOrigin?: "local" | "remote" | null;
  protocolAuth?: Record<string, HostProtocolAuthSummary>;
  quickConnectLogin?: QuickConnectLogin;
  authOverrides?: Record<
    string,
    {
      credentialId?: number | string | null;
      required?: boolean;
      ownerAuthShared?: boolean;
    }
  >;
  pluginSettings?: Record<string, Record<string, unknown>>;
}

/** The RDP domain a host's saved login carries. */
export function rdpDomain(host: RemoteHostLogin): string | undefined {
  return host.protocolAuth?.rdp?.fields?.domain || undefined;
}

function port(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0
    ? parsed
    : fallback;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseGuacamoleConfig(value: unknown): GuacamoleConfig {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? (value as GuacamoleConfig) : {};
}

export function remoteOptions(
  settings: Record<string, unknown> | undefined,
): RemoteHostOptions {
  const values = settings ?? {};
  return {
    enableRdp: values.enableRdp === true,
    enableVnc: values.enableVnc === true,
    enableArd: values.enableArd === true,
    enableTelnet: values.enableTelnet === true,
    enableRustdesk: values.enableRustdesk === true,
    enableMoonlight: values.enableMoonlight === true,
    rdpPort: port(values.rdpPort, DEFAULT_PORT.rdp),
    vncPort: port(values.vncPort, DEFAULT_PORT.vnc),
    ardPort: port(values.ardPort, DEFAULT_PORT.ard),
    telnetPort: port(values.telnetPort, DEFAULT_PORT.telnet),
    rustdeskPort: port(values.rustdeskPort, DEFAULT_PORT.rustdesk),
    rustdeskId: text(values.rustdeskId),
    rustdeskDirect: values.rustdeskDirect === true,
    rustdeskIdServer: text(values.rustdeskIdServer),
    rustdeskRelayServer: text(values.rustdeskRelayServer),
    rustdeskKey: text(values.rustdeskKey),
    moonlightPort: port(values.moonlightPort, DEFAULT_PORT.moonlight),
    moonlightHostId: count(values.moonlightHostId),
    moonlightAppId: count(values.moonlightAppId),
    moonlightBitrate: count(values.moonlightBitrate),
    moonlightFps: count(values.moonlightFps),
    moonlightTransport: text(values.moonlightTransport) || "auto",
    rdpSecurity:
      typeof values.rdpSecurity === "string" ? values.rdpSecurity : "",
    rdpIgnoreCert: values.rdpIgnoreCert === true,
    guacamoleConfig: parseGuacamoleConfig(values.guacamoleConfig),
    enableToolbar: values.enableToolbar !== false,
  };
}

export function hostRemoteOptions(
  host:
    | Pick<RemoteHostLogin, "pluginSettings">
    | PluginHostRecord
    | null
    | undefined,
): RemoteHostOptions {
  const bag = (host as RemoteHostLogin | null | undefined)?.pluginSettings;
  return remoteOptions(bag?.[PLUGIN_ID]);
}

export function protocolEnabled(
  host:
    | Pick<RemoteHostLogin, "pluginSettings">
    | PluginHostRecord
    | null
    | undefined,
  protocol: HostProtocol,
): boolean {
  return hostRemoteOptions(host)[ENABLE_KEY[protocol]];
}

/** Quick Connect hosts are never saved; their ids carry this prefix. */
const QUICK_CONNECT_ID_PREFIX = "quick-connect-";

export function isQuickConnectHost(host: { id?: unknown } | null | undefined) {
  return String(host?.id ?? "").startsWith(QUICK_CONNECT_ID_PREFIX);
}

export function errorMessage(error: unknown, fallback = "Unknown error") {
  const data = (error as { response?: { data?: { error?: unknown } } })
    ?.response?.data?.error;
  if (typeof data === "string" && data) return data;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}
