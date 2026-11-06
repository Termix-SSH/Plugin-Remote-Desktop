import net from "node:net";
import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import {
  ENABLE_KEY,
  PORT_KEY,
  readHostSettings,
  type RemoteProtocol,
} from "./host-settings.js";
import type { RemoteSessions } from "./sessions.js";

function requireHost(context: PluginOperationContext): number {
  if (context.hostId === undefined) throw new Error("This needs a host");
  return context.hostId;
}

export function tcpOpen(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// VNC servers like TigerVNC count a connection that closes before login as a
// failed login and blacklist the caller, so VNC ports are read over SSH.
const OVER_SSH = new Set<RemoteProtocol>(["vnc", "ard"]);

export const LISTEN_SCRIPT =
  "if command -v ss >/dev/null 2>&1; then ss -Hltn; " +
  "else netstat -an 2>/dev/null | grep -i listen; fi | awk '{print $4}'";

/** Ports from `ss`/`netstat` local addresses (0.0.0.0:5901, [::]:5901, *.5900). */
export function parseListening(output: string): Set<number> {
  const ports = new Set<number>();
  for (const line of output.split("\n")) {
    const match = /[:.](\d+)\s*$/.exec(line.trim());
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

async function listeningPorts(
  ctx: PluginContext,
  hostId: number,
): Promise<Set<number> | null> {
  try {
    const result = await ctx.ssh.exec(hostId, LISTEN_SCRIPT, {
      timeoutMs: 15_000,
      purpose: "remote-desktop-ports",
    });
    if (result.timedOut || result.code !== 0) return null;
    return parseListening(result.stdout);
  } catch {
    return null;
  }
}

/** Checks the enabled remote desktop ports with no session. */
export function registerOperations(
  ctx: PluginContext,
  sessions?: Pick<RemoteSessions, "listByOwner">,
): void {
  if (typeof ctx.operations?.register !== "function") return;

  ctx.operations.register("remote-desktop.check-ports", {
    run: async (_input, context) => {
      const hostId = requireHost(context);
      const [target] = await ctx.hosts.probeTargets({ hostIds: [hostId] });
      if (!target) throw new Error("Host not found");
      const settings = await readHostSettings(ctx, hostId);
      const protocols = (Object.keys(ENABLE_KEY) as RemoteProtocol[]).filter(
        (protocol) => settings[ENABLE_KEY[protocol]],
      );
      if (protocols.length === 0) {
        return {
          summary: "No remote desktop protocol is on",
          data: { rows: [], status: "unknown", label: "Off" },
        };
      }
      const behindJump = target.jumpHosts.length > 0;
      let listening: Promise<Set<number> | null> | undefined;
      const rows = await Promise.all(
        protocols.map(async (protocol) => {
          const port = Number(settings[PORT_KEY[protocol]]);
          let open: boolean | null;
          if (OVER_SSH.has(protocol)) {
            listening ??= listeningPorts(ctx, hostId);
            const ports = await listening;
            open = ports ? ports.has(port) : null;
          } else {
            open = behindJump ? null : await tcpOpen(target.ip, port);
          }
          return {
            id: protocol,
            protocol,
            port,
            open: open === null ? "unknown" : open ? "yes" : "no",
          };
        }),
      );
      const closed = rows.filter((row) => row.open === "no");
      if (closed.length > 0) {
        const label = `${closed.map((row) => row.protocol.toUpperCase()).join(", ")} closed`;
        return { summary: label, data: { rows, status: "fail", label } };
      }
      if (rows.every((row) => row.open === "unknown")) {
        return {
          summary: "Not checked",
          data: { rows, status: "unknown", label: "Not checked" },
        };
      }
      return { summary: "Open", data: { rows, status: "ok", label: "Open" } };
    },
  });

  ctx.operations.register("remote-desktop.sessions", {
    run: async (_input, context) => {
      const userId = ctx.currentActor();
      if (!userId) throw new Error("This needs a user");
      const hostId = requireHost(context);
      const rows = (sessions?.listByOwner(userId) ?? []).filter(
        (session) => session.hostId === hostId,
      );
      return {
        summary: `${rows.length} open sessions`,
        data: {
          rows: rows.map((session) => ({
            id: session.guacamoleConnectionId,
            name: session.hostName,
            protocol: session.protocol,
            started: new Date(session.openedAt).toISOString(),
          })),
        },
      };
    },
  });
}
