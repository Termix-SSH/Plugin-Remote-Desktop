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
  protocol: "rdp" | "vnc" | "ard" | "telnet" | "rustdesk",
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
  protocol: "rdp" | "vnc" | "ard" | "telnet" | "rustdesk",
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
const ALT_LEFT = 0xffe9;
const ALT_RIGHT = 0xffea;
const ALT_GRAPH = 0xfe03;

// The unshifted US character for each physical key, which is how a Mac finds
// the key behind a code. Its own layout then decides what Option+key types.
const US_KEY_BY_CODE: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: " ",
};

function usKeysymForCode(code: string): number | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase().charCodeAt(0);
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1].charCodeAt(0);
  const other = US_KEY_BY_CODE[code];
  return other ? other.charCodeAt(0) : null;
}

/** A character, as opposed to a function key or a modifier. */
function isCharacterKeysym(keysym: number): boolean {
  return (keysym >= 0x20 && keysym <= 0xff) || keysym >= 0x01000000;
}

const optionsDown = new Set<number>();
const optionKeysSent = new Map<number, number>();
let lastKeyCode = "";

// guacamole-common-js reports every right Alt as AltGr. A layout without
// AltGr (Korean, where it is the Han/Eng key) needs a real Alt_R instead.
let rightAltIsPlain = false;
let rightAltSentAs: number | null = null;

// The Korean Han/Eng and Hanja keys flip the remote IME on every press, so the
// key repeat guacamole-common-js runs for a held key must not reach the host.
const TOGGLE_KEYS: Record<string, number> = {
  HangulMode: 0xff31,
  HanjaMode: 0xff34,
};
const toggleKeysyms = new Set(Object.values(TOGGLE_KEYS));

/** Tracks whether the browser sees right Alt as Alt or as AltGraph. */
export function watchRightAlt(
  target: HTMLElement,
  onToggle?: (keysym: number) => void,
): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.code === "AltRight") rightAltIsPlain = event.key === "Alt";
    if (event.type !== "keyup") lastKeyCode = event.code;
    const toggle = TOGGLE_KEYS[event.key];
    if (toggle === undefined) return;
    // Some Korean drivers never send a matching keyup. Keep these keys out
    // of Guacamole's pressed table and software repeat timer entirely.
    if (!onToggle) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "keydown" && !event.repeat) onToggle(toggle);
  };
  target.addEventListener("keydown", onKey, true);
  target.addEventListener("keyup", onKey, true);
  // A Mac browser reports what Option types on keypress, not keydown.
  target.addEventListener("keypress", onKey, true);
  return () => {
    target.removeEventListener("keydown", onKey, true);
    target.removeEventListener("keyup", onKey, true);
    target.removeEventListener("keypress", onKey, true);
    rightAltIsPlain = false;
    rightAltSentAs = null;
    optionsDown.clear();
    optionKeysSent.clear();
    lastKeyCode = "";
  };
}

/** Toggle keys are sent as a single down/up pulse, never held remotely. */
export function isToggleKey(keysym: number): boolean {
  return toggleKeysyms.has(keysym);
}

/**
 * The key code to send for a key the browser pressed. guacamole-common-js
 * reports the browser's Meta key (Command on a Mac, Windows on a PC) as
 * Meta_L, which a Mac ignores as a modifier: Cmd+C arrives as a plain c. A Mac
 * reads Super_L as Command, so an ARD session sends that instead.
 *
 * With Option held the browser has already applied the local layout (Option+2
 * is @ on a Spanish Mac). An ARD session sends Option plus the physical key
 * instead, so the Mac types the character through its own layout.
 */
export function remoteKeysym(
  protocol: "rdp" | "vnc" | "ard" | "telnet" | "rustdesk" | undefined,
  keysym: number,
  down = true,
): number {
  if (protocol === "rdp" && keysym === ALT_GRAPH) {
    if (down) rightAltSentAs = rightAltIsPlain ? ALT_RIGHT : ALT_GRAPH;
    const sent = rightAltSentAs ?? ALT_GRAPH;
    if (!down) rightAltSentAs = null;
    return sent;
  }
  if (protocol !== "ard") return keysym;
  if (keysym === META_LEFT) return SUPER_LEFT;
  if (keysym === META_RIGHT) return SUPER_RIGHT;
  // Right Option arrives as AltGr, which a Mac does not know.
  const option = keysym === ALT_GRAPH && rightAltIsPlain ? ALT_RIGHT : keysym;
  if (option === ALT_LEFT || option === ALT_RIGHT) {
    if (down) optionsDown.add(option);
    else optionsDown.delete(option);
    return option;
  }
  if (down) {
    const physical =
      optionsDown.size > 0 && isCharacterKeysym(keysym)
        ? usKeysymForCode(lastKeyCode)
        : null;
    if (physical === null) return keysym;
    optionKeysSent.set(keysym, physical);
    return physical;
  }
  const sent = optionKeysSent.get(keysym);
  if (sent === undefined) return keysym;
  optionKeysSent.delete(keysym);
  return sent;
}

type KeyboardLock = {
  lock?: (codes: string[]) => Promise<void>;
  unlock?: () => void;
};

/**
 * Claims the Windows keys for a focused session, so Win+R and the like reach
 * the remote desktop instead of the local one. Browsers only honour the lock
 * in fullscreen, so windowed sessions keep the toolbar keys.
 */
export function systemKeyLock(
  keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard,
): (on: boolean) => void {
  let locked = false;
  return (on) => {
    if (on === locked) return;
    locked = on;
    if (on) void keyboard?.lock?.(["MetaLeft", "MetaRight"])?.catch(() => {});
    else keyboard?.unlock?.();
  };
}
