import crypto from "crypto";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { GuacdOptions } from "./guacd-config.js";
import type { EngineMode } from "./engine/index.js";
import { builtinSessionId } from "./engine/index.js";
import { resolveJumpTunnelEndpoint } from "./jump-tunnel-endpoint.js";
import { openJumpTunnel } from "./jump-tunnel.js";
import type { RemoteDesktopLogger } from "./log.js";
import type { RemoteSessions } from "./sessions.js";
import type { GuacamoleTokenService } from "./token-service.js";

export interface ConsoleRequest {
  /** The SSH host the display is reached through. */
  hostId: number;
  /** The address as that host sees it, 127.0.0.1 by default. */
  address?: string;
  port: number;
  password?: string;
}

export interface ConsoleDeps {
  ctx: PluginContext;
  log: RemoteDesktopLogger;
  tokens: GuacamoleTokenService;
  sessions: RemoteSessions;
  guacd: () => GuacdOptions;
  engineMode: () => EngineMode;
}

/**
 * remote-desktop.console v1: a VNC display that only an SSH host can reach,
 * such as a VM console bound to the hypervisor's loopback. The caller draws
 * the token with the session.remoteDisplay slot.
 */
export function createConsoleService(deps: ConsoleDeps) {
  const { ctx, log, tokens, sessions, guacd, engineMode } = deps;
  return {
    async open(request: ConsoleRequest): Promise<{ token: string }> {
      const userId = ctx.currentActor();
      if (!userId) throw new Error("Authentication required");
      const { hostId, port } = request;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Invalid display port");
      }
      if (!(await ctx.hosts.checkAccess(hostId, "connect")).hasAccess) {
        throw new Error("Host not found");
      }
      const host = await ctx.hosts.get(hostId);
      const viaGuacd = engineMode() === "guacd";
      const endpoint = viaGuacd
        ? resolveJumpTunnelEndpoint(guacd().host)
        : { bindHost: "127.0.0.1", advertisedHost: "127.0.0.1" };
      const termixConnectId = crypto.randomUUID();
      const tunnel = await openJumpTunnel(ctx, log, {
        jumpHosts: [{ hostId }],
        targetHost: request.address || "127.0.0.1",
        targetPort: port,
        bindHost: endpoint.bindHost,
        connectId: termixConnectId,
      });
      sessions.park(termixConnectId, [tunnel.close]);
      const token = tokens.createVncToken(
        endpoint.advertisedHost,
        undefined,
        request.password ?? "",
        { port: tunnel.port },
        undefined,
        {
          termixConnectId,
          hostId,
          hostName: host?.name || host?.ip || `#${hostId}`,
          ownerUserId: userId,
          protocol: "vnc",
          tabInstanceId: null,
        },
      );
      await ctx.audit.record({
        action: "vnc_console_connect",
        resourceType: "host",
        resourceId: String(hostId),
        resourceName: `${request.address || "127.0.0.1"}:${port}`,
        success: true,
      });
      return {
        token,
        ...(viaGuacd ? {} : { sessionId: builtinSessionId(termixConnectId) }),
      };
    },
  };
}
