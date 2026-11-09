import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { GuacamoleTokenService } from "./token-service.js";
import type { RemoteSession, RemoteSessions } from "./sessions.js";
import type { RemoteProtocol } from "./host-settings.js";

/** sessions.live v1, as the session-sharing plugin reads it. */
interface LiveSessionInfo {
  id: string;
  userId: string;
  hostId: number;
  hostName: string;
  isConnected: boolean;
  createdAt: number;
  tabInstanceId: string | null;
  protocol: string;
  recording: boolean;
}

export interface RemoteLiveSessions {
  getSession: (sessionId: string) => LiveSessionInfo | null;
  /** Every live session of this protocol. Needs remote-desktop.monitor. */
  listAll: () => Promise<LiveSessionInfo[]>;
  /** One user's live sessions of this protocol. A plugin only gets its actor's. */
  listForUser: (userId: string) => LiveSessionInfo[];
  /** The owner, or a caller with remote-desktop.monitor. */
  ownerEndSession: (sessionId: string, reason: string) => Promise<void>;
  /**
   * A join token. The owner may pick, a monitor always gets a read only
   * one. Anyone else is refused.
   */
  createViewerToken: (
    sessionId: string,
    readOnly: boolean,
    shareId?: string,
  ) => Promise<string>;
  disconnectParticipants: (
    sessionId: string,
    shareId: string,
    options?: { reason?: string; userId?: string | null },
  ) => number;
}

/**
 * One provider per protocol. A session id is guacd's own connection id,
 * which is what a viewer's join token names.
 */
export function createLiveSessions(
  protocol: RemoteProtocol,
  deps: {
    ctx: Pick<PluginContext, "currentActor" | "rbac">;
    sessions: RemoteSessions;
    isRecording?: (guacamoleConnectionId: string) => boolean;
    tokens: GuacamoleTokenService;
    endSession: (guacamoleConnectionId: string) => boolean;
    disconnectShare: (guacamoleConnectionId: string, shareId: string) => number;
  },
): RemoteLiveSessions {
  const find = (sessionId: string) => {
    const session = deps.sessions.byGuacamole(sessionId);
    return session && session.protocol === protocol ? session : null;
  };

  const info = (session: RemoteSession): LiveSessionInfo => ({
    id: session.guacamoleConnectionId,
    userId: session.ownerUserId,
    hostId: session.hostId,
    hostName: session.hostName,
    isConnected: true,
    createdAt: session.openedAt,
    tabInstanceId: session.tabInstanceId,
    protocol: session.protocol,
    recording: deps.isRecording?.(session.guacamoleConnectionId) ?? false,
  });
  // Core and the owner reach a session freely; anyone else needs monitor.
  const access = async (
    session: RemoteSession,
  ): Promise<"owner" | "monitor" | null> => {
    const actor = deps.ctx.currentActor();
    if (!actor || actor === session.ownerUserId) return "owner";
    return (await deps.ctx.rbac.has("monitor")) ? "monitor" : null;
  };

  return {
    getSession(sessionId) {
      const session = find(sessionId);
      return session ? info(session) : null;
    },

    listForUser(userId) {
      const actor = deps.ctx.currentActor();
      if (actor && actor !== userId) return [];
      return deps.sessions
        .listByOwner(userId)
        .filter(
          (session) =>
            session.protocol === protocol && !!session.guacamoleConnectionId,
        )
        .map(info);
    },

    async listAll() {
      if (!(await deps.ctx.rbac.has("monitor"))) return [];
      return deps.sessions
        .listAll()
        .filter((session) => session.protocol === protocol)
        .map(info);
    },

    async ownerEndSession(sessionId) {
      const session = find(sessionId);
      if (!session) return;
      if (!(await access(session))) {
        throw new Error("Not allowed to end this session");
      }
      deps.endSession(sessionId);
    },

    async createViewerToken(sessionId, readOnly, shareId) {
      const session = find(sessionId);
      if (!session) {
        throw new Error(`No live ${protocol} session ${sessionId}`);
      }
      const level = await access(session);
      if (!level) throw new Error("Not allowed to watch this session");
      return deps.tokens.createJoinToken(
        sessionId,
        level === "monitor" ? true : readOnly,
        level === "monitor" ? undefined : shareId,
      );
    },

    // A viewer has no Termix user here, so a whole share is closed at once.
    disconnectParticipants(sessionId, shareId) {
      if (!find(sessionId)) return 0;
      return deps.disconnectShare(sessionId, shareId);
    },
  };
}
