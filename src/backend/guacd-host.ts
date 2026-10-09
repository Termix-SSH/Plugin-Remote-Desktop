import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";

/**
 * A host's own guacd address. Only admins may set one: it makes the server
 * open a TCP connection wherever it points, so it lives in a hidden admin
 * setting (hostId to address) that only the admin route below writes, not in
 * the host's guacamoleConfig, which anyone with edit access can change.
 */
export interface GuacdHostAddress {
  hostname?: string;
  port?: number;
}

export const GUACD_HOSTS_KEY = "hostGuacd";
const MIGRATED_KEY = "hostGuacdMigrated";
export const ADMIN_PERMISSION = "admin.plugins.manage";

type GuacdHostMap = Record<string, GuacdHostAddress>;

function asPort(value: unknown): number | undefined {
  const port = typeof value === "string" ? Number(value) : value;
  return typeof port === "number" &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65535
    ? port
    : undefined;
}

/** Cleans an address from a request or a stored value. Null when empty. */
export function normalizeGuacdAddress(raw: unknown): GuacdHostAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const hostname =
    typeof value.hostname === "string" ? value.hostname.trim() : "";
  const port = asPort(value.port);
  if (!hostname && !port) return null;
  return {
    ...(hostname ? { hostname } : {}),
    ...(port ? { port } : {}),
  };
}

/** The address in a guacamoleConfig, as 2.9 and older stored it. */
export function guacdFromConfig(
  config: Record<string, unknown>,
): GuacdHostAddress | null {
  return normalizeGuacdAddress({
    hostname: config["guacd-hostname"],
    port: config["guacd-port"],
  });
}

async function readMap(ctx: PluginContext): Promise<GuacdHostMap> {
  const value = await ctx.settings.get<unknown>(GUACD_HOSTS_KEY);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as GuacdHostMap)
    : {};
}

/**
 * The guacd address a host's sessions and status check use. The desktop app's
 * own backend serves only the person at the machine, so there a host's
 * guacamoleConfig still counts, which is how a synced host keeps its address.
 */
export async function readGuacdHost(
  ctx: PluginContext,
  hostId: number,
  guacamoleConfig: Record<string, unknown>,
): Promise<GuacdHostAddress | null> {
  const stored = normalizeGuacdAddress((await readMap(ctx))[String(hostId)]);
  if (stored) return stored;
  return ctx.desktop.available() ? guacdFromConfig(guacamoleConfig) : null;
}

/**
 * Saves or clears a host's address. Also kept in guacamoleConfig so the
 * desktop app's synced copy of the host has it. Callers check for an admin.
 */
export async function writeGuacdHost(
  ctx: PluginContext,
  hostId: number,
  address: GuacdHostAddress | null,
): Promise<void> {
  const map = { ...(await readMap(ctx)) };
  if (address) map[String(hostId)] = address;
  else delete map[String(hostId)];
  await ctx.settings.set(GUACD_HOSTS_KEY, map);

  const values = await ctx.settings.getAll("host", hostId);
  const config =
    values.guacamoleConfig &&
    typeof values.guacamoleConfig === "object" &&
    !Array.isArray(values.guacamoleConfig)
      ? { ...(values.guacamoleConfig as Record<string, unknown>) }
      : {};
  delete config["guacd-hostname"];
  delete config["guacd-port"];
  if (address?.hostname) config["guacd-hostname"] = address.hostname;
  if (address?.port) config["guacd-port"] = String(address.port);
  await ctx.settings.setHost(hostId, "guacamoleConfig", config);
}

/**
 * Once per install: hosts that already had a guacd address in their
 * guacamoleConfig keep it. After this only the admin route adds one.
 */
export async function migrateGuacdHosts(ctx: PluginContext): Promise<void> {
  if ((await ctx.settings.get<boolean>(MIGRATED_KEY)) === true) return;
  const map = { ...(await readMap(ctx)) };
  for (const { hostId, value } of await ctx.settings.listHostValues<unknown>(
    "guacamoleConfig",
  )) {
    let config: unknown = value;
    if (typeof config === "string") {
      try {
        config = JSON.parse(config);
      } catch {
        continue;
      }
    }
    if (map[String(hostId)] || !config || typeof config !== "object") continue;
    const address = guacdFromConfig(config as Record<string, unknown>);
    if (address) map[String(hostId)] = address;
  }
  await ctx.settings.set(GUACD_HOSTS_KEY, map);
  await ctx.settings.set(MIGRATED_KEY, true);
}
