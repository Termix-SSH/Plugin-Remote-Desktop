import { useCallback, useEffect, useRef, useState } from "react";
import { useTabs, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  isElectron,
  resolveRemoteHostId,
} from "@termix-ssh/plugin-sdk/ui";
import { errorMessage, type RemoteHostLogin } from "./host-remote";
import { launchMoonlight, moonlightOrigin } from "./moonlight-api";
import { keyboardLockRequest, moonlightEmbed } from "./moonlight-embed";

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
  | { status: "failed"; message: string; requestTab: string | null }
  | { status: "ready"; url: string };

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
      const { url } = await launchMoonlight(origin, id);
      if (current === run.current) setState({ status: "ready", url });
    } catch (error) {
      if (current !== run.current) return;
      const { code, requestTab } = error as {
        code?: string;
        requestTab?: string | null;
      };
      const key = code ? ERROR_KEYS[code] : undefined;
      setState({
        status: "failed",
        message: key ? t(key) : errorMessage(error),
        requestTab: requestTab ?? null,
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
    return <Centered>{t("hosts.moonlight.loading")}</Centered>;
  }

  if (state.status === "failed") {
    const { message, requestTab } = state;
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
              {t("remoteDesktop.requestAccess")}
            </Button>
          )}
        </div>
      </Centered>
    );
  }

  if (moonlightEmbed(state.url, location.href, isElectron()) === "window") {
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
      <div className="flex items-center justify-end border-b border-border px-2 py-1">
        <Button size="xs" variant="ghost" onClick={() => openStream(state.url)}>
          {t("hosts.moonlight.openInWindow")}
        </Button>
      </div>
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
