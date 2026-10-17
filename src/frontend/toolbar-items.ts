import { useMemo, type ComponentType } from "react";
import {
  ArrowUpDown,
  FolderOpen,
  Keyboard,
  Lock,
  MousePointer,
  Search,
  ToggleLeft,
} from "lucide-react";
import {
  useSlotContributions,
  type SlotContribution,
} from "@termix-ssh/plugin-sdk/frontend";

export const REMOTE_DESKTOP_TOOLBAR_SLOT = "remote-desktop.toolbar";

type Icon = ComponentType<{ className?: string }>;

export type ToolbarProtocol = "rdp" | "vnc" | "telnet";

/** Keys a single press sends: pressed in order, released in reverse. */
export interface KeyButton {
  id: string;
  /** Printed on the button, like a key cap. */
  cap: string;
  titleKey: string;
  keys: number[];
}

export const KEYSYM = {
  ctrl: 0xffe3,
  alt: 0xffe9,
  shift: 0xffe1,
  meta: 0xffeb,
  delete: 0xffff,
  l: 0x006c,
} as const;

export const NAV_KEYS: KeyButton[] = [
  {
    id: "esc",
    cap: "Esc",
    titleKey: "remoteDesktop.toolbar.esc",
    keys: [0xff1b],
  },
  {
    id: "tab",
    cap: "Tab",
    titleKey: "remoteDesktop.toolbar.tab",
    keys: [0xff09],
  },
  {
    id: "home",
    cap: "Home",
    titleKey: "remoteDesktop.toolbar.home",
    keys: [0xff50],
  },
  {
    id: "end",
    cap: "End",
    titleKey: "remoteDesktop.toolbar.end",
    keys: [0xff57],
  },
  {
    id: "pageUp",
    cap: "PgUp",
    titleKey: "remoteDesktop.toolbar.pageUp",
    keys: [0xff55],
  },
  {
    id: "pageDown",
    cap: "PgDn",
    titleKey: "remoteDesktop.toolbar.pageDown",
    keys: [0xff56],
  },
];

export const ARROW_KEYS = [
  { dir: "up", titleKey: "remoteDesktop.toolbar.arrowUp", key: 0xff52 },
  { dir: "left", titleKey: "remoteDesktop.toolbar.arrowLeft", key: 0xff51 },
  { dir: "down", titleKey: "remoteDesktop.toolbar.arrowDown", key: 0xff54 },
  { dir: "right", titleKey: "remoteDesktop.toolbar.arrowRight", key: 0xff53 },
] as const;

export const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => ({
  cap: `F${i + 1}`,
  key: 0xffbe + i,
}));

export type ToolbarItemSource =
  { kind: "builtin" } | { kind: "action"; contribution: SlotContribution };

export interface ToolbarItemInfo {
  id: string;
  titleKey: string;
  icon?: Icon;
  /** Shown under the name in the host editor. */
  hintKey?: string;
  /** Which sessions have it. Contributed actions show everywhere. */
  protocols?: ToolbarProtocol[];
  source: ToolbarItemSource;
}

const DESKTOP: ToolbarProtocol[] = ["rdp", "vnc"];

/** The toolbar's own buttons, in their default order. */
export const BUILTIN_ITEMS: ToolbarItemInfo[] = [
  {
    id: "files",
    titleKey: "remoteDesktop.toolbar.items.files",
    icon: FolderOpen,
    hintKey: "remoteDesktop.toolbar.hints.files",
    protocols: ["rdp"],
    source: { kind: "builtin" },
  },
  {
    id: "touchMode",
    titleKey: "remoteDesktop.toolbar.items.touchMode",
    icon: MousePointer,
    hintKey: "remoteDesktop.toolbar.hints.touchMode",
    source: { kind: "builtin" },
  },
  {
    id: "zoom",
    titleKey: "remoteDesktop.toolbar.items.zoom",
    icon: Search,
    protocols: DESKTOP,
    source: { kind: "builtin" },
  },
  {
    id: "ctrlAltDel",
    titleKey: "remoteDesktop.toolbar.ctrlAltDel",
    icon: Keyboard,
    protocols: DESKTOP,
    source: { kind: "builtin" },
  },
  {
    id: "lock",
    titleKey: "remoteDesktop.toolbar.items.lock",
    icon: Lock,
    protocols: DESKTOP,
    source: { kind: "builtin" },
  },
  {
    id: "metaKey",
    titleKey: "remoteDesktop.toolbar.items.metaKey",
    protocols: DESKTOP,
    source: { kind: "builtin" },
  },
  {
    id: "modifiers",
    titleKey: "remoteDesktop.toolbar.items.modifiers",
    icon: ToggleLeft,
    hintKey: "remoteDesktop.toolbar.hints.modifiers",
    protocols: DESKTOP,
    source: { kind: "builtin" },
  },
  {
    id: "functionKeys",
    titleKey: "remoteDesktop.toolbar.fnToggle",
    source: { kind: "builtin" },
  },
  ...NAV_KEYS.map((key): ToolbarItemInfo => ({
    id: key.id,
    titleKey: key.titleKey,
    source: { kind: "builtin" },
  })),
  {
    id: "arrows",
    titleKey: "remoteDesktop.toolbar.items.arrows",
    icon: ArrowUpDown,
    source: { kind: "builtin" },
  },
];

/**
 * Every button the toolbar can show: its own, then what other plugins add
 * (the share button). The host editor lists the same set.
 */
export function useToolbarItems(
  when?: Record<string, unknown>,
): ToolbarItemInfo[] {
  const contributions = useSlotContributions(REMOTE_DESKTOP_TOOLBAR_SLOT, when);
  return useMemo(() => {
    const actions = contributions
      .filter((contribution) => contribution.kind !== "component")
      .map((contribution): ToolbarItemInfo => ({
        id: contribution.actionId,
        titleKey: contribution.titleKey,
        icon: contribution.icon as Icon | undefined,
        source: { kind: "action", contribution },
      }));
    return [...BUILTIN_ITEMS, ...actions];
  }, [contributions]);
}
