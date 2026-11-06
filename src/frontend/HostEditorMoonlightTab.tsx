import { useCallback, useEffect, useRef, useState } from "react";
import { usePermission, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, Input, SectionCard, Select2 } from "@termix-ssh/plugin-sdk/ui";
import { Gamepad2, Globe } from "lucide-react";
import { errorMessage } from "./host-remote";
import {
  addMoonlightPc,
  getMoonlightPairing,
  getMoonlightStatus,
  listMoonlightApps,
  listMoonlightPcs,
  moonlightOrigin,
  startMoonlightPairing,
  type MoonlightPc,
  type MoonlightPcApp,
} from "./moonlight-api";
import { docsUrl } from "./docs";
import type { RemoteDesktopForm, RemoteFormSetField } from "./remote-form";

const LABEL =
  "text-[10px] font-bold uppercase tracking-widest text-muted-foreground";

const NO_SPIN =
  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";

const SELECT =
  "flex h-9 w-full border border-border bg-background px-3 py-1 text-xs outline-none focus:ring-1 focus:ring-ring";

const PAIR_POLL_MS = 2000;

type Pairing =
  | { status: "idle" }
  | { status: "waiting"; pin: string }
  | { status: "failed"; message: string };

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className={LABEL}>{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function HostEditorMoonlightTab({
  form,
  setField,
  address,
  port,
  connectionOrigin,
}: {
  form: RemoteDesktopForm;
  setField: RemoteFormSetField;
  address: string;
  port: number;
  connectionOrigin?: "local" | "remote" | null;
}) {
  const { t } = useTranslation();
  const canSetUp = usePermission("remote-desktop.moonlight");
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pcs, setPcs] = useState<MoonlightPc[]>([]);
  const [apps, setApps] = useState<MoonlightPcApp[]>([]);
  const [adding, setAdding] = useState(false);
  const [pairing, setPairing] = useState<Pairing>({ status: "idle" });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const origin = await moonlightOrigin(connectionOrigin);
      const status = await getMoonlightStatus(origin);
      if (!mounted.current) return;
      if (!status.reachable) {
        setPcs([]);
        setNotice(
          status.configured
            ? (status.error ?? null)
            : t("hosts.moonlight.notConfigured"),
        );
        return;
      }
      const list = await listMoonlightPcs(origin);
      if (mounted.current) setPcs(list);
    } catch (error) {
      if (mounted.current) setNotice(errorMessage(error));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [connectionOrigin, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected = pcs.find((pc) => pc.id === form.moonlightHostId);
  const paired = !!selected?.paired;
  const selectedId = selected?.id;

  useEffect(() => {
    if (!selectedId || !paired) {
      setApps([]);
      return;
    }
    let stale = false;
    void moonlightOrigin(connectionOrigin)
      .then((origin) => listMoonlightApps(origin, selectedId))
      .then((list) => {
        if (!stale) setApps(list);
      })
      .catch(() => {
        if (!stale) setApps([]);
      });
    return () => {
      stale = true;
    };
  }, [selectedId, paired, connectionOrigin]);

  const addPc = async () => {
    setAdding(true);
    setNotice(null);
    try {
      const origin = await moonlightOrigin(connectionOrigin);
      const pc = await addMoonlightPc(origin, address, port);
      setField("moonlightHostId", pc.id);
      await refresh();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setAdding(false);
    }
  };

  const pair = async () => {
    if (!selectedId) return;
    setPairing({ status: "idle" });
    try {
      const origin = await moonlightOrigin(connectionOrigin);
      const job = await startMoonlightPairing(origin, selectedId);
      setPairing({ status: "waiting", pin: job.pin });
      for (;;) {
        await new Promise((done) => setTimeout(done, PAIR_POLL_MS));
        if (!mounted.current) return;
        const state = await getMoonlightPairing(origin, job.id);
        if (state === "waiting") continue;
        if (state === "paired") {
          setPairing({ status: "idle" });
          await refresh();
          return;
        }
        setPairing({
          status: "failed",
          message: t(
            state === "expired"
              ? "hosts.moonlight.pairExpired"
              : "hosts.moonlight.pairFailed",
          ),
        });
        return;
      }
    } catch (error) {
      if (mounted.current) {
        setPairing({ status: "failed", message: errorMessage(error) });
      }
    }
  };

  const pcLabel = (pc: MoonlightPc) =>
    t("hosts.moonlight.pcLabel", {
      name: pc.name || pc.address,
      state: t(
        !pc.online
          ? "hosts.moonlight.offline"
          : pc.paired
            ? "hosts.moonlight.paired"
            : "hosts.moonlight.notPaired",
      ),
    });

  const known = pcs.some((pc) => pc.address === address && pc.port === port);

  return (
    <>
      <SectionCard
        title={t("hosts.moonlight.server")}
        icon={<Globe className="size-3.5" />}
        action={
          <a
            href={docsUrl("", "moonlight")}
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-accent-brand hover:underline normal-case tracking-normal font-normal"
          >
            {t("hosts.docsLink")}
          </a>
        }
      >
        <div className="flex flex-col gap-4 py-3">
          {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
          <Field
            label={t("hosts.moonlight.pc")}
            hint={t("hosts.moonlight.pcDesc")}
          >
            <div className="flex gap-2">
              <Select2
                value={String(form.moonlightHostId || "")}
                onChange={(e) =>
                  setField("moonlightHostId", Number(e.target.value))
                }
                className={SELECT}
              >
                <option value="">{t("hosts.moonlight.choosePc")}</option>
                {pcs.map((pc) => (
                  <option key={pc.id} value={pc.id}>
                    {pcLabel(pc)}
                  </option>
                ))}
              </Select2>
              <Button
                size="sm"
                variant="outline"
                disabled={loading}
                onClick={() => void refresh()}
              >
                {t("hosts.moonlight.refresh")}
              </Button>
            </div>
          </Field>

          {canSetUp && !!address && !known && !notice && !loading && (
            <div className="flex flex-col items-start gap-1.5">
              <Button
                size="sm"
                variant="outline"
                disabled={adding}
                onClick={() => void addPc()}
              >
                {t("hosts.moonlight.addPc")}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t("hosts.moonlight.addPcDesc", { address, port })}
              </p>
            </div>
          )}

          {selected && !paired && (
            <div className="flex flex-col items-start gap-1.5">
              {!canSetUp ? (
                <p className="text-xs text-muted-foreground">
                  {t("hosts.moonlight.noSetUpAccess")}
                </p>
              ) : pairing.status === "waiting" ? (
                <>
                  <p className="text-sm font-bold">
                    {t("hosts.moonlight.pinTitle", { pin: pairing.pin })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("hosts.moonlight.pinDesc")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("hosts.moonlight.pairing")}
                  </p>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void pair()}
                  >
                    {t("hosts.moonlight.pair")}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {pairing.status === "failed"
                      ? pairing.message
                      : t("hosts.moonlight.pairDesc")}
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title={t("hosts.moonlight.stream")}
        icon={<Gamepad2 className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          <Field
            label={t("hosts.moonlight.app")}
            hint={t("hosts.moonlight.appDesc")}
          >
            <Select2
              value={String(form.moonlightAppId || "")}
              onChange={(e) =>
                setField("moonlightAppId", Number(e.target.value))
              }
              className={SELECT}
            >
              <option value="">{t("hosts.moonlight.firstApp")}</option>
              {apps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.title}
                </option>
              ))}
            </Select2>
          </Field>
          <Field
            label={t("hosts.moonlight.bitrate")}
            hint={t("hosts.moonlight.bitrateDesc")}
          >
            <Input
              type="number"
              min={0}
              value={form.moonlightBitrate}
              onChange={(e) =>
                setField("moonlightBitrate", Number(e.target.value))
              }
              className={NO_SPIN}
            />
          </Field>
          <Field
            label={t("hosts.moonlight.fps")}
            hint={t("hosts.moonlight.fpsDesc")}
          >
            <Input
              type="number"
              min={0}
              value={form.moonlightFps}
              onChange={(e) => setField("moonlightFps", Number(e.target.value))}
              className={NO_SPIN}
            />
          </Field>
          <Field
            label={t("hosts.moonlight.transport")}
            hint={t("hosts.moonlight.transportDesc")}
          >
            <Select2
              value={form.moonlightTransport}
              onChange={(e) => setField("moonlightTransport", e.target.value)}
              className={SELECT}
            >
              <option value="auto">{t("hosts.moonlight.transportAuto")}</option>
              <option value="webrtc">
                {t("hosts.moonlight.transportWebrtc")}
              </option>
              <option value="websocket">
                {t("hosts.moonlight.transportWebsocket")}
              </option>
            </Select2>
          </Field>
        </div>
      </SectionCard>
    </>
  );
}
