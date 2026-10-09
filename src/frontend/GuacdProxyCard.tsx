import { useEffect, useState } from "react";
import {
  usePermission,
  usePluginApi,
  useToast,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import { Button, Input, SectionCard } from "@termix-ssh/plugin-sdk/ui";
import { Cpu } from "lucide-react";

interface GuacdHostResponse {
  hostname: string;
  port: number | null;
  canEdit: boolean;
}

/**
 * A host's own guacd server. Only admins set it, through its own route,
 * since it decides where the server opens a connection.
 */
export function GuacdProxyCard({
  hostId,
  setGuacField,
}: {
  hostId?: string;
  setGuacField: (key: string, value: unknown) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const api = usePluginApi();
  const isAdmin = usePermission("admin.plugins.manage");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    if (!hostId) return;
    api
      .get<GuacdHostResponse>(`/guacd-host/${hostId}`)
      .then(({ data }) => {
        if (!active) return;
        setHostname(data.hostname ?? "");
        setPort(data.port ? String(data.port) : "");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api, hostId]);

  const canEdit = isAdmin && !!hostId;

  const save = async () => {
    if (!hostId) return;
    setSaving(true);
    try {
      const { data } = await api.put<GuacdHostResponse>(
        `/guacd-host/${hostId}`,
        { hostname, port: port ? Number(port) : null },
      );
      setHostname(data.hostname ?? "");
      setPort(data.port ? String(data.port) : "");
      // Keeps the copy the desktop app syncs in step with what was saved.
      setGuacField("guacd-hostname", data.hostname ?? "");
      setGuacField("guacd-port", data.port ? String(data.port) : "");
      toast.success(t("hosts.guac.guacdSaved"));
    } catch {
      toast.error(t("hosts.guac.guacdSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title={t("hosts.guac.guacdProxy")}
      icon={<Cpu className="size-3.5" />}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {t("hosts.guac.guacdHostname")}
          </label>
          <Input
            placeholder={t("hosts.guac.guacdHostnamePlaceholder")}
            value={hostname}
            disabled={!canEdit}
            onChange={(e) => setHostname(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {t("hosts.guac.guacdPort")}
          </label>
          <Input
            type="number"
            placeholder="4822"
            value={port}
            disabled={!canEdit}
            onChange={(e) => setPort(e.target.value)}
            className="[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
        </div>
        <p className="col-span-full text-[10px] text-muted-foreground -mt-2">
          {!isAdmin
            ? t("hosts.guac.guacdAdminOnly")
            : !hostId
              ? t("hosts.guac.guacdSaveHostFirst")
              : t("hosts.guac.guacdProxyDesc")}
        </p>
        {canEdit && (
          <div className="col-span-full flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => void save()}
            >
              {t("hosts.guac.guacdSave")}
            </Button>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
