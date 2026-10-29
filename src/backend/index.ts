import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { GuacamoleTokenService } from "./token-service.js";
import { RemoteSessions } from "./sessions.js";
import {
  createGuacamoleServer,
  persistRecording,
  recordingsDir,
  type RecordingsWriter,
} from "./guacamole-server.js";
import { BuiltinEngine, resolveEngineMode } from "./engine/index.js";
import { createDisplayGateway } from "./display-gateway.js";
import { resolveGuacdOptions } from "./guacd-config.js";
import { registerRoutes } from "./routes.js";
import { createLiveSessions } from "./live-sessions.js";
import {
  hostPayloadLegacy,
  normalizeImportedHost,
  PORT_KEY,
  readHostSettings,
} from "./host-settings.js";
import { createLogger } from "./log.js";
import { migrateGuacdHosts } from "./guacd-host.js";

export async function activate(ctx: PluginContext) {
  const log = createLogger(ctx.log);
  const tokens = new GuacamoleTokenService(log);
  const sessions = new RemoteSessions();
  ctx.disposables.add(() => sessions.clear());

  // The admin setting, unless GUACD_URL / GUACD_HOST / GUACD_PORT override it.
  let guacdUrl = (await ctx.settings.get<string>("guacdUrl")) ?? "";
  const guacd = () => resolveGuacdOptions(guacdUrl || undefined);
  const enabled = async () =>
    (await ctx.settings.get<boolean>("enabled")) !== false;
  // Built in unless the admin setting or REMOTE_DESKTOP_ENGINE says guacd.
  let useGuacd = await ctx.settings.get<boolean>("useGuacd");
  const engineMode = () => resolveEngineMode(useGuacd);
  ctx.settings.onChange("useGuacd", (value) => {
    useGuacd = value === true;
  });

  // Optional: without session-recording nothing is recorded.
  const recordings = (): RecordingsWriter | null => {
    // A handle to a disabled provider still has its methods, but they throw.
    if (!ctx.services.providers("recordings.writer").includes("")) return null;
    const service =
      ctx.services.get<Partial<RecordingsWriter>>("recordings.writer");
    return typeof service.createFinished === "function" &&
      typeof service.enabledFor === "function"
      ? (service as RecordingsWriter)
      : null;
  };

  // guacamole-lite prints every new connection to stdout.
  const consoleLog = console.log;
  console.log = (...args: unknown[]) => {
    if (
      typeof args[0] === "string" &&
      args[0].startsWith("New client connection")
    )
      return;
    consoleLog(...args);
  };
  ctx.disposables.add(() => {
    console.log = consoleLog;
  });

  const asUser = <T>(userId: string, fn: () => Promise<T>) =>
    ctx.asUser(userId, fn);
  const engine = new BuiltinEngine({
    log,
    sessions,
    recordingsDir: () => recordingsDir(),
    onRecording: ({ recording }) =>
      persistRecording({ log, recordings, asUser }, recording),
    onOpen: (hostId) => ctx.hosts.trackSession(hostId),
  });
  ctx.disposables.add(() => engine.close());

  const server = createGuacamoleServer({
    log,
    tokens,
    sessions,
    guacd,
    recordings,
    asUser,
    onOpen: (hostId) => ctx.hosts.trackSession(hostId),
  });
  ctx.disposables.add(() => server.close());
  const endSession = (id: string) =>
    engine.endSession(id) || server.endSession(id);
  const disconnectShare = (id: string, shareId: string) =>
    engine.disconnectShare(id, shareId) + server.disconnectShare(id, shareId);

  ctx.settings.onChange("guacdUrl", (value) => {
    guacdUrl = typeof value === "string" ? value : "";
    server.restart();
  });

  await migrateGuacdHosts(ctx).catch((error) =>
    log.warn("Failed to move host guacd addresses", {
      operation: "guacd_host_migrate_error",
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  registerRoutes(ctx.http.router(), {
    ctx,
    log,
    tokens,
    sessions,
    guacd,
    enabled,
    recordings,
    engineMode,
    recordingControl: engine,
    guacdConfigured: () =>
      !!(
        process.env.GUACD_URL ||
        process.env.GUACD_HOST ||
        process.env.GUACD_PORT ||
        guacdUrl
      ),
  });

  // Both engines own their WebSocketServer, so they take the raw upgrade.
  // Public because a display authenticates with the encrypted, single-use
  // token minted by an authenticated route, not with a session JWT.
  const gateway = createDisplayGateway({
    tokens,
    mode: engineMode,
    builtin: engine,
    guacd: server,
  });
  ctx.ws.upgrade(
    "/display",
    (request, socket, head) =>
      gateway(
        request as Parameters<typeof gateway>[0],
        socket as Parameters<typeof gateway>[1],
        head as Buffer,
      ),
    { public: true },
  );

  for (const protocol of ["rdp", "vnc", "ard", "telnet"] as const) {
    ctx.services.provide(
      "sessions.live",
      createLiveSessions(protocol, {
        sessions,
        tokens,
        endSession,
        disconnectShare,
      }),
      { name: protocol },
    );
  }

  ctx.registry.provide(
    "remote-desktop.hostImportNormalizer",
    normalizeImportedHost,
  );
  ctx.registry.provide("remote-desktop.hostPayloadLegacy", hostPayloadLegacy);

  // Core's status dot pings these hosts on the protocol's own port.
  for (const protocol of ["rdp", "vnc", "ard", "telnet"] as const) {
    ctx.hosts.status.registerPort(protocol, async (hostId) => {
      const settings = await readHostSettings(ctx, hostId);
      return settings[PORT_KEY[protocol]] as number;
    });
  }
}

export async function deactivate() {}
