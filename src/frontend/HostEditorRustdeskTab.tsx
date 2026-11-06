import {
  HOST_PROTOCOL_SECRET_KEPT,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  FakeSwitch,
  Input,
  PasswordInput,
  SectionCard,
  Select2,
  SettingRow,
} from "@termix-ssh/plugin-sdk/ui";
import { Globe, Server, Settings, Shield } from "lucide-react";
import type { RemoteDesktopForm, RemoteFormSetField } from "./remote-form";
import { docsUrl } from "./docs";

const LABEL =
  "text-[10px] font-bold uppercase tracking-widest text-muted-foreground";

const NO_SPIN =
  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";

function DocsLink({ label }: { label: string }) {
  return (
    <a
      href={docsUrl("", "rustdesk")}
      target="_blank"
      rel="noreferrer"
      className="text-[10px] text-accent-brand hover:underline normal-case tracking-normal font-normal"
    >
      {label}
    </a>
  );
}

export function HostEditorRustdeskTab({
  form,
  setField,
  setGuacField,
  credentials,
}: {
  form: RemoteDesktopForm;
  setField: RemoteFormSetField;
  setGuacField: (key: string, value: unknown) => void;
  credentials?: { id: string; name: string; username: string }[];
}) {
  const { t } = useTranslation();
  const ownServer = !!form.rustdeskIdServer.trim();
  const hasCredentials = !!credentials && credentials.length > 0;
  const savedPassword = form.rustdeskPassword === HOST_PROTOCOL_SECRET_KEPT;

  return (
    <>
      <SectionCard
        title={t("hosts.guac.connection")}
        icon={<Globe className="size-3.5" />}
        action={<DocsLink label={t("hosts.docsLink")} />}
      >
        <div className="flex flex-col gap-4 py-3">
          <SettingRow
            label={t("hosts.rustdesk.direct")}
            description={t("hosts.rustdesk.directDesc")}
          >
            <FakeSwitch
              checked={form.rustdeskDirect}
              onChange={(v) => setField("rustdeskDirect", v)}
            />
          </SettingRow>
          {form.rustdeskDirect ? (
            <div className="flex flex-col gap-1.5">
              <label className={LABEL}>{t("hosts.rustdesk.port")}</label>
              <Input
                type="number"
                placeholder="21118"
                value={form.rustdeskPort}
                onChange={(e) =>
                  setField("rustdeskPort", Number(e.target.value))
                }
                className={NO_SPIN}
              />
              <p className="text-xs text-muted-foreground">
                {t("hosts.rustdesk.directNote")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label className={LABEL}>{t("hosts.rustdesk.id")}</label>
              <Input
                placeholder="123 456 789"
                value={form.rustdeskId}
                onChange={(e) => setField("rustdeskId", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("hosts.rustdesk.idDesc")}
              </p>
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title={t("hosts.guac.authentication")}
        icon={<Shield className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          {hasCredentials && (
            <div className="flex flex-col gap-1.5">
              <label className={LABEL}>{t("hosts.guac.authMethod")}</label>
              <div className="flex gap-2">
                {(["direct", "credential"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setField("rustdeskAuthType", m)}
                    className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border transition-colors ${
                      form.rustdeskAuthType === m
                        ? "border-accent-brand/40 bg-accent-brand/10 text-accent-brand"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t(
                      m === "direct"
                        ? "hosts.guac.authTypeDirect"
                        : "hosts.guac.authTypeCredential",
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {form.rustdeskAuthType === "credential" && hasCredentials ? (
            <div className="flex flex-col gap-1.5">
              <label className={LABEL}>
                {t("hosts.guac.storedCredential")}
              </label>
              <Select2
                value={form.rustdeskCredentialId}
                onChange={(e) =>
                  setField("rustdeskCredentialId", e.target.value)
                }
                className="flex h-9 w-full border border-border bg-background px-3 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">{t("hosts.guac.selectCredential")}</option>
                {credentials!.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.username ? `${c.name} (${c.username})` : c.name}
                  </option>
                ))}
              </Select2>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label className={LABEL}>{t("hosts.guac.password")}</label>
              <PasswordInput
                className="h-8 text-xs pr-8"
                placeholder={
                  savedPassword ? t("hosts.guac.passwordSaved") : "••••••••"
                }
                value={savedPassword ? "" : form.rustdeskPassword}
                onFocus={() => {
                  if (savedPassword) setField("rustdeskPassword", "");
                }}
                onChange={(e) => setField("rustdeskPassword", e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t("hosts.rustdesk.passwordDesc")}
              </p>
            </div>
          )}
        </div>
      </SectionCard>

      {!form.rustdeskDirect && (
        <SectionCard
          title={t("hosts.rustdesk.server")}
          icon={<Server className="size-3.5" />}
        >
          <div className="flex flex-col gap-4 py-3">
            <p className="text-xs text-muted-foreground">
              {t("hosts.rustdesk.serverDesc")}
            </p>
            <div className="flex flex-col gap-1.5">
              <label className={LABEL}>{t("hosts.rustdesk.idServer")}</label>
              <Input
                placeholder={t("hosts.rustdesk.idServerPlaceholder")}
                value={form.rustdeskIdServer}
                onChange={(e) => setField("rustdeskIdServer", e.target.value)}
              />
            </div>
            {ownServer && (
              <>
                <div className="flex flex-col gap-1.5">
                  <label className={LABEL}>
                    {t("hosts.rustdesk.relayServer")}
                  </label>
                  <Input
                    placeholder={t("hosts.rustdesk.relayServerPlaceholder")}
                    value={form.rustdeskRelayServer}
                    onChange={(e) =>
                      setField("rustdeskRelayServer", e.target.value)
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className={LABEL}>{t("hosts.rustdesk.key")}</label>
                  <Input
                    value={form.rustdeskKey}
                    onChange={(e) => setField("rustdeskKey", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("hosts.rustdesk.keyDesc")}
                  </p>
                </div>
              </>
            )}
          </div>
        </SectionCard>
      )}

      <SectionCard
        title={t("hosts.guac.displaySettings")}
        icon={<Settings className="size-3.5" />}
      >
        <div className="flex flex-col gap-4 py-3">
          {(
            [
              ["disable-audio", "disableAudio"],
              ["disable-copy", "disableCopy"],
              ["disable-paste", "disablePaste"],
            ] as const
          ).map(([key, label]) => (
            <SettingRow
              key={key}
              label={t(`hosts.guac.${label}`)}
              description={t(`hosts.guac.${label}Desc`)}
            >
              <FakeSwitch
                checked={!!form.guacamoleConfig[key]}
                onChange={(v) => setGuacField(key, v)}
              />
            </SettingRow>
          ))}
        </div>
      </SectionCard>
    </>
  );
}
