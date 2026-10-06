import { useCallback, useEffect, useState } from "react";
import {
  useSettings,
  useTranslation,
  type OnboardingStepProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, Input } from "@termix-ssh/plugin-sdk/ui";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { getGuacdStatus, type RemoteDesktopStatus } from "./guacamole-api";

const COMPOSE_SNIPPET = `  guacd:
    image: guacamole/guacd:1.6.0
    restart: unless-stopped`;

/**
 * Remote desktop needs guacd running next to Termix, which is easy to miss.
 * This checks whether it answers and lets the admin point at it. It never
 * blocks onboarding: Remote Desktop simply will not connect until it does.
 */
export function GuacdSetupStep(_props: OnboardingStepProps) {
  const { t } = useTranslation();
  const settings = useSettings("admin");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<RemoteDesktopStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (settings.loaded) setUrl(String(settings.values.guacdUrl ?? ""));
  }, [settings.loaded, settings.values.guacdUrl]);

  const check = useCallback(async () => {
    setChecking(true);
    setFailed(false);
    try {
      setStatus(await getGuacdStatus("local"));
    } catch {
      setFailed(true);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const saveAndCheck = async () => {
    try {
      await settings.save({ guacdUrl: url.trim() });
    } catch {
      setFailed(true);
      return;
    }
    await check();
  };

  const connected = status?.guacd.status === "connected";
  const address =
    status?.guacd.host && status.guacd.port
      ? `${status.guacd.host}:${status.guacd.port}`
      : "";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {t("onboarding.guacdIntro")}
      </p>

      <div
        className={`flex items-start gap-2.5 border p-3 ${
          connected
            ? "border-accent-brand/40 bg-accent-brand/5"
            : "border-border bg-card"
        }`}
      >
        {checking ? (
          <Loader2 size={15} className="mt-0.5 shrink-0 animate-spin" />
        ) : connected ? (
          <CheckCircle2
            size={15}
            className="mt-0.5 shrink-0 text-accent-brand"
          />
        ) : (
          <XCircle size={15} className="mt-0.5 shrink-0 text-destructive" />
        )}
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium">
            {checking
              ? t("onboarding.guacdChecking")
              : connected
                ? t("onboarding.guacdConnected", { address })
                : failed
                  ? t("onboarding.guacdCheckFailed")
                  : t("onboarding.guacdMissing", { address })}
          </span>
          {!checking && !connected && (
            <span className="text-[11px] leading-snug text-muted-foreground">
              {t("onboarding.guacdMissingDesc")}
            </span>
          )}
        </div>
      </div>

      {!connected && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {t("onboarding.guacdComposeTitle")}
          </span>
          <pre className="overflow-x-auto border border-border bg-muted/40 p-2.5 font-mono text-[11px]">
            {COMPOSE_SNIPPET}
          </pre>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          {t("settings.admin.guacdUrl.label")}
        </span>
        <div className="flex gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("settings.admin.guacdUrl.placeholder")}
            className="h-8 flex-1 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={checking}
            onClick={() => void saveAndCheck()}
          >
            {t("onboarding.guacdSaveAndCheck")}
          </Button>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {t("onboarding.guacdEnvNote")}
        </span>
      </div>
    </div>
  );
}
