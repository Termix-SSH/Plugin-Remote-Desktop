import { getGuacamoleConnectionId } from "./guacamole-api";
import type { ConnectionOrigin } from "@termix-ssh/plugin-sdk/ui";

export function watchGuacamoleConnectionId(
  connectId: string,
  origin: ConnectionOrigin,
  onReady: (id: string) => void,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  const poll = async () => {
    try {
      const id = await getGuacamoleConnectionId(
        connectId,
        origin,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (id) onReady(id);
      else if (++attempts < 20) timer = setTimeout(poll, 500);
    } catch {
      // Session sharing discovery must not interrupt the remote display.
    }
  };
  void poll();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}

/** The session id once the server has it, or null after `attempts` tries. */
export async function waitForGuacamoleConnectionId(
  connectId: string,
  origin: ConnectionOrigin,
  attempts = 20,
  delayMs = 500,
): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const id = await getGuacamoleConnectionId(connectId, origin);
      if (id) return id;
    } catch {
      // Keep trying until the attempts run out.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}
