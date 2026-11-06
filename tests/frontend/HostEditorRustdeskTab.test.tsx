import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
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
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    permissions: ["remote-desktop.sessions"],
    api: {
      get: vi.fn(async () => ({ data: { enabled: true } })),
    } as unknown as PluginApiClient,
  });
  await waitFor(() =>
    expect(rendered!.registered.hostEditorSections()).toContain("rustdesk"),
  );
  rendered!.renderHostEditorSection("rustdesk", {
    form: {
      pluginSettings: { "remote-desktop": settings },
      protocolAuth: {},
    },
    protocols: { enableRustdesk: true },
  });
}

describe("RustDesk host editor", () => {
  it("asks for the ID and offers its own server", async () => {
    await renderSection({ enableRustdesk: true, rustdeskId: "123456789" });
    expect(await screen.findByDisplayValue("123456789")).toBeTruthy();
    expect(screen.getByText("RustDesk ID")).toBeTruthy();
    expect(screen.getByText("ID server")).toBeTruthy();
    // Relay and key only show once the host has its own server.
    expect(screen.queryByText("Relay server")).toBeNull();
  });

  it("shows relay and key with an own server", async () => {
    await renderSection({
      enableRustdesk: true,
      rustdeskIdServer: "rs.example.com",
    });
    expect(await screen.findByText("Relay server")).toBeTruthy();
    expect(screen.getByText("Key")).toBeTruthy();
  });

  it("shows the port instead of the ID for direct IP", async () => {
    await renderSection({ enableRustdesk: true, rustdeskDirect: true });
    expect(await screen.findByText("Direct IP port")).toBeTruthy();
    expect(screen.queryByText("RustDesk ID")).toBeNull();
    expect(screen.queryByText("ID server")).toBeNull();
  });
});
