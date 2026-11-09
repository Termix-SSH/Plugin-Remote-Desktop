// Guacamole.Tunnel.State values.
const OPEN = 1;
const CLOSED = 2;

/** How long after a page comes back before the tunnel state is checked again. */
export const ALIVE_CHECK_MS = 8000;

/** Reconnects in a row before the error shows instead. */
export const MAX_AUTO_RECONNECTS = 3;

interface WatchedTunnel {
  state?: number;
  oninstruction?: ((opcode: string, args: string[]) => void) | null;
  onstatechange?: ((state: number) => void) | null;
}

export interface TunnelWatch {
  /** Call when the page is shown again. */
  checkAlive(): void;
  stop(): void;
}

/**
 * Guacamole.Client never hears that its tunnel closed, so a socket the server
 * dropped while the tab was hidden left a frozen screen where only the local
 * cursor moved (issue #104). This wraps the tunnel's own handlers and reports
 * a closed tunnel, also when the page was hidden while it closed.
 */
export function watchTunnel(
  tunnel: WatchedTunnel,
  onLost: (reason: "closed" | "stale") => void,
  opts: { checkMs?: number } = {},
): TunnelWatch {
  const checkMs = opts.checkMs ?? ALIVE_CHECK_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const lost = (reason: "closed" | "stale") => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    onLost(reason);
  };

  const clientInstruction = tunnel.oninstruction;
  tunnel.oninstruction = (opcode, args) => {
    clientInstruction?.call(tunnel, opcode, args);
  };
  const clientState = tunnel.onstatechange;
  tunnel.onstatechange = (state) => {
    clientState?.call(tunnel, state);
    if (state === CLOSED) lost("closed");
  };

  return {
    checkAlive() {
      if (stopped) return;
      if (typeof tunnel.state === "number" && tunnel.state !== OPEN) {
        lost("stale");
        return;
      }
      // A quiet desktop sends nothing, so silence alone is not a dead socket.
      // The tunnel's own ping closes it when the socket is really gone.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (typeof tunnel.state === "number" && tunnel.state !== OPEN)
          lost("stale");
      }, checkMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
