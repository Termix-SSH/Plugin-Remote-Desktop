import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { GuacamoleToken, GuacamoleTokenService } from "./token-service.js";
import type { EngineMode } from "./engine/index.js";

type Upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Whether a display token goes to the built-in engine. A join goes wherever
 * its session lives; a host with its own guacd address keeps using guacd.
 */
export function usesBuiltinEngine(
  token: GuacamoleToken,
  mode: EngineMode,
  isBuiltinSession: (id: string) => boolean,
): boolean {
  const join = token.connection.join;
  if (join) return isBuiltinSession(join);
  return (
    mode === "builtin" &&
    !token.connection.guacdHost &&
    !token.connection.guacdPort
  );
}

/**
 * The /display upgrade. The route is public, so the token is the only
 * credential: anything forged, edited, expired or already used is refused
 * before either engine sees it.
 */
export function createDisplayGateway(deps: {
  tokens: GuacamoleTokenService;
  mode: () => EngineMode;
  builtin: {
    has: (id: string) => boolean;
    handleUpgrade: (
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      token: GuacamoleToken,
    ) => void;
  };
  guacd: { handleUpgrade: Upgrade };
}): Upgrade {
  return (request, socket, head) => {
    const raw = new URL(
      request.url ?? "/",
      "http://localhost",
    ).searchParams.get("token");
    const token = raw ? deps.tokens.consumeToken(raw) : null;
    if (!token) {
      try {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      } catch {
        // The peer may already be gone.
      }
      socket.destroy();
      return;
    }
    if (usesBuiltinEngine(token, deps.mode(), (id) => deps.builtin.has(id))) {
      deps.builtin.handleUpgrade(request, socket, head, token);
    } else {
      deps.guacd.handleUpgrade(request, socket, head);
    }
  };
}
