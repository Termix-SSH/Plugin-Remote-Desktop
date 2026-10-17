import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  MoreHorizontal,
  MousePointer,
  Scan,
  Touchpad,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  cn,
} from "@termix-ssh/plugin-sdk/ui";
import { invokeAction, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type {
  GuacamoleDisplayHandle,
  GuacamoleTouchMode,
} from "./GuacamoleDisplay.tsx";
import {
  detectRuntimeMetaKeyFamily,
  metaKeyLabels,
  type MetaKeyFamily,
} from "./guacamole-meta-key.ts";
import {
  ARROW_KEYS,
  FUNCTION_KEYS,
  KEYSYM,
  NAV_KEYS,
  REMOTE_DESKTOP_TOOLBAR_SLOT,
  useToolbarItems,
  type ToolbarItemInfo,
} from "./toolbar-items.ts";
import {
  DEFAULT_TOOLBAR_SETTINGS,
  countFittingButtons,
  visibleButtons,
  type ToolbarSettings,
} from "./toolbar-settings.ts";

export { REMOTE_DESKTOP_TOOLBAR_SLOT };

interface GuacamoleToolbarProps {
  displayRef: React.RefObject<GuacamoleDisplayHandle>;
  protocol: "rdp" | "vnc" | "telnet";
  settings?: ToolbarSettings;
  touchMode?: GuacamoleTouchMode | null;
  hasFilesystem?: boolean;
  fileBrowserOpen?: boolean;
  onToggleFileBrowser?: () => void;
  onTouchModeChange?: (mode: GuacamoleTouchMode) => void;
  zoom?: number;
  metaKeyFamily?: MetaKeyFamily;
  /** Handed to "remote-desktop.toolbar" actions (the share button). */
  slotContext?: RemoteDesktopToolbarContext;
}

/** What a "remote-desktop.toolbar" action is invoked with. */
interface RemoteDesktopToolbarContext {
  hostId: number;
  /** The engine's connection id, once the session is up. */
  sessionId: string | null;
  protocol: "rdp" | "vnc" | "ard" | "telnet";
  tabInstanceId?: string;
  /** The backend the session runs on. */
  origin?: "local" | "remote";
}

const BUTTON =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-muted data-[state=open]:text-foreground";
const ICON_BUTTON = cn(BUTTON, "w-7 px-0");
const LATCHED = "bg-primary/15 text-primary hover:bg-primary/20";

const MODIFIERS = [
  { id: "ctrl", key: KEYSYM.ctrl, labelKey: "remoteDesktop.toolbar.ctrl" },
  { id: "alt", key: KEYSYM.alt, labelKey: "remoteDesktop.toolbar.alt" },
  { id: "shift", key: KEYSYM.shift, labelKey: "remoteDesktop.toolbar.shift" },
  { id: "meta", key: KEYSYM.meta, labelKey: "" },
] as const;

const ARROW_ICONS = {
  up: ChevronUp,
  left: ChevronLeft,
  down: ChevronDown,
  right: ChevronRight,
};

interface MenuEntry {
  key: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  checked?: boolean;
  children?: MenuEntry[];
  run?: () => void;
}

/** A strip docked to the top or bottom edge of the session. */
export const GuacamoleToolbar: React.FC<GuacamoleToolbarProps> = ({
  displayRef,
  protocol,
  settings = DEFAULT_TOOLBAR_SETTINGS,
  touchMode,
  hasFilesystem = false,
  fileBrowserOpen = false,
  onToggleFileBrowser,
  onTouchModeChange,
  zoom = 1,
  metaKeyFamily,
  slotContext,
}) => {
  const { t } = useTranslation();
  const meta = metaKeyLabels(
    metaKeyFamily ?? detectRuntimeMetaKeyFamily(protocol),
  );
  const catalog = useToolbarItems(slotContext ? { ...slotContext } : undefined);

  const items = useMemo(
    () =>
      visibleButtons(catalog, settings.buttons).filter((item) => {
        if (item.protocols && !item.protocols.includes(protocol)) return false;
        if (item.id === "files") return hasFilesystem && !!onToggleFileBrowser;
        if (item.id === "touchMode") {
          return touchMode != null && !!onTouchModeChange;
        }
        return true;
      }),
    [
      catalog,
      settings.buttons,
      protocol,
      hasFilesystem,
      onToggleFileBrowser,
      touchMode,
      onTouchModeChange,
    ],
  );

  // Latched modifiers: the ref is what has been sent, the state redraws.
  const latchedRef = useRef(new Set<number>());
  const [latched, setLatched] = useState<ReadonlySet<number>>(new Set());

  const sendKey = useCallback(
    (key: number, pressed: boolean) =>
      displayRef.current?.sendKey(key, pressed),
    [displayRef],
  );

  const releaseLatched = useCallback(() => {
    for (const key of latchedRef.current) sendKey(key, false);
    latchedRef.current.clear();
    setLatched(new Set());
  }, [sendKey]);

  const sendCombo = useCallback(
    (...keys: number[]) => {
      for (const key of keys) sendKey(key, true);
      for (const key of [...keys].reverse()) sendKey(key, false);
      releaseLatched();
    },
    [sendKey, releaseLatched],
  );

  const toggleLatch = useCallback(
    (key: number) => {
      const set = latchedRef.current;
      const down = !set.has(key);
      if (down) set.add(key);
      else set.delete(key);
      sendKey(key, down);
      setLatched(new Set(set));
    },
    [sendKey],
  );

  const modifierLabel = (labelKey: string) =>
    labelKey ? t(labelKey) : t(meta.stickyKey);

  // fit is how many items stay on the strip, null for all of them.
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const labeledRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{
    labeled: boolean;
    fit: number | null;
  }>(() => ({ labeled: settings.labels === "labeled", fit: null }));

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const available = row.getBoundingClientRect().width;
      if (available <= 0) return;
      const widths = (measured: HTMLDivElement | null) =>
        Array.from(measured?.children ?? []).map(
          (child) => child.getBoundingClientRect().width,
        );
      const labeled = widths(labeledRef.current);
      const icons = widths(iconRef.current);
      // The last measured child is the overflow trigger.
      const overflowWidth = icons.pop() ?? 0;
      labeled.pop();
      const labeledTotal = labeled.reduce((sum, width) => sum + width, 0);
      const fit = countFittingButtons(icons, available, overflowWidth);
      const next =
        settings.labels === "labeled" && labeledTotal <= available
          ? { labeled: true, fit: null }
          : { labeled: false, fit: fit >= icons.length ? null : fit };
      setLayout((current) =>
        current.labeled === next.labeled && current.fit === next.fit
          ? current
          : next,
      );
    };
    const schedule = () => {
      if (frame == null) frame = window.requestAnimationFrame(measure);
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    observer?.observe(row);
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [items, settings.labels, t, zoom, latched, meta.short]);

  const menuSide = settings.position === "top" ? "bottom" : "top";

  const iconButton = (
    key: string,
    title: string,
    Icon: React.ComponentType<{ className?: string }>,
    onClick: () => void,
    active = false,
  ) => (
    <button
      key={key}
      type="button"
      className={cn(ICON_BUTTON, active && LATCHED)}
      aria-label={title}
      title={title}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
    </button>
  );

  const textButton = (
    key: string,
    title: string,
    label: React.ReactNode,
    onClick: () => void,
    options: {
      icon?: React.ComponentType<{ className?: string }>;
      active?: boolean;
      pressed?: boolean;
    } = {},
  ) => (
    <button
      key={key}
      type="button"
      className={cn(BUTTON, options.active && LATCHED)}
      aria-label={title}
      aria-pressed={options.pressed}
      title={title}
      onClick={onClick}
    >
      {options.icon && <options.icon className="size-3.5 shrink-0" />}
      {label != null && <span>{label}</span>}
    </button>
  );

  const runAction = (item: ToolbarItemInfo) => {
    if (item.source.kind === "action") {
      void invokeAction(item.source.contribution.actionId, slotContext);
    }
  };

  /** One item as it sits on the strip. */
  const renderItem = (item: ToolbarItemInfo, labeled: boolean) => {
    const title = t(item.titleKey);
    switch (item.id) {
      case "files":
        return textButton(
          item.id,
          title,
          labeled ? title : null,
          () => onToggleFileBrowser?.(),
          { icon: item.icon, active: fileBrowserOpen },
        );
      case "touchMode": {
        const touch = touchMode === "touchscreen";
        const label = touch
          ? t("remoteDesktop.toolbar.switchToTrackpad")
          : t("remoteDesktop.toolbar.switchToTouch");
        return iconButton(item.id, label, touch ? MousePointer : Touchpad, () =>
          onTouchModeChange?.(touch ? "touchpad" : "touchscreen"),
        );
      }
      case "zoom":
        return (
          <span key={item.id} className="flex items-center">
            {iconButton(
              "out",
              t("remoteDesktop.toolbar.zoomOut"),
              ZoomOut,
              () => displayRef.current?.zoomOut(),
            )}
            <button
              type="button"
              className={cn(BUTTON, "min-w-12 px-1 tabular-nums")}
              aria-label={t("remoteDesktop.toolbar.resetZoom")}
              title={t("remoteDesktop.toolbar.resetZoom")}
              onClick={() => displayRef.current?.resetZoom()}
            >
              {Math.round(zoom * 100)}%
            </button>
            {iconButton("in", t("remoteDesktop.toolbar.zoomIn"), ZoomIn, () =>
              displayRef.current?.zoomIn(),
            )}
            {iconButton(
              "fit",
              t("remoteDesktop.toolbar.fitToScreen"),
              Scan,
              () => displayRef.current?.resetZoom(),
            )}
          </span>
        );
      case "ctrlAltDel":
        return textButton(
          item.id,
          title,
          labeled ? "Ctrl+Alt+Del" : null,
          () => sendCombo(KEYSYM.ctrl, KEYSYM.alt, KEYSYM.delete),
          { icon: item.icon },
        );
      case "lock":
        return textButton(
          item.id,
          t(meta.lockTooltip),
          labeled ? meta.lock : null,
          () => sendCombo(KEYSYM.meta, KEYSYM.l),
          { icon: item.icon },
        );
      case "metaKey":
        return textButton(item.id, t(meta.keyTooltip), meta.short, () =>
          sendCombo(KEYSYM.meta),
        );
      case "modifiers":
        return (
          <span key={item.id} className="flex items-center">
            {MODIFIERS.map((modifier) => {
              const label = modifierLabel(modifier.labelKey);
              const on = latched.has(modifier.key);
              return textButton(
                modifier.id,
                on
                  ? t("remoteDesktop.toolbar.stickyActive", { key: label })
                  : t("remoteDesktop.toolbar.stickyInactive", { key: label }),
                label,
                () => toggleLatch(modifier.key),
                { active: on, pressed: on },
              );
            })}
          </span>
        );
      case "functionKeys":
        return (
          <DropdownMenu key={item.id}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={BUTTON}
                aria-label={title}
                title={title}
              >
                Fn
                <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side={menuSide} align="start">
              {FUNCTION_KEYS.map((fn) => (
                <DropdownMenuItem
                  key={fn.cap}
                  onSelect={() => sendCombo(fn.key)}
                >
                  {fn.cap}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      case "arrows":
        return (
          <span key={item.id} className="flex items-center">
            {ARROW_KEYS.map((arrow) =>
              iconButton(
                arrow.dir,
                t(arrow.titleKey),
                ARROW_ICONS[arrow.dir],
                () => sendCombo(arrow.key),
              ),
            )}
          </span>
        );
      default: {
        const nav = NAV_KEYS.find((key) => key.id === item.id);
        if (nav) {
          return textButton(item.id, title, nav.cap, () =>
            sendCombo(...nav.keys),
          );
        }
        return textButton(
          item.id,
          title,
          labeled || !item.icon ? title : null,
          () => runAction(item),
          { icon: item.icon },
        );
      }
    }
  };

  /** The same item as entries of the overflow menu. */
  const menuEntries = (item: ToolbarItemInfo): MenuEntry[] => {
    const title = t(item.titleKey);
    switch (item.id) {
      case "files":
        return [
          {
            key: item.id,
            label: title,
            icon: item.icon,
            checked: fileBrowserOpen,
            run: () => onToggleFileBrowser?.(),
          },
        ];
      case "touchMode": {
        const touch = touchMode === "touchscreen";
        return [
          {
            key: item.id,
            label: touch
              ? t("remoteDesktop.toolbar.switchToTrackpad")
              : t("remoteDesktop.toolbar.switchToTouch"),
            icon: touch ? MousePointer : Touchpad,
            run: () => onTouchModeChange?.(touch ? "touchpad" : "touchscreen"),
          },
        ];
      }
      case "zoom":
        return [
          {
            key: "zoomIn",
            label: t("remoteDesktop.toolbar.zoomIn"),
            icon: ZoomIn,
            run: () => displayRef.current?.zoomIn(),
          },
          {
            key: "zoomOut",
            label: t("remoteDesktop.toolbar.zoomOut"),
            icon: ZoomOut,
            run: () => displayRef.current?.zoomOut(),
          },
          {
            key: "zoomReset",
            label: `${t("remoteDesktop.toolbar.resetZoom")} | ${Math.round(zoom * 100)}%`,
            icon: Scan,
            run: () => displayRef.current?.resetZoom(),
          },
        ];
      case "ctrlAltDel":
        return [
          {
            key: item.id,
            label: title,
            icon: item.icon,
            run: () => sendCombo(KEYSYM.ctrl, KEYSYM.alt, KEYSYM.delete),
          },
        ];
      case "lock":
        return [
          {
            key: item.id,
            label: t(meta.lockTooltip),
            icon: item.icon,
            run: () => sendCombo(KEYSYM.meta, KEYSYM.l),
          },
        ];
      case "metaKey":
        return [
          {
            key: item.id,
            label: t(meta.keyTooltip),
            run: () => sendCombo(KEYSYM.meta),
          },
        ];
      case "modifiers":
        return MODIFIERS.map((modifier) => ({
          key: modifier.id,
          label: modifierLabel(modifier.labelKey),
          checked: latched.has(modifier.key),
          run: () => toggleLatch(modifier.key),
        }));
      case "functionKeys":
        return [
          {
            key: item.id,
            label: title,
            children: FUNCTION_KEYS.map((fn) => ({
              key: fn.cap,
              label: fn.cap,
              run: () => sendCombo(fn.key),
            })),
          },
        ];
      case "arrows":
        return ARROW_KEYS.map((arrow) => ({
          key: arrow.dir,
          label: t(arrow.titleKey),
          icon: ARROW_ICONS[arrow.dir],
          run: () => sendCombo(arrow.key),
        }));
      default: {
        const nav = NAV_KEYS.find((key) => key.id === item.id);
        if (nav) {
          return [
            { key: item.id, label: title, run: () => sendCombo(...nav.keys) },
          ];
        }
        return [
          {
            key: item.id,
            label: title,
            icon: item.icon,
            run: () => runAction(item),
          },
        ];
      }
    }
  };

  const renderEntry = (entry: MenuEntry): React.ReactNode => {
    if (entry.children) {
      return (
        <DropdownMenuSub key={entry.key}>
          <DropdownMenuSubTrigger>{entry.label}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {entry.children.map(renderEntry)}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    }
    if (entry.checked !== undefined) {
      return (
        <DropdownMenuCheckboxItem
          key={entry.key}
          checked={entry.checked}
          onSelect={(event) => {
            event.preventDefault();
            entry.run?.();
          }}
        >
          {entry.label}
        </DropdownMenuCheckboxItem>
      );
    }
    return (
      <DropdownMenuItem key={entry.key} onSelect={() => entry.run?.()}>
        {entry.icon && <entry.icon className="size-3.5" />}
        {entry.label}
      </DropdownMenuItem>
    );
  };

  const fit = layout.fit ?? items.length;
  const shown = items.slice(0, fit);
  const overflow = items.slice(fit);

  const measureRow = (labeled: boolean, ref: React.Ref<HTMLDivElement>) => (
    <div
      ref={ref}
      data-toolbar-measure={labeled ? "labeled" : "icons"}
      aria-hidden="true"
      // Measured only: never clickable, never in the tab order.
      inert
      className="pointer-events-none invisible absolute left-0 top-0 flex whitespace-nowrap"
    >
      {items.map((item) => (
        <span key={item.id} className="flex items-center">
          {renderItem(item, labeled)}
        </span>
      ))}
      <span className={ICON_BUTTON}>
        <MoreHorizontal className="size-3.5" />
      </span>
    </div>
  );

  return (
    <div
      ref={rootRef}
      data-remote-toolbar
      data-position={settings.position}
      role="toolbar"
      aria-label={t("remoteDesktop.toolbar.label")}
      // Clicks must not move focus off the session's keyboard.
      onMouseDown={(event) => event.preventDefault()}
      className={cn(
        "relative z-20 flex h-8 w-full shrink-0 items-center border-border bg-sidebar px-1",
        settings.position === "top" ? "border-b" : "border-t",
      )}
    >
      <div
        ref={rowRef}
        data-toolbar-buttons
        className="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
      >
        {measureRow(true, labeledRef)}
        {measureRow(false, iconRef)}
        {shown.map((item) => (
          <React.Fragment key={item.id}>
            {renderItem(item, layout.labeled)}
          </React.Fragment>
        ))}
        {overflow.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={ICON_BUTTON}
                aria-label={t("remoteDesktop.toolbar.more")}
                title={t("remoteDesktop.toolbar.more")}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side={menuSide} align="end">
              {overflow.map((item, index) => (
                <React.Fragment key={item.id}>
                  {index > 0 && <DropdownMenuSeparator />}
                  {menuEntries(item).map(renderEntry)}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
};
