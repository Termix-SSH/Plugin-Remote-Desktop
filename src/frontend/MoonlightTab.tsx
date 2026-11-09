import { useCallback, useEffect, useRef, useState } from "react";
import { useTabs, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  isElectron,
  LoadingState,
  resolveRemoteHostId,
  ToolbarBand,
} from "@termix-ssh/plugin-sdk/ui";
import { errorMessage, type RemoteHostLogin } from "./host-remote";
import { apiBase, launchMoonlight, moonlightOrigin } from "./moonlight-api";
import {
  canPlayH264,
  keyboardLockRequest,
  moonlightEmbed,
} from "./moonlight-embed";

const ERROR_KEYS: Record<string, string> = {
  "not-configured": "hosts.moonlight.notConfigured",
  "recording-required": "hosts.moonlight.errorRecordingRequired",
  "not-linked": "hosts.moonlight.errorNotLinked",
  "not-paired": "hosts.moonlight.errorNotPaired",
  offline: "hosts.moonlight.errorOffline",
  "no-apps": "hosts.moonlight.errorNoApps",
};

type LaunchState =
  | { status: "loading" }
  | {
      status: "failed";
      message: string;
      requestTab: string | null;
      verify: boolean;
    }
  | { status: "ready"; url: string; framed: boolean };

type Keyboard = { lock?: (keys?: string[]) => Promise<void> };

function openStream(url: string) {
  window.open(url, "_blank", "noopener");
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function MoonlightTab({ host }: { host?: RemoteHostLogin }) {
  const { t } = useTranslation();
  const tabs = useTabs();
  const [state, setState] = useState<LaunchState>({ status: "loading" });
  const frame = useRef<HTMLIFrameElement>(null);
  const run = useRef(0);
  const [noH264, setNoH264] = useState(false);
  const hostId = host?.id;
  const syncId = host?.syncId;
  const connectionOrigin = host?.connectionOrigin;

  const launch = useCallback(async () => {
    const current = ++run.current;
    setState({ status: "loading" });
    try {
      const origin = await moonlightOrigin(connectionOrigin);
      const remote = isElectron() && origin === "remote";
      const id = remote ? await resolveRemoteHostId(syncId) : hostId;
      if (id === undefined || id === null) {
        throw new Error(t("remoteDesktop.noHostSelected"));
      }
      const launched = await launchMoonlight(origin, id);
      // Through this server the page is on Termix's own address, so it can be
      // framed. A linked server's proxy is another address, so it opens apart.
      const proxied = !!launched.proxyUrl && !remote;
      const url = proxied
        ? new URL(
            `${apiBase(origin)}${launched.proxyUrl as string}`,
            location.href,
          ).toString()
        : launched.url;
      const framed =
        proxied ||
        moonlightEmbed(url, location.href, isElectron()) === "iframe";
      if (current === run.current) {
        setState({ status: "ready", url, framed });
      }
    } catch (error) {
      if (current !== run.current) return;
      const { code, requestTab, requestKind } = error as {
        code?: string;
        requestTab?: string | null;
        requestKind?: string | null;
      };
      const key = code ? ERROR_KEYS[code] : undefined;
      setState({
        status: "failed",
        message: key ? t(key) : errorMessage(error),
        requestTab: requestTab ?? null,
        verify: requestKind === "verify",
      });
    }
  }, [hostId, syncId, connectionOrigin, t]);

  useEffect(() => {
    void launch();
    return () => {
      run.current += 1;
    };
  }, [launch]);

  const url = state.status === "ready" ? state.url : null;

  useEffect(() => {
    if (!url) return;
    let live = true;
    void canPlayH264().then((ok) => {
      if (live) setNoH264(!ok);
    });
    return () => {
      live = false;
    };
  }, [url]);

  useEffect(() => {
    if (!url) return;
    const onMessage = (event: MessageEvent) => {
      const keys = keyboardLockRequest(
        event,
        frame.current?.contentWindow,
        url,
      );
      if (keys === null) return;
      const { keyboard } = navigator as Navigator & { keyboard?: Keyboard };
      void keyboard?.lock?.(keys)?.catch(() => undefined);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [url]);

  if (state.status === "loading") {
    return <LoadingState label={t("hosts.moonlight.loading")} />;
  }

  if (state.status === "failed") {
    const { message, requestTab, verify } = state;
    return (
      <Centered>
        <p>{message}</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void launch()}>
            {t("hosts.moonlight.retry")}
          </Button>
          {requestTab && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                tabs.openSingletonTab(requestTab, { data: { hostId } })
              }
            >
              {t(
                verify
                  ? "remoteDesktop.verifyAccess"
                  : "remoteDesktop.requestAccess",
              )}
            </Button>
          )}
        </div>
      </Centered>
    );
  }

  if (!state.framed) {
    return (
      <Centered>
        <Button onClick={() => openStream(state.url)}>
          {t("hosts.moonlight.openStream")}
        </Button>
        <p>{t("hosts.moonlight.signInNote")}</p>
      </Centered>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <ToolbarBand className="justify-end">
        {noH264 && (
          <span
            className="mr-auto truncate text-xs text-muted-foreground"
            title={t("hosts.moonlight.noH264")}
          >
            {t("hosts.moonlight.noH264")}
          </span>
        )}
        <Button size="xs" variant="ghost" onClick={() => openStream(state.url)}>
          {t("hosts.moonlight.openInWindow")}
        </Button>
      </ToolbarBand>
      <iframe
        ref={frame}
        title={t("hosts.tabMoonlight")}
        src={state.url}
        allow="fullscreen; autoplay; gamepad; keyboard-map; microphone"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0"
      />
    </div>
  );
}
