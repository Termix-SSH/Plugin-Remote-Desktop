import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteSessions } from "../../src/backend/sessions.js";
import { createLiveSessions } from "../../src/backend/live-sessions.js";
import { GuacamoleTokenService } from "../../src/backend/token-service.js";

const meta = {
  termixConnectId: "c1",
  hostId: 7,
  hostName: "Win box",
  ownerUserId: "user-1",
  protocol: "rdp" as const,
  tabInstanceId: "tab-1",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("RemoteSessions", () => {
  it("moves parked resources onto the session and releases them on close", () => {
    const sessions = new RemoteSessions();
    const tunnel = vi.fn();
    const tracking = vi.fn();
    sessions.park("c1", [tunnel]);
    sessions.opened(meta, "g1", [tracking]);

    expect(sessions.byConnect("c1")?.guacamoleConnectionId).toBe("g1");
    expect(sessions.byGuacamole("g1")?.hostName).toBe("Win box");
    expect(tunnel).not.toHaveBeenCalled();

    sessions.closed("c1");
    expect(tunnel).toHaveBeenCalledOnce();
    expect(tracking).toHaveBeenCalledOnce();
    expect(sessions.byGuacamole("g1")).toBeNull();
  });

  it.each(["vnc", "rdp"] as const)(
    "keeps an opened %s session's proxy and jump tunnel alive beyond one hour",
    (protocol) => {
      vi.useFakeTimers();
      const sessions = new RemoteSessions();
      const proxy = vi.fn();
      const tunnel = vi.fn();
      sessions.park("c1", [proxy, tunnel]);
      sessions.opened({ ...meta, protocol }, "g1");
      vi.advanceTimersByTime(2 * 60 * 60 * 1000);
      expect(proxy).not.toHaveBeenCalled();
      expect(tunnel).not.toHaveBeenCalled();
      expect(sessions.byConnect("c1")?.guacamoleConnectionId).toBe("g1");
      sessions.closed("c1");
      sessions.closed("c1");
      expect(proxy).toHaveBeenCalledOnce();
      expect(tunnel).toHaveBeenCalledOnce();
    },
  );

  it("releases a tunnel guacd never used", () => {
    vi.useFakeTimers();
    const sessions = new RemoteSessions(1000);
    const tunnel = vi.fn();
    sessions.park("c1", [tunnel]);
    vi.advanceTimersByTime(1000);
    expect(tunnel).toHaveBeenCalledOnce();
  });

  it("releases everything on clear, and one failing close does not stop the rest", () => {
    const sessions = new RemoteSessions();
    const failing = vi.fn(() => {
      throw new Error("already closed");
    });
    const pending = vi.fn();
    const open = vi.fn();
    sessions.park("c2", [failing, pending]);
    sessions.park("c1", [open]);
    sessions.opened(meta, "g1");
    sessions.clear();
    expect(pending).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
  });
});

describe("sessions.live providers", () => {
  const tokens = new GuacamoleTokenService();
  // A fake ctx: actor and whether they hold remote-desktop.monitor.
  const fakeCtx = (actor: string | undefined, monitor = false) => ({
    currentActor: () => actor,
    rbac: { has: async (name: string) => monitor && name === "monitor" },
  });
  const build = (
    protocol: "rdp" | "vnc",
    extra: Partial<Parameters<typeof createLiveSessions>[1]> = {},
  ) => {
    const sessions = extra.sessions ?? new RemoteSessions();
    if (!extra.sessions) sessions.opened(meta, "g1");
    return createLiveSessions(protocol, {
      ctx: fakeCtx(undefined) as never,
      sessions,
      tokens,
      endSession: vi.fn(() => true),
      disconnectShare: vi.fn(() => 0),
      ...extra,
    });
  };

  it("describes a live session of its own protocol only", () => {
    const sessions = new RemoteSessions();
    sessions.opened(meta, "g1");
    const rdp = build("rdp", { sessions, isRecording: () => true });
    const vnc = build("vnc", { sessions });

    expect(rdp.getSession("g1")).toMatchObject({
      id: "g1",
      userId: "user-1",
      hostId: 7,
      hostName: "Win box",
      isConnected: true,
      tabInstanceId: "tab-1",
      protocol: "rdp",
      recording: true,
    });
    expect(vnc.getSession("g1")).toBeNull();
  });

  it("mints a join token for a viewer and refuses an unknown session", async () => {
    const rdp = build("rdp");
    const token = tokens.decryptToken(await rdp.createViewerToken("g1", true));
    expect(token?.connection).toMatchObject({ join: "g1", readOnly: true });
    expect(token?.recording).toBeUndefined();
    await expect(rdp.createViewerToken("nope", false)).rejects.toThrow();
  });

  it("ends the session for its owner", async () => {
    const endSession = vi.fn(() => true);
    const rdp = build("rdp", {
      ctx: fakeCtx("user-1") as never,
      endSession,
    });
    await rdp.ownerEndSession("g1", "owner ended");
    expect(endSession).toHaveBeenCalledWith("g1");
  });

  it("lists a user's own sessions only for that user", () => {
    const owner = build("rdp", { ctx: fakeCtx("user-1") as never });
    expect(owner.listForUser("user-1").map((row) => row.id)).toEqual(["g1"]);
    const other = build("rdp", { ctx: fakeCtx("user-2") as never });
    expect(other.listForUser("user-1")).toEqual([]);
  });

  it("refuses someone else without monitor", async () => {
    const endSession = vi.fn(() => true);
    const rdp = build("rdp", { ctx: fakeCtx("user-2") as never, endSession });
    await expect(rdp.ownerEndSession("g1", "x")).rejects.toThrow(/Not allowed/);
    await expect(rdp.createViewerToken("g1", false)).rejects.toThrow(
      /Not allowed/,
    );
    expect(await rdp.listAll()).toEqual([]);
    expect(endSession).not.toHaveBeenCalled();
  });

  it("lets a monitor list, watch read only and end", async () => {
    const endSession = vi.fn(() => true);
    const rdp = build("rdp", {
      ctx: fakeCtx("auditor", true) as never,
      endSession,
    });
    expect((await rdp.listAll()).map((row) => row.id)).toEqual(["g1"]);
    const token = tokens.decryptToken(
      await rdp.createViewerToken("g1", false, "s1"),
    );
    expect(token?.connection).toMatchObject({ join: "g1", readOnly: true });
    expect(token?.connection.settings ?? {}).toEqual({});
    await rdp.ownerEndSession("g1", "auditor");
    expect(endSession).toHaveBeenCalledWith("g1");
  });

  it("carries the share in a join token and closes that share's viewers", async () => {
    const disconnectShare = vi.fn(() => 2);
    const rdp = build("rdp", { disconnectShare });
    const token = tokens.decryptToken(
      await rdp.createViewerToken("g1", true, "s1"),
    );
    expect(token?.connection.settings).toEqual({ "termix-share-id": "s1" });
    expect(rdp.disconnectParticipants("g1", "s1")).toBe(2);
    expect(disconnectShare).toHaveBeenCalledWith("g1", "s1");
    expect(rdp.disconnectParticipants("nope", "s1")).toBe(0);
  });
});

describe("RemoteSessions.listByOwner", () => {
  it("returns only the owner's open sessions, newest first", () => {
    const sessions = new RemoteSessions();
    const meta = (id: string, owner: string) =>
      ({
        termixConnectId: id,
        hostId: 1,
        hostName: "h",
        ownerUserId: owner,
        protocol: "rdp",
      }) as never;
    sessions.opened(meta("a", "u1"), "ga");
    sessions.opened(meta("b", "u2"), "gb");
    sessions.opened(meta("c", "u1"), "gc");
    expect(sessions.listByOwner("u1").map((s) => s.termixConnectId)).toEqual(
      expect.arrayContaining(["a", "c"]),
    );
    expect(sessions.listByOwner("u1")).toHaveLength(2);
    sessions.clear();
  });
});
