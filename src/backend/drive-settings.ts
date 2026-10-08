const GUACD_DRIVE_PATH_ENV = "GUACD_DRIVE_PATH";
const DEFAULT_DRIVE_ROOT = "/drive";

/**
 * Fills in where guacd keeps the files behind RDP drive redirection.
 *
 * The folder lives on the guacd host, not on Termix's - with the stock
 * compose it is a directory in the shared termix-data volume, configured
 * through GUACD_DRIVE_PATH. Each user gets a folder of their own underneath:
 * a shared drive would show everyone's uploads to everyone else. A host's own
 * drive-path is ignored, since it would point guacd at any folder it can see.
 */
export function withDriveSettings(
  guacConfig: Record<string, unknown>,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  if (!guacConfig["enable-drive"]) return guacConfig;
  const root = (
    env[GUACD_DRIVE_PATH_ENV]?.trim() || DEFAULT_DRIVE_ROOT
  ).replace(/\/+$/, "");
  return {
    ...guacConfig,
    "drive-path": `${root}/${userId}`,
    "create-drive-path": true,
  };
}
