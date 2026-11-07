import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import type { RecordingsWriter } from "../guacamole-server.js";
import { readHostSettings } from "../host-settings.js";
import { errorMessage, type RemoteDesktopLogger } from "../log.js";
import {
  createMoonlightClient,
  moonlightStreamUrl,
  MoonlightError,
  type MoonlightClient,
  type MoonlightConfig,
} from "./client.js";
import { createPairJobs, type PairJobs } from "./pairing.js";
import {
  createGrants,
  createHttpProxy,
  createSocketProxy,
  hostIdFromJson,
  PROXY_HTTP_PATH,
  PROXY_WS_PATH,
  type Grants,
} from "./proxy.js";

const SET_UP_PERMISSION = "moonlight";

export interface MoonlightDeps {
  ctx: PluginContext;
  log: RemoteDesktopLogger;
  enabled: () => Promise<boolean>;
  recordings: () => RecordingsWriter | null;
  /** Checks access and connect policy, answering the request when refused. */
  resolveTarget: (res: Response, hostId: number) => Promise<unknown>;
  client?: MoonlightClient;
  pairJobs?: PairJobs;
  grants?: Grants;
}

/** The stream page through Termix's own address, as a path. */
function proxiedStreamPath(
  options: Parameters<typeof moonlightStreamUrl>[1],
): string {
  const url = new URL(
    moonlightStreamUrl(
      `http://termix.local/plugin-api/remote-desktop${PROXY_HTTP_PATH}`,
      options,
    ),
  );
  return url.pathname + url.search;
}

function httpUrl(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  try {
    const { protocol } = new URL(text);
    return protocol === "http:" || protocol === "https:" ? text : "";
  } catch {
    return "";
  }
}

export async function readMoonlightConfig(
  ctx: PluginContext,
): Promise<MoonlightConfig | null> {
  const all = await ctx.settings.getAll("admin");
  const url = httpUrl(all.moonlightUrl);
  const username =
    typeof all.moonlightUsername === "string"
      ? all.moonlightUsername.trim()
      : "";
  const password =
    typeof all.moonlightPassword === "string" ? all.moonlightPassword : "";
  if (!url || !username || !password) return null;
  return {
    url,
    username,
    password,
    ignoreCert: all.moonlightIgnoreCert === true,
  };
}

