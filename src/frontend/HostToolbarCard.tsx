import { ArrowDown, ArrowUp, MonitorUp, RotateCcw } from "lucide-react";
import {
  Button,
  FakeSwitch,
  HostDefaultBadge,
  HostDefaultField,
  SectionCard,
  Select2,
  SettingRow,
  cn,
} from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type { RemoteDesktopForm, RemoteFormSetField } from "./remote-form";
import { useToolbarItems } from "./toolbar-items";
import { arrangeButtons, type ToolbarButtonLayout } from "./toolbar-settings";

const SELECT =
  "flex h-8 w-40 border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring";

/** The host editor's toolbar card: whether it shows, where, and which buttons. */
export function HostToolbarCard({
  form,
  setField,
}: {
  form: RemoteDesktopForm;
  setField: RemoteFormSetField;
}) {
  const { t } = useTranslation();
  const catalog = useToolbarItems();
  const layout = form.toolbarButtons;
  const ordered = arrangeButtons(catalog, layout);
  const hidden = new Set(layout.hidden);

  const writeButtons = (next: ToolbarButtonLayout) =>
    setField("toolbarButtons", next);
  const move = (index: number, offset: number) => {
    const ids = ordered.map((item) => item.id);
    const target = index + offset;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    writeButtons({ ...layout, order: ids });
  };
  const toggle = (id: string, visible: boolean) =>
    writeButtons({
      ...layout,
      hidden: visible
        ? layout.hidden.filter((entry) => entry !== id)
        : [...layout.hidden, id],
    });

  return (
    <SectionCard
      title={t("hosts.guac.toolbar")}
      icon={<MonitorUp className="size-3.5" />}
    >
      <SettingRow
        label={t("settings.host.enableToolbar.label")}
        description={t("settings.host.enableToolbar.description")}
        defaultKey="enableToolbar"
      >
        <FakeSwitch
          checked={form.enableToolbar}
          onChange={(value) => setField("enableToolbar", value)}
        />
      </SettingRow>
      {form.enableToolbar && (
        <>
          <SettingRow
            label={t("settings.host.toolbarPosition.label")}
            description={t("settings.host.toolbarPosition.description")}
            defaultKey="toolbarPosition"
          >
            <Select2
              value={form.toolbarPosition}
              onChange={(event) =>
                setField(
                  "toolbarPosition",
                  event.target.value === "bottom" ? "bottom" : "top",
                )
              }
              className={SELECT}
            >
              <option value="top">
                {t("settings.host.toolbarPosition.top")}
              </option>
              <option value="bottom">
                {t("settings.host.toolbarPosition.bottom")}
              </option>
            </Select2>
          </SettingRow>
          <SettingRow
            label={t("settings.host.toolbarLabels.label")}
            description={t("settings.host.toolbarLabels.description")}
            defaultKey="toolbarLabels"
          >
            <Select2
              value={form.toolbarLabels}
              onChange={(event) =>
                setField(
                  "toolbarLabels",
                  event.target.value === "icons" ? "icons" : "labeled",
                )
              }
              className={SELECT}
            >
              <option value="labeled">
                {t("settings.host.toolbarLabels.labeled")}
              </option>
              <option value="icons">
                {t("settings.host.toolbarLabels.icons")}
              </option>
            </Select2>
          </SettingRow>
          <HostDefaultField settingKey="toolbarButtons">
            <div className="flex flex-col gap-2 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {t("settings.host.toolbarButtons.label")}
                    <HostDefaultBadge settingKey="toolbarButtons" />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("settings.host.toolbarButtons.description")}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={
                    layout.order.length === 0 && layout.hidden.length === 0
                  }
                  onClick={() => writeButtons({ order: [], hidden: [] })}
                >
                  <RotateCcw className="size-3.5" />
                  {t("settings.host.toolbarButtons.reset")}
                </Button>
              </div>
              <div className="flex flex-col border border-border">
                {ordered.map((item, index) => {
                  const Icon = item.icon;
                  const visible = !hidden.has(item.id);
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        "flex items-center gap-2 border-b border-border/40 px-2 py-1.5 last:border-b-0",
                        index % 2 === 1 && "bg-muted/15",
                      )}
                    >
                      <div className="flex shrink-0 flex-col">
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                          aria-label={t("settings.host.toolbarButtons.moveUp")}
                          disabled={index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ArrowUp className="size-3" />
                        </button>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                          aria-label={t(
                            "settings.host.toolbarButtons.moveDown",
                          )}
                          disabled={index === ordered.length - 1}
                          onClick={() => move(index, 1)}
                        >
                          <ArrowDown className="size-3" />
                        </button>
                      </div>
                      <div
                        className={cn(
                          "flex min-w-0 flex-1 flex-col gap-0.5",
                          !visible && "opacity-60",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
                          {Icon && (
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="truncate">{t(item.titleKey)}</span>
                        </span>
                        {item.hintKey && (
                          <span className="truncate text-[11px] text-muted-foreground">
                            {t(item.hintKey)}
                          </span>
                        )}
                      </div>
                      <FakeSwitch
                        checked={visible}
                        onChange={(value) => toggle(item.id, value)}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </HostDefaultField>
        </>
      )}
    </SectionCard>
  );
}
