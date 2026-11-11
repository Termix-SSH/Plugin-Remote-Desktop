import type React from "react";
import {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
  useCallback,
} from "react";
import Guacamole from "guacamole-common-js";
import { bindAudioUnlock } from "./guacamole-audio";
import { Upload } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { toast } from "sonner";
import { createRemoteClipboard } from "./remote-clipboard";
import { getGuacamoleToken, remoteByDefault } from "./guacamole-api";
import { watchTunnel, type TunnelWatch } from "./tunnel-watch";
import {
  buildGuacamoleWebSocketBaseUrl,
  localBackendPort,
} from "./guacamole-websocket-url.ts";
import {
  buildOriginWsUrl,
  getBasePath,
  pluginWsUrl,
  isElectron,
  resolveConnectionOrigin,
  type ConnectionOrigin,
  type ConnectionStage,
} from "@termix-ssh/plugin-sdk/ui";
import { errorMessage } from "./host-remote";
import {
  RUSTDESK_DISPLAYS_ARGUMENT,
  readRustdeskDisplays,
  rustdeskVideoPlayer,
  type RustdeskDisplays,
} from "./rustdesk-video";
import { guacStateToStage } from "./guacamole-state.ts";
import {
  createPasteCatcher,
  isPasteShortcut,
  pasteModifierFor,
  pasteTextToRemote,
} from "./guacamole-clipboard.ts";
import {
  getGuacamoleDisplaySize,
  isSmallChange,
} from "./guacamole-display-size.ts";
import {
  bindPointerInput,
  createTouchGestureGate,
  type TouchGestureGate,
} from "./guacamole-pointer.ts";
import {
  getFileDropDisposition,
  hasDraggedFiles,
} from "./guacamole-file-drop.ts";
import {
  uploadFileToClient,
  type GuacamoleFileStreamClient,
} from "./guacamole-filesystem.ts";
import { clampGuacamoleZoom, stepGuacamoleZoom } from "./guacamole-zoom.ts";
import {
  classifyTwoFingerMove,
  nextPinchZoom,
  scrollAfterPan,
  displayOffsetInContainer,
  scrollAfterZoom,
  touchDistance,
  touchMidpoint,
} from "./guacamole-touch-gestures.ts";
import {
  createPressedKeyTracker,
  isComposingKeyboardEvent,
  keysymsForBeforeInput,
  specialKeysymFromKeyboardEvent,
  textToKeysyms,
} from "./guacamole-soft-keyboard.ts";
import { createRdpReadyGate } from "./guacamole-ready.ts";
import {
  remoteKeysym,
  isToggleKey,
  watchRightAlt,
} from "./guacamole-meta-key.ts";

type GuacamoleConnectionType = "rdp" | "vnc" | "ard" | "telnet" | "rustdesk";

interface GuacamoleConnectionConfig {
  token?: string;
  protocol?: GuacamoleConnectionType;
  type?: GuacamoleConnectionType;
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  domain?: string;
  width?: number;
  rdpAutoResize?: boolean;
  height?: number;
  dpi?: number;
  /**
   * Which backend serves this session. Supplied by the owning app so the
   * websocket dials the same backend that minted the token; omitted by
   * shared/collab views, which follow the default for the connection type.
   */
  connectionOrigin?: ConnectionOrigin | null;
  [key: string]: unknown;
}

export interface GuacamoleDisplayHandle {
  disconnect: () => void;
  isConnected: () => boolean;
  sendKey: (keysym: number, pressed: boolean) => void;
  sendMouse: (x: number, y: number, buttonMask: number) => void;
  setClipboard: (data: string) => void;
  getFilesystem: () => Guacamole.Object | null;
  uploadFile: (file: File) => Promise<void>;
  zoomIn: () => number;
  zoomOut: () => number;
  resetZoom: () => number;
  /** Focuses the hidden textarea so a phone can show its software keyboard. */
  openSoftKeyboard: () => void;
  closeSoftKeyboard: () => void;
  isSoftKeyboardOpen: () => boolean;
  /** Shows another RustDesk monitor. */
  selectDisplay: (index: number) => void;
}

export type GuacamoleTouchMode = "touchscreen" | "touchpad";

interface GuacamoleDisplayProps {
  connectionConfig: GuacamoleConnectionConfig;
  isVisible: boolean;
  touchMode?: GuacamoleTouchMode | null;
  allowUpload?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: string) => void;
  onFilesystem?: (filesystem: Guacamole.Object | null) => void;
  onDropFiles?: (files: File[]) => void;
  onDropUnavailable?: () => void;
  onStageChange?: (stage: ConnectionStage) => void;
  onZoomChange?: (zoom: number) => void;
  /** The tunnel died after the session was up, or stayed silent after the page came back. */
  onLost?: () => void;
  /** The RustDesk monitors, when the remote has more than one. */
  onDisplays?: (displays: RustdeskDisplays) => void;
}

export const GuacamoleDisplay = forwardRef<
  GuacamoleDisplayHandle,
  GuacamoleDisplayProps
