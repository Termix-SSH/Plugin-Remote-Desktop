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

/** Checks the enabled remote desktop ports from the server, with no session. */
export function registerOperations(ctx: PluginContext): void {
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
      if (target.jumpHosts.length > 0) {
        return {
          summary: "Behind a jump host, not checked",
          data: { rows: [], status: "unknown", label: "Not checked" },
        };
      }
      const rows = await Promise.all(
        protocols.map(async (protocol) => {
          const port = Number(settings[PORT_KEY[protocol]]);
          const open = await tcpOpen(target.ip, port);
          return { id: protocol, protocol, port, open: open ? "yes" : "no" };
        }),
      );
      const closed = rows.filter((row) => row.open === "no");
      const label = closed.length
        ? `${closed.map((row) => row.protocol.toUpperCase()).join(", ")} closed`
        : "Open";
      return {
        summary: label,
        data: { rows, status: closed.length ? "fail" : "ok", label },
      };
    },
  });
}
