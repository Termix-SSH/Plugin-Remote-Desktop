import type { EngineProtocol } from "./messages.js";

/** Per protocol defaults, the same ones guacd gets through guacamole-lite. */
export const CONNECTION_DEFAULTS: Record<
  EngineProtocol,
  Record<string, unknown>
> = {
  rdp: {
    security: "any",
    "ignore-cert": true,
    "enable-wallpaper": false,
    "enable-font-smoothing": true,
    "enable-desktop-composition": false,
    "disable-audio": false,
    "enable-drive": false,
    "resize-method": "display-update",
    width: 1280,
    height: 720,
    dpi: 96,
  },
  vnc: {
    "swap-red-blue": false,
    cursor: "remote",
    width: 1280,
    height: 720,
    // macOS Screen Sharing can fail its first negotiation (Support#1063).
    autoretry: 2,
  },
  telnet: {
    "terminal-type": "xterm-256color",
    width: 1024,
    height: 768,
  },
};

const DEFAULT_PORTS: Record<EngineProtocol, number> = {
  rdp: 3389,
  vnc: 5900,
  telnet: 23,
};

/** Settings a client may set in the display URL. Everything else comes from the token. */
const QUERY_KEYS: Record<EngineProtocol, string[]> = {
  rdp: ["width", "height", "dpi"],
  vnc: ["width", "height"],
  telnet: ["width", "height"],
};

/**
 * Old mobile builds append "?" to the URL, so the last value can arrive as
 * "720?". Only the leading integer counts.
 */
export function parseQueryInt(value: string | null): number | null {
  if (value === null) return null;
  const match = /^\s*(\d+)/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  return n > 0 && n <= 16384 ? n : null;
}

/** Defaults, then the token's settings, then the size the client asked for. */
export function mergeSettings(
  protocol: EngineProtocol,
  token: Record<string, unknown>,
  query: URLSearchParams,
): Record<string, string> {
  const merged: Record<string, unknown> = {
    port: DEFAULT_PORTS[protocol],
    ...CONNECTION_DEFAULTS[protocol],
  };
  for (const [key, value] of Object.entries(token)) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  for (const key of QUERY_KEYS[protocol]) {
    const value = parseQueryInt(query.get(key));
    if (value !== null) merged[key] = value;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined || value === null) continue;
    out[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return out;
}
