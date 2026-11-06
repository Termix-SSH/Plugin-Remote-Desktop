import { useCallback, useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import {
  useHosts,
  usePermission,
  usePluginApi,
  useTabs,
  useTranslation,
  type DashboardCardProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { ListBadge, ListRow, PanelList } from "@termix-ssh/plugin-sdk/ui";

interface LiveRow {
  id: string;
  hostId: number;
  hostName: string;
  protocol: string;
  openedAt: number;
}

const POLL_MS = 30_000;

/** Dashboard card: the remote desktop sessions open on the server for this user. */
export function RemoteSessionsCard({ isVisible }: DashboardCardProps) {
  const { t } = useTranslation();
  const allowed = usePermission("sessions");
  const api = usePluginApi();
  const tabs = useTabs();
  const { hosts } = useHosts();
  const [rows, setRows] = useState<LiveRow[] | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<LiveRow[]>("/live-sessions");
      setRows(data);
    } catch {
      setRows([]);
    }
  }, [api]);

  useEffect(() => {
    if (!isVisible || !allowed) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isVisible, allowed, load]);

  if (!allowed) return null;
  if (!rows) {
    return (
      <p className="p-3 text-xs text-muted-foreground">{t("card.loading")}</p>
    );
  }

  return (
    <PanelList
      empty={
        <p className="p-3 text-xs text-muted-foreground">{t("card.empty")}</p>
      }
    >
      {rows.map((row, index) => {
        const host = hosts.find((h) => Number(h.id) === row.hostId);
        return (
          <ListRow
            key={row.id}
            stripe={index}
            tone="success"
            icon={<Monitor className="size-3.5" />}
            title={host?.name || row.hostName}
            badges={<ListBadge>{row.protocol.toUpperCase()}</ListBadge>}
            meta={new Date(row.openedAt).toLocaleString()}
            onClick={() =>
              host &&
              tabs.openTab(host, row.protocol === "ard" ? "vnc" : row.protocol)
            }
          />
        );
      })}
    </PanelList>
  );
}