>(function GuacamoleDisplay(
  {
    connectionConfig,
    isVisible,
    touchMode,
    allowUpload = false,
    onConnect,
    onDisconnect,
    onError,
    onFilesystem,
    onDisplays,
    onDropFiles,
    onDropUnavailable,
    onStageChange,
    onZoomChange,
    onLost,
  },
  ref,
) {
  const { t } = useTranslation();
  // Fixed dimensions or an RDP resize opt-out keep the initial resolution.
  const hasConfiguredSize =
    connectionConfig.width != null && connectionConfig.height != null;
  const followsContainer =
    !hasConfiguredSize &&
    !(
      (connectionConfig.protocol ?? connectionConfig.type) === "rdp" &&
      connectionConfig.rdpAutoResize === false
    );
  const containerRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLDivElement>(null);
  const remoteClipboardRef = useRef<ReturnType<
    typeof createRemoteClipboard
  > | null>(null);
  useEffect(() => {
    const clipboard = createRemoteClipboard(() =>
      toast.info(t("remoteDesktop.clipboardWaiting")),
    );
    remoteClipboardRef.current = clipboard;
    return () => {
      clipboard.dispose();
      remoteClipboardRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const displayElementRef = useRef<HTMLElement | null>(null);
  const clientRef = useRef<Guacamole.Client | null>(null);
  const filesystemRef = useRef<Guacamole.Object | null>(null);
  // Held in a ref so tearing down the client can report the loss without
  // rebuilding the connect callback whenever the parent re-renders.
  const onFilesystemRef = useRef(onFilesystem);
  onFilesystemRef.current = onFilesystem;
  const onDisplaysRef = useRef(onDisplays);
  onDisplaysRef.current = onDisplays;
  const onStageChangeRef = useRef(onStageChange);
  onStageChangeRef.current = onStageChange;
  const onLostRef = useRef(onLost);
  onLostRef.current = onLost;
  const tunnelWatchRef = useRef<TunnelWatch | null>(null);
  // Set once this client reached CONNECTED, so a close before that stays an error.
  const wasConnectedRef = useRef(false);
  const keyboardRef = useRef<Guacamole.Keyboard | null>(null);
  const unbindAudioRef = useRef<(() => void) | null>(null);
  const unbindPointerRef = useRef<(() => void) | null>(null);
  const unwatchAltRef = useRef<(() => void) | null>(null);
  const scaleRef = useRef<number>(1);
  const fitScaleRef = useRef<number>(1);
  const zoomRef = useRef<number>(1);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSentSizeRef = useRef<{ width: number; height: number } | null>(
    null,
  );
  const hasKeyboardFocusRef = useRef(false);
  const softKeyboardRef = useRef<HTMLTextAreaElement>(null);
  const inputHandledRef = useRef(false);
  const composingRef = useRef(false);
  // Special keys typed into the soft-keyboard textarea bypass
  // Guacamole.Keyboard, so track them to release on blur/hide/disconnect.
  const [softKeys] = useState(() =>
    createPressedKeyTracker((pressed, keysym) => {
      clientRef.current?.sendKeyEvent(pressed, keysym);
    }),
  );
  // Per connection: drops touch-emulator clicks around two-finger gestures.
  const touchGateRef = useRef<TouchGestureGate | null>(null);

  const markSoftKeyboardHandled = () => {
    inputHandledRef.current = true;
    window.setTimeout(() => {
      inputHandledRef.current = false;
    }, 0);
  };

  const sendSoftKeysyms = (keysyms: number[]) => {
    const client = clientRef.current;
    if (!client) return;
    for (const keysym of keysyms) {
      client.sendKeyEvent(1, keysym);
      client.sendKeyEvent(0, keysym);
    }
  };

  const sessionProtocolRef = useRef(
    connectionConfig.protocol ?? connectionConfig.type,
  );
  sessionProtocolRef.current =
    connectionConfig.protocol ?? connectionConfig.type;
  const windowFocusedRef = useRef(
    typeof document === "undefined" ? true : document.hasFocus(),
  );
  const hasInitiatedRef = useRef(false);
  const isMountedRef = useRef(false);
  const isConnectingRef = useRef(false);
  // Bumped on unmount, so a connect still awaiting from an earlier mount
  // (React remounts in dev) stops instead of opening a second client.
  const connectGenerationRef = useRef(0);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  // RDP's guacd backend (FreeRDP) can report the Guacamole-level CONNECTED
  // state from a single early sync before the actual RDP handshake with the
  // remote host has finished negotiating - a handshake that can then still
  // fail up to ~30s later. Waiting for a couple of real frame syncs before
  // announcing the connection avoids a black screen with no connecting UI
  // during that window; VNC/telnet fail before ever reaching CONNECTED, so
  // they are unaffected.
  const readyGateRef = useRef<ReturnType<typeof createRdpReadyGate> | null>(
    null,
  );

  const disconnectClient = useCallback(() => {
    // Release while clientRef still points at the client that got the presses.
    softKeys.releaseAll();
    unbindPointerRef.current?.();
    unbindPointerRef.current = null;
    touchGateRef.current = null;
    unbindAudioRef.current?.();
    unbindAudioRef.current = null;
    unwatchAltRef.current?.();
    unwatchAltRef.current = null;
    const client = clientRef.current;
    clientRef.current = null;
    tunnelWatchRef.current?.stop();
    tunnelWatchRef.current = null;
    readyGateRef.current?.cancel();
    readyGateRef.current = null;
    isConnectingRef.current = false;
    if (filesystemRef.current) {
      filesystemRef.current = null;
      onFilesystemRef.current?.(null);
    }
    if (!client) return;

    try {
      client.disconnect();
    } catch (error) {
      console.warn("Failed to disconnect Guacamole client", error);
    }
  }, [softKeys]);

  const applyZoom = useCallback(
    (nextZoom: number): number => {
      const zoom = clampGuacamoleZoom(nextZoom);
      zoomRef.current = zoom;
      const display = clientRef.current?.getDisplay();
      if (display && displayRef.current) {
        const scale = fitScaleRef.current * zoom;
        scaleRef.current = scale;
        display.scale(scale);
        displayRef.current.style.width = `${Math.floor(display.getWidth() * scale)}px`;
        displayRef.current.style.height = `${Math.floor(display.getHeight() * scale)}px`;
      }
      onZoomChange?.(zoom);
      return zoom;
    },
    [onZoomChange],
  );

  useImperativeHandle(ref, () => ({
    selectDisplay: (index: number) => {
      const client = clientRef.current;
      if (!client) return;
      const writer = new Guacamole.StringWriter(
        client.createArgumentValueStream(
          "text/plain",
          RUSTDESK_DISPLAYS_ARGUMENT,
        ),
      );
      writer.sendText(String(index));
      writer.sendEnd();
    },
    disconnect: disconnectClient,
    isConnected: () => isReady && !hasError,
    sendKey: (keysym: number, pressed: boolean) => {
      if (clientRef.current) {
        clientRef.current.sendKeyEvent(pressed ? 1 : 0, keysym);
      }
    },
    sendMouse: (x: number, y: number, buttonMask: number) => {
      if (clientRef.current) {
        clientRef.current.sendMouseState(
          new Guacamole.Mouse.State({
            x,
            y,
            left: !!(buttonMask & 1),
            middle: !!(buttonMask & 2),
            right: !!(buttonMask & 4),
          }),
        );
      }
    },
    setClipboard: (data: string) => {
      if (clientRef.current) {
        const stream = clientRef.current.createClipboardStream("text/plain");
        const writer = new Guacamole.StringWriter(stream);
        writer.sendText(data);
        writer.sendEnd();
      }
    },
    getFilesystem: () => filesystemRef.current,
    uploadFile: (file: File) => {
      const client = clientRef.current;
      if (!client) return Promise.reject(new Error("RDP session is not ready"));
      return uploadFileToClient(
        client as unknown as GuacamoleFileStreamClient,
        file,
      );
    },
    zoomIn: () => applyZoom(stepGuacamoleZoom(zoomRef.current, 1)),
    zoomOut: () => applyZoom(stepGuacamoleZoom(zoomRef.current, -1)),
    resetZoom: () => applyZoom(1),
    openSoftKeyboard: () => {
      const input = softKeyboardRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
    },
    closeSoftKeyboard: () => {
      softKeyboardRef.current?.blur();
    },
    isSoftKeyboardOpen: () =>
      softKeyboardRef.current != null &&
      document.activeElement === softKeyboardRef.current,
  }));

  const getWebSocketConnection = useCallback(
    async (
      containerWidth: number,
      containerHeight: number,
    ): Promise<{ url: string; query: string } | null> => {
      try {
        let token: string;
        const connectionProtocol =
          connectionConfig.protocol ?? connectionConfig.type;

        // Resolved before the token is minted, not just before the socket is
        // opened: the token has to come from whichever backend will serve the
        // session, so both steps have to agree on the origin.
        const origin = await resolveConnectionOrigin(
          { connectionOrigin: connectionConfig.connectionOrigin },
          { defaultRemote: await remoteByDefault() },
        );

        if (connectionConfig.token) {
          token = connectionConfig.token;
        } else {
          const data = await getGuacamoleToken(
            {
              protocol: connectionProtocol ?? "rdp",
              hostname: String(connectionConfig.hostname ?? ""),
              port: connectionConfig.port,
              username: connectionConfig.username,
              password: connectionConfig.password,
              domain: connectionConfig.domain,
              security:
                typeof connectionConfig.security === "string"
                  ? connectionConfig.security
                  : undefined,
              ignoreCert:
                typeof connectionConfig.ignoreCert === "boolean"
                  ? connectionConfig.ignoreCert
                  : undefined,
              guacamoleConfig: connectionConfig.guacamoleConfig as Parameters<
                typeof getGuacamoleToken
              >[0]["guacamoleConfig"],
            },
            origin,
          );
          token = data.token;
        }

        const displaySize = getGuacamoleDisplaySize(
          connectionConfig.width ?? containerWidth ?? 1280,
          connectionConfig.height ?? containerHeight ?? 720,
          connectionProtocol,
          window.devicePixelRatio,
          connectionConfig.dpi,
          hasConfiguredSize,
        );

        let wsBase: string | null;
        if (isElectron()) {
          // includeJwt stays off: a display authenticates with the encrypted
          // connection token in the query, not a session.
          const target = await buildOriginWsUrl({
            origin,
            localPort: localBackendPort(),
            localPath: "/plugin-ws/remote-desktop/display",
            remotePath: "/plugin-ws/remote-desktop/display",
            includeJwt: false,
          });
          if (!target) {
            onError?.(t("errors.remoteServerRequired"));
            return null;
          }
          wsBase = target.url;
        } else {
          // Core knows the right address, including Vite's dev proxy.
          const target = await pluginWsUrl("remote-desktop", "/display");
          wsBase =
            target?.url ??
            buildGuacamoleWebSocketBaseUrl({
              isElectronApp: false,
              isEmbeddedApp: false,
              basePath: getBasePath(),
              location: window.location,
            });
        }

        const params = new URLSearchParams({
          token,
          width: String(displaySize.width),
          height: String(displaySize.height),
        });
        if (displaySize.dpi) params.set("dpi", String(displaySize.dpi));
        return { url: wsBase, query: params.toString() };
      } catch (error) {
        const message = errorMessage(error);
        onError?.(message);
        return null;
      }
    },
    [connectionConfig, onError, t],
  );

  const refreshKeyboardHandlers = useCallback(() => {
    const keyboard = keyboardRef.current;
    const client = clientRef.current;
    const displayElement = displayElementRef.current;

    if (!keyboard) return;

    const documentVisible =
      typeof document === "undefined" || document.visibilityState === "visible";
    const displayIsFocused =
      !!displayElement &&
      typeof document !== "undefined" &&
      document.activeElement === displayElement;
    const shouldCaptureInput =
      !!client &&
      !!displayElement &&
      isVisible &&
      documentVisible &&
      windowFocusedRef.current &&
      (hasKeyboardFocusRef.current || displayIsFocused);

    if (!shouldCaptureInput) {
      keyboard.reset();
      keyboard.onkeydown = null;
      keyboard.onkeyup = null;
      return;
    }

    keyboard.onkeydown = (keysym: number) => {
      if (!clientRef.current) return;
      if (!isVisible || !windowFocusedRef.current) return;

      const activeDisplay = displayElementRef.current;
      const stillFocused =
        !!activeDisplay &&
        typeof document !== "undefined" &&
        document.activeElement === activeDisplay;

      if (!hasKeyboardFocusRef.current && !stillFocused) return;
      clientRef.current.sendKeyEvent(
        1,
        remoteKeysym(sessionProtocolRef.current, keysym, true),
      );
      if (isToggleKey(keysym)) clientRef.current.sendKeyEvent(0, keysym);
    };

    keyboard.onkeyup = (keysym: number) => {
      // Focus loss must still release keys already sent to the remote host.
      clientRef.current?.sendKeyEvent(
        0,
        remoteKeysym(sessionProtocolRef.current, keysym, false),
      );
    };
  }, [isVisible]);

  const rescaleDisplay = useCallback(
    (immediate: boolean = false) => {
      if (!clientRef.current || !containerRef.current) return;

      const performRescale = () => {
        if (!clientRef.current || !containerRef.current) return;

        const display = clientRef.current.getDisplay();
        const cWidth = containerRef.current.clientWidth;
        const cHeight = containerRef.current.clientHeight;
        const displayWidth = display.getWidth();
        const displayHeight = display.getHeight();

        if (
          displayWidth > 0 &&
          displayHeight > 0 &&
          cWidth > 0 &&
          cHeight > 0
        ) {
          fitScaleRef.current = Math.min(
            cWidth / displayWidth,
            cHeight / displayHeight,
          );
          applyZoom(zoomRef.current);
        }
      };

      if (immediate) {
        performRescale();
      } else {
        if (resizeTimeoutRef.current) {
          clearTimeout(resizeTimeoutRef.current);
        }
        resizeTimeoutRef.current = setTimeout(performRescale, 200);
      }
    },
    [applyZoom],
  );

  const connect = useCallback(async () => {
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;
    const generation = ++connectGenerationRef.current;
    const stale = () =>
      !isMountedRef.current || generation !== connectGenerationRef.current;
    setIsReady(false);
    setHasError(false);
    readyGateRef.current?.cancel();
    readyGateRef.current = null;

    // Let layout settle before measuring without depending on animation frames,
    // which may be throttled while Electron windows or tabs are inactive.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (stale()) {
      if (generation === connectGenerationRef.current) {
        isConnectingRef.current = false;
      }
      return;
    }

    // The tab's DOM node can still be display:none (and report 0x0) when this
    // tab is restored in the background. Measuring then would force the
    // window-size fallback, which ignores the tab bar and makes the remote
    // resolution too tall (the bottom gets cut off). Poll briefly for a real
    // size before connecting so we capture the actual visible viewport.
    const measureContainer = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      return { width: rect?.width || 0, height: rect?.height || 0 };
    };

    let { width: containerWidth, height: containerHeight } = measureContainer();
    for (
      let attempt = 0;
      (containerWidth < 100 || containerHeight < 100) && attempt < 40;
      attempt++
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      if (stale()) {
        if (generation === connectGenerationRef.current) {
          isConnectingRef.current = false;
        }
        return;
      }
      ({ width: containerWidth, height: containerHeight } = measureContainer());
    }

    if (containerWidth < 100 || containerHeight < 100) {
      containerWidth = window.innerWidth || 1280;
      containerHeight = window.innerHeight || 720;
    }

    const wsConnection = await getWebSocketConnection(
      containerWidth,
      containerHeight,
    );
    if (stale()) {
      if (generation === connectGenerationRef.current) {
        isConnectingRef.current = false;
      }
      return;
    }
    if (!wsConnection) {
      isConnectingRef.current = false;
      return;
    }

    const tunnel = new Guacamole.WebSocketTunnel(wsConnection.url);
    const client = new Guacamole.Client(tunnel);
    // Keys held on a previous client must be released there, not here.
    softKeys.releaseAll();
    clientRef.current = client;
    wasConnectedRef.current = false;
    tunnelWatchRef.current?.stop();
    tunnelWatchRef.current = watchTunnel(tunnel, () => {
      if (!isMountedRef.current || clientRef.current !== client) return;
      if (!wasConnectedRef.current) return;
      setIsReady(false);
      onLostRef.current?.();
    });

    const display = client.getDisplay();
    const displayElement = display.getElement();
    displayElementRef.current = displayElement;

    const pasteCatcher = createPasteCatcher(displayElement, (text) => {
      if (clientRef.current === client) {
        pasteTextToRemote(
          client,
          text,
          pasteModifierFor(sessionProtocolRef.current),
          keyboardRef.current?.pressed,
        );
      }
    });

    if (displayRef.current) {
      displayRef.current.innerHTML = "";
      displayRef.current.appendChild(displayElement);
      displayRef.current.appendChild(pasteCatcher.element);
    }

    unbindAudioRef.current?.();
    unbindAudioRef.current = bindAudioUnlock(displayElement, () =>
      Guacamole.AudioContextFactory.getAudioContext(),
    );

    displayElement.setAttribute("tabindex", "0");
    displayElement.style.outline = "none";

    // Reading navigator.clipboard outside a user gesture is denied by Safari
    // and commonly denied by Chromium. The paste event carries the text under
    // the browser's normal permission model, so use it on every browser and
    // replace the original shortcut with an ordered clipboard update + Ctrl+V.
    displayElement.addEventListener(
      "keydown",
      (event) => {
        if (isPasteShortcut(event)) {
          event.stopImmediatePropagation();
          pasteCatcher.capture();
        }
      },
      true,
    );
    displayElement.addEventListener(
      "paste",
      (event) => {
        if (clientRef.current !== client) return;
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        pasteTextToRemote(
          client,
          text,
          pasteModifierFor(sessionProtocolRef.current),
          keyboardRef.current?.pressed,
        );
      },
      true,
    );

    display.onresize = () => {
      if (!isMountedRef.current || clientRef.current !== client) return;
      rescaleDisplay(true);
      setIsReady(true);
    };

    const protocol = connectionConfig.protocol ?? connectionConfig.type;
    if (protocol === "telnet" && isMountedRef.current) {
      setIsReady(true);
    }

    const sendMouseState = (state: Guacamole.Mouse.State) => {
      displayElement.focus({ preventScroll: true });
      const scale = scaleRef.current;
      const adjustedState = new Guacamole.Mouse.State(
        Math.round(state.x / scale),
        Math.round(state.y / scale),
        state.left,
        state.middle,
        state.right,
        state.up,
        state.down,
      ) as Guacamole.Mouse.State;
      client.sendMouseState(adjustedState);
    };

    unbindPointerRef.current?.();
    const touchGate = createTouchGestureGate();
    touchGateRef.current = touchGate;
    unbindPointerRef.current = bindPointerInput(
      displayElement,
      touchMode,
      sendMouseState,
      touchGate,
    );

    unwatchAltRef.current?.();
    unwatchAltRef.current = watchRightAlt(displayElement, (keysym) => {
      keyboardRef.current?.onkeydown?.(keysym);
    });
    const keyboard = new Guacamole.Keyboard(displayElement);
    keyboardRef.current = keyboard;

    const handleDisplayFocus = () => {
      hasKeyboardFocusRef.current = true;
      refreshKeyboardHandlers();
    };

    const handleDisplayBlur = () => {
      hasKeyboardFocusRef.current = false;
      refreshKeyboardHandlers();
    };

    displayElement.addEventListener("focus", handleDisplayFocus);
    displayElement.addEventListener("blur", handleDisplayBlur);
    displayElement.addEventListener("mousedown", handleDisplayFocus);
    displayElement.addEventListener("touchstart", handleDisplayFocus, {
      passive: true,
    });
    refreshKeyboardHandlers();

    client.onstatechange = (state: number) => {
      if (!isMountedRef.current || clientRef.current !== client) return;
      onStageChangeRef.current?.(guacStateToStage(state));
      switch (state) {
        case 0:
          break;
        case 1:
          break;
        case 2:
          break;
        case 3:
          isConnectingRef.current = false;
          wasConnectedRef.current = true;
          if (protocol !== "rdp") {
            setIsReady(true);
            onConnect?.();
          }
          // Preserve fixed dimensions and the initial Auto size when resizing is
          // disabled. Local scaling still fits the display into the container.
          if (followsContainer && containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            const size = getGuacamoleDisplaySize(
              rect.width,
              rect.height,
              protocol,
              window.devicePixelRatio,
              connectionConfig.dpi,
            );
            lastSentSizeRef.current = size;
            client.sendSize(size.width, size.height);
          }
          rescaleDisplay(false);
          break;
        case 4:
          break;
        case 5:
          isConnectingRef.current = false;
          setIsReady(false);
          setHasError(true);
          hasKeyboardFocusRef.current = false;
          refreshKeyboardHandlers();
          onError?.(t("remoteDesktop.connectionError"));
          onDisconnect?.();
          break;
      }
    };

    client.onerror = (error: Guacamole.Status) => {
      if (!isMountedRef.current || clientRef.current !== client) return;
      const errorMessage = error.message || t("remoteDesktop.connectionError");
      setIsReady(false);
      setHasError(true);
      isConnectingRef.current = false;
      onError?.(errorMessage);
    };

    if (protocol === "rdp") {
      const gate = createRdpReadyGate(() => {
        if (!isMountedRef.current || clientRef.current !== client) return;
        setIsReady(true);
        onConnect?.();
      });
      readyGateRef.current = gate;
      client.onsync = () => {
        if (!isMountedRef.current || clientRef.current !== client) return;
        gate.sync();
      };
    }

    client.onclipboard = (stream: Guacamole.InputStream, mimetype: string) => {
      if (mimetype === "text/plain") {
        const reader = new Guacamole.StringReader(stream);
        let data = "";
        reader.ontext = (text: string) => {
          data += text;
        };
        reader.onend = () => {
          remoteClipboardRef.current?.copy(data);
        };
      }
    };

    client.onvideo = (stream, layer, mimetype) =>
      rustdeskVideoPlayer(stream, layer, mimetype, (reason) => {
        if (!isMountedRef.current || clientRef.current !== client) return;
        if (reason === "unsupported") {
          onError?.(t("remoteDesktop.rustdesk.videoUnsupported"));
        }
      });

    client.onargv = (stream, _mimetype, name) => {
      if (name !== RUSTDESK_DISPLAYS_ARGUMENT) {
        stream.sendAck("Unsupported", 0x0100);
        return;
      }
      readRustdeskDisplays(stream, Guacamole.StringReader, (displays) => {
        if (!isMountedRef.current || clientRef.current !== client) return;
        onDisplaysRef.current?.(displays);
      });
    };

    client.onaudio = (stream: Guacamole.InputStream, mimetype: string) => {
      return Guacamole.AudioPlayer.getInstance(stream, mimetype);
    };

    // Only fires when the connection enables drive redirection; guacd exposes
    // the redirected drive as a single filesystem object.
    client.onfilesystem = (filesystem: Guacamole.Object) => {
      if (!isMountedRef.current || clientRef.current !== client) return;
      filesystemRef.current = filesystem;
      onFilesystemRef.current?.(filesystem);

      filesystem.onundefine = () => {
        if (filesystemRef.current !== filesystem) return;
        filesystemRef.current = null;
        onFilesystemRef.current?.(null);
      };
    };

    client.onfile = (
      stream: Guacamole.InputStream,
      mimetype: string,
      filename: string,
    ) => {
      const reader = new Guacamole.BlobReader(stream, mimetype);
      reader.onend = () => {
        const blob = reader.getBlob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      };
      stream.sendAck("OK", Guacamole.Status.Code.SUCCESS);
    };

    try {
      client.connect(wsConnection.query);
    } catch (error) {
      isConnectingRef.current = false;
      if (!isMountedRef.current) return;
      setIsReady(false);
      setHasError(true);
      onError?.(errorMessage(error, t("remoteDesktop.connectionError")));
    }
  }, [
    getWebSocketConnection,
    onConnect,
    onDisconnect,
    onError,
    refreshKeyboardHandlers,
    rescaleDisplay,
    connectionConfig.protocol,
    connectionConfig.type,
    connectionConfig.dpi,
    followsContainer,
    touchMode,
    softKeys,
    t,
  ]);

  useEffect(() => {
    isMountedRef.current = true;

    if (isVisible && !hasInitiatedRef.current) {
      hasInitiatedRef.current = true;
      connect();
    }
  }, [isVisible, connect]);

  useEffect(() => {
    if (!isVisible) {
      hasKeyboardFocusRef.current = false;
    }

    refreshKeyboardHandlers();
  }, [isVisible, refreshKeyboardHandlers]);

  useEffect(() => {
    const handleWindowFocus = () => {
      windowFocusedRef.current = true;
      refreshKeyboardHandlers();
    };

    const handleWindowBlur = () => {
      windowFocusedRef.current = false;
      hasKeyboardFocusRef.current = false;
      refreshKeyboardHandlers();
    };

    const handleVisibilityChange = () => {
      windowFocusedRef.current =
        document.visibilityState === "visible" && document.hasFocus();
      if (document.visibilityState !== "visible") {
        hasKeyboardFocusRef.current = false;
      } else if (wasConnectedRef.current) {
        // The socket may have died while the tab was hidden or the screen locked.
        tunnelWatchRef.current?.checkAlive();
      }
      refreshKeyboardHandlers();
    };

    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshKeyboardHandlers]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      hasInitiatedRef.current = false;
      isConnectingRef.current = false;
      connectGenerationRef.current++;
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      disconnectClient();
      displayElementRef.current = null;
    };
  }, [disconnectClient]);

  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(() => {
        if (clientRef.current && containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            // A size sent while guacd is still dialing a VNC server crashes
            // its VNC client. The connected handler sends the first size.
            if (followsContainer && !isConnectingRef.current) {
              const size = getGuacamoleDisplaySize(
                rect.width,
                rect.height,
                connectionConfig.protocol ?? connectionConfig.type,
                window.devicePixelRatio,
                connectionConfig.dpi,
              );
              // A scrollbar coming and going changes the size by a few
              // pixels; resending it makes RDP resize again, in a loop.
              if (!isSmallChange(lastSentSizeRef.current, size)) {
                lastSentSizeRef.current = size;
                try {
                  clientRef.current.sendSize(size.width, size.height);
                } catch {
                  // The tunnel closed; the next connect sends the size.
                }
              }
            }
            rescaleDisplay(true);
          }
        }
      }, 150);
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [
    connectionConfig.dpi,
    connectionConfig.protocol,
    connectionConfig.type,
    followsContainer,
    rescaleDisplay,
  ]);

  useEffect(() => {
    const input = softKeyboardRef.current;
    if (!input) return;
    const onBeforeInput = (event: InputEvent) => {
      let paste = "";
      try {
        paste = event.dataTransfer?.getData("text/plain") ?? "";
      } catch {
        paste = "";
      }
      const keysyms = keysymsForBeforeInput({
        inputType: event.inputType,
        data: event.data ?? paste,
        isComposing: event.isComposing || composingRef.current,
      });
      if (keysyms == null) return;
      event.preventDefault();
      input.value = "";
      markSoftKeyboardHandled();
      sendSoftKeysyms(keysyms);
    };
    input.addEventListener("beforeinput", onBeforeInput);
    return () => input.removeEventListener("beforeinput", onBeforeInput);
  }, []);

  // A held soft-keyboard key never gets its keyup once focus leaves, so
  // release everything whenever the textarea or the page loses focus.
  useEffect(() => {
    const input = softKeyboardRef.current;
    const releaseAll = () => softKeys.releaseAll();
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") releaseAll();
    };
    input?.addEventListener("blur", releaseAll);
    window.addEventListener("blur", releaseAll);
    window.addEventListener("pagehide", releaseAll);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      input?.removeEventListener("blur", releaseAll);
      window.removeEventListener("blur", releaseAll);
      window.removeEventListener("pagehide", releaseAll);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseAll();
    };
  }, [softKeys]);

  useEffect(() => {
    const container = containerRef.current;
    const protocol = connectionConfig.protocol ?? connectionConfig.type;
    if (!container || !isReady || (protocol !== "vnc" && protocol !== "ard"))
      return;

    type Gesture = {
      startDistance: number;
      startZoom: number;
      startScale: number;
      startScrollLeft: number;
      startScrollTop: number;
      startMid: { x: number; y: number };
      startOffset: { x: number; y: number };
      lastMid: { x: number; y: number };
      kind: "undecided" | "pinch" | "pan";
    };
    let gesture: Gesture | null = null;
    let claimed = false;

    const pair = (touches: TouchList) => {
      if (touches.length !== 2) return null;
      return {
        a: { x: touches[0].clientX, y: touches[0].clientY },
        b: { x: touches[1].clientX, y: touches[1].clientY },
      };
    };
    const relative = (point: { x: number; y: number }, rect: DOMRect) => ({
      x: point.x - rect.left,
      y: point.y - rect.top,
    });
    // The displayRef wrapper is min-w/h-full, so it sits at the scroll origin.
    // The Guacamole element inside it is flex-centered while smaller than the
    // container; pinch math has to use that offset, measured after applyZoom
    // because a resize can change whether the display is still centered.
    const measureOffset = () => {
      const display = displayElementRef.current;
      if (!display) return { x: 0, y: 0 };
      return displayOffsetInContainer({
        containerRect: container.getBoundingClientRect(),
        displayRect: display.getBoundingClientRect(),
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
      });
    };

    const beginGesture = (touches: {
      a: { x: number; y: number };
      b: { x: number; y: number };
    }): Gesture => {
      const mid = touchMidpoint(touches.a, touches.b);
      const rect = container.getBoundingClientRect();
      return {
        startDistance: touchDistance(touches.a, touches.b),
        startZoom: zoomRef.current,
        startScale: scaleRef.current,
        startScrollLeft: container.scrollLeft,
        startScrollTop: container.scrollTop,
        startMid: relative(mid, rect),
        startOffset: measureOffset(),
        lastMid: mid,
        kind: "undecided",
      };
    };
    // The emulators still track the first finger and would turn it into a
    // click or long-press right click. Rather than spoil their internal state
    // with synthetic touches (which the touchpad would read as a two-finger
    // tap), the pointer gate drops their output until a fresh touch starts.
    const claim = () => {
      claimed = true;
      touchGateRef.current?.beginMultiTouch();
    };

    const onTouchStart = (event: TouchEvent) => {
      const touches = pair(event.touches);
      if (touches) {
        // Take the two-finger sequence so the emulator never sees a 2-finger
        // start.
        event.preventDefault();
        event.stopPropagation();
        gesture = beginGesture(touches);
        claim();
        return;
      }
      if (claimed) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      gesture = null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const touches = pair(event.touches);
      if (!touches) {
        if (claimed) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!gesture) {
        gesture = beginGesture(touches);
        claim();
      }
      const mid = touchMidpoint(touches.a, touches.b);
      const to = relative(mid, container.getBoundingClientRect());
      const distance = touchDistance(touches.a, touches.b);
      const kind = classifyTwoFingerMove({
        startDistance: gesture.startDistance,
        currentDistance: distance,
        current: gesture.kind,
        midpointDelta: Math.hypot(
          to.x - gesture.startMid.x,
          to.y - gesture.startMid.y,
        ),
      });
      if (kind === "undecided") {
        gesture.lastMid = mid;
        return;
      }
      if (kind === "pinch" && gesture.kind === "pan") {
        // The pan already scrolled; zoom around what is under the fingers now.
        gesture.startScrollLeft = container.scrollLeft;
        gesture.startScrollTop = container.scrollTop;
        gesture.startMid = to;
        gesture.startOffset = measureOffset();
        gesture.startScale = scaleRef.current;
        gesture.startZoom = zoomRef.current;
        gesture.startDistance = distance;
      }
      gesture.kind = kind;
      if (kind === "pinch") {
        const newZoom = nextPinchZoom(
          gesture.startZoom,
          gesture.startDistance,
          distance,
        );
        applyZoom(newZoom);
        const after = measureOffset();
        const next = scrollAfterZoom({
          scrollLeft: gesture.startScrollLeft,
          scrollTop: gesture.startScrollTop,
          fromX: gesture.startMid.x,
          fromY: gesture.startMid.y,
          pointX: to.x,
          pointY: to.y,
          oldScale: gesture.startScale,
          newScale: scaleRef.current,
          fromOffsetX: gesture.startOffset.x,
          fromOffsetY: gesture.startOffset.y,
          toOffsetX: after.x,
          toOffsetY: after.y,
        });
        container.scrollLeft = next.scrollLeft;
        container.scrollTop = next.scrollTop;
      } else {
        const next = scrollAfterPan({
          scrollLeft: container.scrollLeft,
          scrollTop: container.scrollTop,
          dx: mid.x - gesture.lastMid.x,
          dy: mid.y - gesture.lastMid.y,
        });
        container.scrollLeft = next.scrollLeft;
        container.scrollTop = next.scrollTop;
      }
      gesture.lastMid = mid;
    };
    const onTouchEnd = (event: TouchEvent) => {
      const remaining = pair(event.touches);
      if (claimed) {
        if (event.touches.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          // Lifting a third finger leaves two: restart so the view does not jump.
          if (remaining) gesture = beginGesture(remaining);
          return;
        }
        // Last finger up: let the emulator see the end so it can leave the
        // original 1-finger gesture (the gate drops whatever it emits), but
        // cancel the browser's compatibility mouse events.
        event.preventDefault();
        gesture = null;
        claimed = false;
        touchGateRef.current?.allTouchesEnded();
        return;
      }
      gesture = remaining ? beginGesture(remaining) : null;
    };

    container.addEventListener("touchstart", onTouchStart, {
      passive: false,
      capture: true,
    });
    container.addEventListener("touchmove", onTouchMove, {
      passive: false,
      capture: true,
    });
    container.addEventListener("touchend", onTouchEnd, {
      passive: false,
      capture: true,
    });
    container.addEventListener("touchcancel", onTouchEnd, {
      passive: false,
      capture: true,
    });
    return () => {
      container.removeEventListener("touchstart", onTouchStart, true);
      container.removeEventListener("touchmove", onTouchMove, true);
      container.removeEventListener("touchend", onTouchEnd, true);
      container.removeEventListener("touchcancel", onTouchEnd, true);
    };
  }, [applyZoom, connectionConfig.protocol, connectionConfig.type, isReady]);

  const canDropFiles = allowUpload && onDropFiles != null;
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  // Nested elements fire dragleave as the pointer crosses them, so track depth
  // rather than clearing the highlight on the first leave.
  const dragDepthRef = useRef(0);

  const handleDragEnter = useCallback(
    (event: React.DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      if (!canDropFiles) return;
      dragDepthRef.current += 1;
      setIsDraggingFiles(true);
    },
    [canDropFiles],
  );

  const handleDragLeave = useCallback(() => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      if (!hasDraggedFiles(event.dataTransfer.types)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);

      const files = Array.from(event.dataTransfer.files);
      const disposition = getFileDropDisposition(
        event.dataTransfer.types,
        files.length,
        canDropFiles,
      );
      if (disposition === "upload") onDropFiles?.(files);
      if (disposition === "reject") onDropUnavailable?.();
    },
    [canDropFiles, onDropFiles, onDropUnavailable],
  );

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-auto"
      style={{ backgroundColor: "var(--bg-base)" }}
      onDragEnter={handleDragEnter}
      onDragOver={(event) => {
        if (hasDraggedFiles(event.dataTransfer.types)) event.preventDefault();
      }}
      onDragLeave={canDropFiles ? handleDragLeave : undefined}
      onDrop={handleDrop}
    >
      <div
        ref={displayRef}
        className="relative flex min-h-full min-w-full items-center justify-center overflow-hidden"
        style={{
          cursor: isReady ? "none" : "default",
          visibility: isReady ? "visible" : "hidden",
        }}
      />

      <textarea
        ref={softKeyboardRef}
        aria-label={t("remoteDesktop.toolbar.showKeyboard")}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        tabIndex={-1}
        rows={1}
        defaultValue=""
        onKeyDown={(event) => {
          if (
            isComposingKeyboardEvent({
              key: event.key,
              keyCode: event.keyCode,
              isComposing: event.nativeEvent.isComposing,
            })
          ) {
            return;
          }
          const keysym = specialKeysymFromKeyboardEvent(event);
          if (keysym == null) return;
          event.preventDefault();
          if (!clientRef.current) return;
          softKeys.press(keysym);
        }}
        onKeyUp={(event) => {
          if (
            isComposingKeyboardEvent({
              key: event.key,
              keyCode: event.keyCode,
              isComposing: event.nativeEvent.isComposing,
            })
          ) {
            return;
          }
          const keysym = specialKeysymFromKeyboardEvent(event);
          if (keysym == null) return;
          event.preventDefault();
          if (!clientRef.current) return;
          softKeys.release(keysym);
        }}
        onInput={(event) => {
          if (inputHandledRef.current) {
            inputHandledRef.current = false;
            event.currentTarget.value = "";
            return;
          }
          if (event.nativeEvent.isComposing || composingRef.current) return;
          const text = event.currentTarget.value;
          event.currentTarget.value = "";
          if (!text) return;
          sendSoftKeysyms(textToKeysyms(text));
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          const text = event.data ?? "";
          event.currentTarget.value = "";
          markSoftKeyboardHandled();
          if (!text) return;
          sendSoftKeysyms(textToKeysyms(text));
        }}
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          width: "1px",
          height: "1px",
          margin: 0,
          padding: 0,
          opacity: 0,
          fontSize: "16px",
          border: "none",
          resize: "none",
          overflow: "hidden",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      {isDraggingFiles && (
        <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none bg-background/70 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-sm border-2 border-dashed border-border px-4 py-3 text-sm font-semibold">
            <Upload className="size-4" />
            {t("remoteDesktop.files.dropToUpload")}
          </div>
        </div>
      )}
    </div>
  );
});
