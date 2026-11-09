import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
  vi.restoreAllMocks();
});

const PC = {
  id: 5,
  name: "gaming",
  address: "10.0.0.9",
  port: 47989,
  paired: false,
  online: true,
};

type Reply = { data: unknown } | Error;

function apiFor(routes: Record<string, () => Reply>) {
  const respond = async (method: string, path: string) => {
    if (path === "/status") return { data: { enabled: true } };
    const reply = routes[`${method} ${path}`];
    if (!reply) return { data: { enabled: true } };
    const result = reply();
    if (result instanceof Error) throw result;
    return result;
  };
  return {
    get: vi.fn((path: string) => respond("GET", path)),
    post: vi.fn((path: string) => respond("POST", path)),
  } as unknown as PluginApiClient;
}

function refused(code: string, message = "Refused") {
  return Object.assign(new Error(message), {
    response: { data: { error: message, code } },
  });
}

async function activate(
  routes: Record<string, () => Reply>,
  permissions = ["remote-desktop.sessions", "remote-desktop.moonlight"],
) {
  rendered = await renderWithApp(plugin, {
    manifest,
    locales,
    permissions,
    api: apiFor(routes),
  });
  await waitFor(() =>
    expect(rendered!.registered.hostEditorSections()).toContain("moonlight"),
  );
  return rendered;
}

function section(settings: Record<string, unknown>) {
  rendered!.renderHostEditorSection("moonlight", {
    form: {
      ip: "10.0.0.9",
      pluginSettings: { "remote-desktop": settings },
      protocolAuth: {},
    },
    protocols: { enableMoonlight: true },
  });
}

const READY = {
  "GET /moonlight/status": () => ({
    data: { configured: true, reachable: true },
  }),
};

describe("Moonlight host editor", () => {
  it("says when no server is set up", async () => {
    await activate({
      "GET /moonlight/status": () => ({
        data: { configured: false, reachable: false },
      }),
    });
    section({ enableMoonlight: true });

    expect(
      await screen.findByText(locales.hosts.moonlight.notConfigured),
    ).toBeTruthy();
  });

  it("offers to add this host when Moonlight Web lacks it", async () => {
    await activate({
      ...READY,
      "GET /moonlight/hosts": () => ({ data: { hosts: [] } }),
    });
    section({ enableMoonlight: true });

    expect(
      await screen.findByText("Add this host to Moonlight Web"),
    ).toBeTruthy();
  });

  it("hides set up from users without the permission", async () => {
    await activate(
      {
        ...READY,
        "GET /moonlight/hosts": () => ({ data: { hosts: [PC] } }),
      },
      ["remote-desktop.sessions"],
    );
    section({ enableMoonlight: true, moonlightHostId: 5 });

    expect(
      await screen.findByText(locales.hosts.moonlight.noSetUpAccess),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pair" })).toBeNull();
  });

  it("shows the PIN after pair is pressed", async () => {
    await activate({
      ...READY,
      "GET /moonlight/hosts": () => ({ data: { hosts: [PC] } }),
      "POST /moonlight/hosts/5/pair": () => ({
        data: { id: "job-1", pin: "4321" },
      }),
      "GET /moonlight/pair/job-1": () => ({ data: { state: "waiting" } }),
    });
    section({ enableMoonlight: true, moonlightHostId: 5 });

    fireEvent.click(await screen.findByRole("button", { name: "Pair" }));

    expect(await screen.findByText("PIN 4321")).toBeTruthy();
  });

  it("lists apps once the PC is paired", async () => {
    await activate({
      ...READY,
      "GET /moonlight/hosts": () => ({
        data: { hosts: [{ ...PC, paired: true }] },
      }),
      "GET /moonlight/hosts/5/apps": () => ({
        data: { apps: [{ id: 7, title: "Steam Big Picture" }] },
      }),
    });
    section({ enableMoonlight: true, moonlightHostId: 5 });

    expect(await screen.findByText("Steam Big Picture")).toBeTruthy();
  });
});

describe("Moonlight tab", () => {
  const STREAM_LOCAL = "https://moonlight.example.com/stream.html?hostId=5";

  function tab() {
    rendered!.renderTab("moonlight", {
      host: { id: 1, name: "gaming" },
      tab: { id: 1, type: "moonlight" },
      isVisible: true,
    });
  }

  it("opens a stream in a new window after a click", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await activate({
      "POST /moonlight/launch/1": () => ({
        data: { url: STREAM_LOCAL, app: "Desktop" },
      }),
    });
    tab();

    fireEvent.click(await screen.findByRole("button", { name: "Open stream" }));

    expect(open).toHaveBeenCalledWith(STREAM_LOCAL, "_blank", "noopener");
  });

  it("shows a plain message for a known refusal", async () => {
    await activate({
      "POST /moonlight/launch/1": () => refused("not-paired"),
    });
    tab();

    expect(
      await screen.findByText(locales.hosts.moonlight.errorNotPaired),
    ).toBeTruthy();
  });

  it("offers Request access when a host needs approval", async () => {
    await activate({
      "POST /moonlight/launch/1": () =>
        Object.assign(new Error("Approval needed"), {
          response: {
            data: {
              error: "Approval needed",
              code: "access-required",
              requestTab: "privileged-access",
            },
          },
        }),
    });
    tab();

    expect(await screen.findByText("Approval needed")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /request access/i }),
    ).toBeTruthy();
  });
});