const STATUS_FOR: Record<MoonlightError["code"], number> = {
  "not-configured": 409,
  "bad-login": 502,
  unreachable: 502,
  "needs-admin": 502,
  refused: 502,
};

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function registerMoonlightRoutes(
  router: Router,
  deps: MoonlightDeps,
): void {
  const { ctx, log } = deps;
  const client =
    deps.client ?? createMoonlightClient(() => readMoonlightConfig(ctx));
  const jobs = deps.pairJobs ?? createPairJobs(client);
  const grants = deps.grants ?? createGrants();

  const fail = (res: Response, error: unknown) => {
    if (error instanceof MoonlightError) {
      return res
        .status(STATUS_FOR[error.code])
        .json({ error: error.message, code: error.code });
    }
    log.error("Moonlight request failed", {
      operation: "moonlight_error",
      error: errorMessage(error),
    });
    return res.status(500).json({ error: "Moonlight request failed" });
  };

  const refuseWhenOff = async (res: Response): Promise<boolean> => {
    if (await deps.enabled()) return false;
    res.status(403).json({ error: "Remote Desktop is turned off" });
    return true;
  };

  // Moonlight Web's stream page, served through Termix so a tab can frame it.
  const proxyDeps = {
    client,
    grants,
    hostIdOf: hostIdFromJson,
    log: (message: string, meta?: Record<string, unknown>) =>
      log.warn(message, { operation: "moonlight_proxy", ...meta }),
  };
  const httpProxy = createHttpProxy(proxyDeps);
  const socketProxy = createSocketProxy(proxyDeps);
  router.use(
    PROXY_HTTP_PATH,
    ctx.rbac.require("sessions"),
    async (req: Request, res: Response) => {
      if (await refuseWhenOff(res)) return;
      await httpProxy(req, res);
    },
  );
  ctx.ws.upgrade(PROXY_WS_PATH, (request, socket, head, userId) =>
    socketProxy(
      request as Parameters<typeof socketProxy>[0],
      socket as Parameters<typeof socketProxy>[1],
      head as Buffer,
      userId,
    ),
  );

  /**
   * @openapi
   * /plugin-api/remote-desktop/moonlight/status:
   *   get:
   *     summary: Check the Moonlight Web server
   *     description: Says whether a Moonlight Web server is set up and the saved login works. Never returns the login.
   *     tags:
   *       - Remote Desktop
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: Whether it is configured and reachable, and why not.
   *       403:
   *         description: Remote Desktop is turned off.
   */
  router.get(
    "/moonlight/status",
    ctx.rbac.require("sessions"),
    async (_req: Request, res: Response) => {
      if (await refuseWhenOff(res)) return;
      try {
        await client.check();
        res.json({ configured: true, reachable: true });
      } catch (error) {
        if (!(error instanceof MoonlightError)) return fail(res, error);
        res.json({
          configured: error.code !== "not-configured",
          reachable: false,
          code: error.code,
          error: error.message,
        });
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/remote-desktop/moonlight/hosts:
   *   get:
   *     summary: List Moonlight Web PCs
   *     description: Lists the Sunshine PCs the saved Moonlight Web login can see.
   *     tags:
   *       - Remote Desktop
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: The PCs with their pairing state.
   *       403:
   *         description: Remote Desktop is turned off.
   *       409:
   *         description: Moonlight Web is not set up.
   *       502:
   *         description: Moonlight Web could not be reached or refused the login.
   *   post:
   *     summary: Add a Sunshine PC to Moonlight Web
   *     description: Adds the PC as a global host so every Moonlight Web user can stream it. A PC already there is reused.
   *     tags:
   *       - Remote Desktop
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - address
   *             properties:
   *               address:
   *                 type: string
   *               port:
   *                 type: integer
   *     responses:
   *       200:
   *         description: The PC.
   *       400:
   *         description: Missing or invalid address or port.
   *       403:
   *         description: Remote Desktop is turned off or the caller may not set up Moonlight.
   *       409:
   *         description: Moonlight Web is not set up.
   *       502:
   *         description: Moonlight Web could not be reached or refused the request.
   */
  router.get(
    "/moonlight/hosts",
    ctx.rbac.require("sessions"),
    async (_req: Request, res: Response) => {
      if (await refuseWhenOff(res)) return;
      try {
        res.json({ hosts: await client.listHosts() });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  router.post(
    "/moonlight/hosts",
    ctx.rbac.require(SET_UP_PERMISSION),
    async (req: Request, res: Response) => {
      if (await refuseWhenOff(res)) return;
      const body = (req.body ?? {}) as { address?: unknown; port?: unknown };
      const address =
        typeof body.address === "string" ? body.address.trim() : "";
      const port = body.port === undefined ? 47989 : Number(body.port);
      if (!address || !Number.isInteger(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: "Invalid address or port" });
      }
      try {
        res.json({ host: await client.addHost(address, port) });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/remote-desktop/moonlight/hosts/{id}/apps:
   *   get:
   *     summary: List the apps of a Moonlight Web PC
   *     tags:
   *       - Remote Desktop
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The apps Sunshine offers.
   *       400:
   *         description: Invalid PC id.
   *       403:
   *         description: Remote Desktop is turned off.
   *       409:
   *         description: Moonlight Web is not set up.
   *       502:
   *         description: Moonlight Web could not be reached or the PC is not paired.
   */
  router.get(
    "/moonlight/hosts/:id/apps",
    ctx.rbac.require("sessions"),
    async (req: Request, res: Response) => {
      if (await refuseWhenOff(res)) return;
      const id = positiveId(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid PC id" });
      try {
        res.json({ apps: await client.listApps(id) });
      } catch (error) {
        fail(res, error);
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/remote-desktop/moonlight/hosts/{id}/pair:
   *   post:
   *     summary: Start pairing a Moonlight Web PC
   *     description: Returns a PIN to enter in Sunshine. Poll the pairing job for the result.
   *     tags:
   *       - Remote Desktop
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The job id and PIN.
   *       400:
   *         description: Invalid PC id.
   *       401:
   *         description: Authentication required.
   *       403:
   *         description: Remote Desktop is turned off or the caller may not set up Moonlight.
   *       409:
   *         description: Moonlight Web is not set up.
   *       502:
   *         description: Moonlight Web could not be reached or refused the request.
   */
  router.post(
    "/moonlight/hosts/:id/pair",
    ctx.rbac.require(SET_UP_PERMISSION),
    async (req: Request, res: Response) => {
      if (await refuseWhenOff(res)) return;
      const userId = ctx.currentActor();
      if (!userId) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const id = positiveId(req.params.id);
      if (!id) return res.status(400).json({ error: "Invalid PC id" });
      try {
        res.json(await jobs.start(userId, id));
      } catch (error) {
        fail(res, error);
      }
    },
  );

  /**
   * @openapi
   * /plugin-api/remote-desktop/moonlight/pair/{job}:
   *   get:
   *     summary: Read a pairing job
   *     tags:
   *       - Remote Desktop
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: job
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: One of waiting, paired, failed or expired.
   *       401:
   *         description: Authentication required.
   *       404:
   *         description: No such job for this user.
   */
  router.get(
    "/moonlight/pair/:job",
    ctx.rbac.require(SET_UP_PERMISSION),
    (req: Request, res: Response) => {
      const userId = ctx.currentActor();
      if (!userId) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const state = jobs.state(String(req.params.job), userId);
      if (!state) return res.status(404).json({ error: "Pairing not found" });
      res.json({ state });
    },
  );

  /**
   * @openapi
   * /plugin-api/remote-desktop/moonlight/launch/{hostId}:
   *   post:
   *     summary: Get the stream address for a host
   *     description: Checks access and connect policy, then returns the Moonlight Web page to open. The browser signs in to Moonlight Web itself.
   *     tags:
   *       - Remote Desktop
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The stream address.
   *       400:
   *         description: Invalid host id.
   *       403:
   *         description: No access, Moonlight is off for this host, or recording is required.
   *       404:
   *         description: Host not found.
   *       409:
   *         description: Not set up, not linked, not paired, or the PC is offline.
   *       502:
   *         description: Moonlight Web could not be reached or refused the request.
   */
  router.post(
    "/moonlight/launch/:hostId",
    ctx.rbac.require("sessions"),
    async (req: Request, res: Response) => {
      if (await refuseWhenOff(res)) return;
      const hostId = positiveId(req.params.hostId);
      if (!hostId) return res.status(400).json({ error: "Invalid host id" });
      try {
        const target = await deps.resolveTarget(res, hostId);
        if (!target) return;
        const settings = await readHostSettings(ctx, hostId);
        if (!settings.enableMoonlight) {
          return res
            .status(403)
            .json({ error: "Moonlight is off for this host" });
        }
        // A stream goes straight to Moonlight Web, so Termix can't record it.
        const recordings = deps.recordings();
        const forced =
          !!recordings?.isForced &&
          (await recordings.isForced(hostId).catch(() => false));
        if (forced) {
          return res.status(403).json({
            error: "Recording is required on this host",
            code: "recording-required",
          });
        }
        const pc = (await client.listHosts()).find(
          (host) => host.id === settings.moonlightHostId,
        );
        if (!pc) {
          return res
            .status(409)
            .json({ error: "No PC is linked", code: "not-linked" });
        }
        if (!pc.paired) {
          return res
            .status(409)
            .json({ error: "The PC is not paired", code: "not-paired" });
        }
        if (!pc.online) {
          return res
            .status(409)
            .json({ error: "The PC is offline", code: "offline" });
        }
        const apps = await client.listApps(pc.id);
        const app =
          apps.find((item) => item.id === settings.moonlightAppId) ?? apps[0];
        if (!app) {
          return res
            .status(409)
            .json({ error: "The PC has no apps", code: "no-apps" });
        }
        const admin = await ctx.settings.getAll("admin");
        const base =
          httpUrl(admin.moonlightPublicUrl) || httpUrl(admin.moonlightUrl);
        await ctx.audit.record({
          action: "moonlight_connect",
          resourceType: "host",
          resourceId: String(hostId),
          resourceName: pc.name,
          success: true,
        });
        const userId = ctx.currentActor();
        if (userId) grants.allow(userId, pc.id);
        res.json({
          proxyUrl: proxiedStreamPath({
            hostId: pc.id,
            appId: app.id,
            bitrate: settings.moonlightBitrate,
            fps: settings.moonlightFps,
            transport: settings.moonlightTransport,
          }),
          url: moonlightStreamUrl(base, {
            hostId: pc.id,
            appId: app.id,
            bitrate: settings.moonlightBitrate,
            fps: settings.moonlightFps,
            transport: settings.moonlightTransport,
          }),
          app: app.title,
        });
      } catch (error) {
        fail(res, error);
      }
    },
  );
}
