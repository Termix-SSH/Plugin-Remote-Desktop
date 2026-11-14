// Desktop app only (Windows mstsc). The plugin process is fenced like on a
// server, so the .rdp file goes in the plugin's own data folder and the
// desktop app opens it (Windows hands .rdp files to mstsc).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface NativeRdpOptions {
  host?: unknown;
  port?: unknown;
  username?: unknown;
  domain?: unknown;
}

function singleLine(value: unknown, maxLength = 255): string {
  return String(value ?? "")
    .replace(/[\r\n\0]/g, "")
    .trim()
    .slice(0, maxLength);
}

export function validateNativeRdpOptions(options: NativeRdpOptions) {
  const host = singleLine(options?.host);
  const port = Number(options?.port ?? 3389);
  if (!host || host.length > 253 || /[\\/]/.test(host)) {
    throw new Error("Invalid RDP host");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid RDP port");
  }
  return {
    host,
    port,
    username: singleLine(options?.username),
    domain: singleLine(options?.domain),
  };
}

/** A prompt-for-credentials file. The password is never written. */
export function buildRdpFile(options: NativeRdpOptions): string {
  const { host, port, username, domain } = validateNativeRdpOptions(options);
  const address = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  const qualifiedUsername = username
    ? domain
      ? `${domain}\\${username}`
      : username
    : "";
  return [
    `full address:s:${address}`,
    "prompt for credentials:i:1",
    "administrative session:i:0",
    ...(qualifiedUsername ? [`username:s:${qualifiedUsername}`] : []),
    "",
  ].join("\r\n");
}

/** Opens Windows Remote Desktop (mstsc) on this computer. Windows only. */
export interface NativeRdpLauncher {
  /** The plugin's own data folder (ctx.files.dataDir()). */
  dataDir: () => Promise<string>;
  /** Opens a local file with its default app (ctx.desktop.local.fs.open). */
  open: (filePath: string) => Promise<void>;
}

export async function launchNativeRdp(
  options: NativeRdpOptions,
  launcher: NativeRdpLauncher,
  platform: NodeJS.Platform = process.platform,
): Promise<{ success: boolean; error?: string }> {
  if (platform !== "win32") {
    return {
      success: false,
      error: "Windows Remote Desktop is only available on Windows",
    };
  }

  const rdpContent = buildRdpFile(options);
  const dir = path.join(await launcher.dataDir(), "native-rdp", randomUUID());
  await fs.promises.mkdir(dir, { recursive: true });
  const rdpPath = path.join(dir, "connection.rdp");
  await fs.promises.writeFile(rdpPath, rdpContent, {
    encoding: "utf8",
    mode: 0o600,
  });
  const cleanup = () =>
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});

  try {
    await launcher.open(rdpPath);
  } catch (error) {
    void cleanup();
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // mstsc reads the file once it starts.
  setTimeout(cleanup, 30_000).unref();
  return { success: true };
}
