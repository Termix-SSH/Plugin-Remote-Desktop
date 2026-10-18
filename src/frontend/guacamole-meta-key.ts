export type MetaKeyFamily = "win" | "super" | "cmd";

export interface MetaKeyLabels {
  family: MetaKeyFamily;
  short: string;
  lock: string;
  stickyKey: string;
  keyTooltip: string;
  lockTooltip: string;
}

/**
 * RDP is a Windows desktop, so the toolbar keeps Windows labels. VNC is used
 * for Linux and macOS as often as Windows; branding those sessions with a
 * Windows key is wrong, and the local device is the only OS we can see.
 */
export function detectMetaKeyFamily(
  protocol: "rdp" | "vnc" | "ard" | "telnet",
  env: {
    platform?: string;
    userAgent?: string;
    userAgentDataPlatform?: string;
  } = {},
): MetaKeyFamily {
  if (protocol === "rdp") return "win";
  // An ARD host is always a Mac, whatever the browser runs on.
  if (protocol === "ard") return "cmd";

  const uaPlatform = env.userAgentDataPlatform ?? "";
  const platform = env.platform ?? "";
  const userAgent = env.userAgent ?? "";
  const haystack = `${uaPlatform} ${platform} ${userAgent}`;

  if (/iphone|ipad|ipod|mac/i.test(haystack)) return "cmd";
  if (/win/i.test(haystack)) return "win";
  return "super";
}

export function detectRuntimeMetaKeyFamily(
  protocol: "rdp" | "vnc" | "ard" | "telnet",
): MetaKeyFamily {
  if (typeof navigator === "undefined") {
    return detectMetaKeyFamily(protocol);
  }
  const uaData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return detectMetaKeyFamily(protocol, {
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    userAgentDataPlatform: uaData.userAgentData?.platform,
  });
}

export function metaKeyLabels(family: MetaKeyFamily): MetaKeyLabels {
  if (family === "cmd") {
    return {
      family,
      short: "Cmd",
      lock: "Cmd+L",
      stickyKey: "remoteDesktop.toolbar.cmd",
      keyTooltip: "remoteDesktop.toolbar.cmdKey",
      lockTooltip: "remoteDesktop.toolbar.cmdL",
    };
  }
  if (family === "super") {
    return {
      family,
      short: "Super",
      lock: "Super+L",
      stickyKey: "remoteDesktop.toolbar.super",
      keyTooltip: "remoteDesktop.toolbar.superKey",
      lockTooltip: "remoteDesktop.toolbar.superL",
    };
  }
  return {
    family,
    short: "Win",
    lock: "Win+L",
    stickyKey: "remoteDesktop.toolbar.win",
    keyTooltip: "remoteDesktop.toolbar.winKey",
    lockTooltip: "remoteDesktop.toolbar.winL",
  };
}

const META_LEFT = 0xffe7;
const META_RIGHT = 0xffe8;
const SUPER_LEFT = 0xffeb;
const SUPER_RIGHT = 0xffec;

/**
 * The key code to send for a key the browser pressed. guacamole-common-js
 * reports the browser's Meta key (Command on a Mac, Windows on a PC) as
 * Meta_L, which a Mac ignores as a modifier: Cmd+C arrives as a plain c. A Mac
 * reads Super_L as Command, so an ARD session sends that instead.
 */
export function remoteKeysym(
  protocol: "rdp" | "vnc" | "ard" | "telnet" | undefined,
  keysym: number,
): number {
  if (protocol !== "ard") return keysym;
  if (keysym === META_LEFT) return SUPER_LEFT;
  if (keysym === META_RIGHT) return SUPER_RIGHT;
  return keysym;
}
