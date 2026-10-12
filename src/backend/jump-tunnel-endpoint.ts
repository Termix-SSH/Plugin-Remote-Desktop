import os from "node:os";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

type Interfaces = ReturnType<typeof os.networkInterfaces>;

/** This machine's first non-loopback IPv4 address. */
export function ownAddress(
  interfaces: Interfaces = os.networkInterfaces(),
): string | null {
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return null;
}

export function resolveJumpTunnelEndpoint(
  guacdHost: string,
  tunnelHost = process.env.GUACD_TUNNEL_HOST,
  env: NodeJS.ProcessEnv = process.env,
  interfaces?: Interfaces,
): { bindHost: string; advertisedHost: string } {
  if (LOOPBACK_HOSTS.has(guacdHost.toLowerCase())) {
    return { bindHost: "127.0.0.1", advertisedHost: "127.0.0.1" };
  }

  const configured = tunnelHost?.trim();
  if (configured) return { bindHost: "0.0.0.0", advertisedHost: configured };

  // In Kubernetes "termix" is the Service, which only forwards its own port,
  // while the tunnel listens on a random one. The pod IP reaches any port.
  const podIp = env.KUBERNETES_SERVICE_HOST ? ownAddress(interfaces) : null;
  return { bindHost: "0.0.0.0", advertisedHost: podIp ?? "termix" };
}
