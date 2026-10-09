import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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
  await rendered?.deactivate();
  rendered = null;
});

function fakeApi() {
  return {
    get: vi.fn(async () => ({
      data: { hostname: "guacd-2", port: 4823, canEdit: false },
    })),
    post: vi.fn(async () => ({ data: {} })),
    put: vi.fn(async (_url: string, body: unknown) => ({
      data: { ...(body as object), canEdit: true },
    })),
    patch: vi.fn(async () => ({ data: {} })),
    delete: vi.fn(async () => ({ data: {} })),
  };
}

async function renderSection(isAdmin: boolean, hostId?: string) {
  const api = fakeApi();
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    isAdmin,
    permissions: ["remote-desktop.sessions"],
    api: api as unknown as PluginApiClient,
  });
  // Host surfaces register once the status check answers.
  await waitFor(() =>
    expect(rendered!.registered.hostEditorSections()).toContain("telnet"),
  );
  rendered!.renderHostEditorSection("telnet", {
    form: { pluginSettings: {}, protocolAuth: {} },
    protocols: { enableTelnet: true },
    ...(hostId ? { host: { id: hostId } } : {}),
  });
  return api;
}

describe("guacd server card", () => {
  it("shows the address read only to a non-admin", async () => {
    const api = await renderSection(false, "7");
    const input = await screen.findByDisplayValue("guacd-2");
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(api.get).toHaveBeenCalledWith("/guacd-host/7");
    expect(
      screen.getByText("Only admins can change the guacd server for a host."),
    ).toBeTruthy();
    expect(screen.queryByText("Save guacd server")).toBeNull();
  });

  it("lets an admin save it", async () => {
    const api = await renderSection(true, "7");
    const input = await screen.findByDisplayValue("guacd-2");
    expect((input as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(input, { target: { value: "guacd-3" } });
    fireEvent.click(screen.getByText("Save guacd server"));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith("/guacd-host/7", {
        hostname: "guacd-3",
        port: 4823,
      }),
    );
  });

  it("asks an admin to save a new host first", async () => {
    await renderSection(true);
    expect(
      await screen.findByText(
        "Save the host first, then set its guacd server here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Save guacd server")).toBeNull();
  });
});
