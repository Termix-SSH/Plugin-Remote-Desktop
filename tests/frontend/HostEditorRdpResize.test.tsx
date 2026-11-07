import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginApiClient } from "@termix-ssh/plugin-sdk/frontend";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  cleanup();
  await rendered?.deactivate();
  rendered = null;
});

async function renderSection(settings: Record<string, unknown>) {
  const updateForm = vi.fn();
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    permissions: ["remote-desktop.sessions"],
    api: {
      get: vi.fn(async () => ({ data: { enabled: true } })),
    } as unknown as PluginApiClient,
  });
  await waitFor(() =>
    expect(rendered!.registered.hostEditorSections()).toContain("rdp"),
  );
  rendered!.renderHostEditorSection("rdp", {
    form: {
      pluginSettings: { "remote-desktop": settings },
      protocolAuth: {},
    },
    protocols: { enableRdp: true },
    updateForm,
  });
  return updateForm;
}

describe("RDP host editor", () => {
  it("offers automatic resizing in display settings", async () => {
    const updateForm = await renderSection({ enableRdp: true });
    expect(await screen.findByText("Automatically resize RDP")).toBeTruthy();
    expect(
      screen.getByText(/keep the size chosen at connection until reconnecting/),
    ).toBeTruthy();
    const row = screen
      .getByText("Automatically resize RDP")
      .closest("[data-setting-row]")!;
    const toggle = within(row as HTMLElement).getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    const patch = updateForm.mock.calls[0][0];
    expect(
      patch({ pluginSettings: { "remote-desktop": { enableRdp: true } } }),
    ).toEqual({
      pluginSettings: {
        "remote-desktop": { enableRdp: true, rdpAutoResize: false },
      },
    });
  });

  it("renders a saved opt-out as off", async () => {
    await renderSection({ enableRdp: true, rdpAutoResize: false });
    const row = screen
      .getByText("Automatically resize RDP")
      .closest("[data-setting-row]")!;
    expect(
      within(row as HTMLElement)
        .getByRole("switch")
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});
