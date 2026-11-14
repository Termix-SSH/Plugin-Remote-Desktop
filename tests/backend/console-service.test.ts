import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createConsoleService } from "../../src/backend/console-service.js";
import type { RemoteSessions } from "../../src/backend/sessions.js";
import { GuacamoleTokenService } from "../../src/backend/token-service.js";

function setup(
  options: { access?: boolean; actor?: string | null; mode?: string } = {},
) {
  const close = vi.fn(async () => undefined);
  const forward = vi.fn(async () => ({
    bindHost: "127.0.0.1",
    bindPort: 41000,
    close,
  }));
  const record = vi.fn(async () => undefined);
  const ctx = {
    currentActor: () =>
      options.actor === undefined ? "user-1" : options.actor,
    hosts: {
      checkAccess: async () => ({ hasAccess: options.access ?? true }),
      get: async () => ({ name: "kvm", ip: "10.0.0.1" }),
    },
    services: {
      providers: async () => ["tunnels"],
      get: async () => ({ forward }),
    },
    audit: { record },
  } as unknown as PluginContext;
  const park = vi.fn();
  const tokens = new GuacamoleTokenService();
  const createVncToken = vi.spyOn(tokens, "createVncToken");
  const service = createConsoleService({
    ctx,
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
    tokens,
    sessions: { park } as unknown as RemoteSessions,
    guacd: () => ({ host: "guacd", port: 4822 }),
    engineMode: () => (options.mode ?? "builtin") as "builtin",
  });
  return { service, forward, park, createVncToken, record };
}

describe("remote-desktop.console", () => {
  it("tunnels through the host and mints a VNC token", async () => {
    const { service, forward, park, createVncToken, record } = setup();
    const result = await service.open({
      hostId: 3,
      port: 5900,
      password: "secret",
    });
    expect(result.token).toBeTruthy();
    expect(forward).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ targetHost: "127.0.0.1", targetPort: 5900 }),
      expect.anything(),
    );
    expect(park).toHaveBeenCalledTimes(1);
    const [host, , password, settings, , meta] = createVncToken.mock.calls[0];
    expect(host).toBe("127.0.0.1");
    expect(password).toBe("secret");
    expect(settings).toEqual({ port: 41000 });
    expect(meta).toMatchObject({
      hostId: 3,
      ownerUserId: "user-1",
      protocol: "vnc",
    });
    expect(record).toHaveBeenCalled();
  });

  it("uses the address the host gave", async () => {
    const { service, forward } = setup();
    await service.open({ hostId: 3, address: "10.1.1.1", port: 5901 });
    expect(forward).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ targetHost: "10.1.1.1", targetPort: 5901 }),
      expect.anything(),
    );
  });

  it("refuses a caller with no access to the host", async () => {
    const { service, forward } = setup({ access: false });
    await expect(service.open({ hostId: 3, port: 5900 })).rejects.toThrow(
      "Host not found",
    );
    expect(forward).not.toHaveBeenCalled();
  });

  it("needs a signed in caller", async () => {
    const { service } = setup({ actor: null });
    await expect(service.open({ hostId: 3, port: 5900 })).rejects.toThrow();
  });

  it("refuses a bad port", async () => {
    const { service, forward } = setup();
    await expect(service.open({ hostId: 3, port: 70000 })).rejects.toThrow();
    expect(forward).not.toHaveBeenCalled();
  });
});
