import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
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

function statusApi(status: string, enabled = true) {
  return {
    get: async () => ({
      data: {
        enabled,
        guacd: { status, host: "guacd", port: 4822 },
      },
    }),
  } as never;
}

describe("guacd onboarding step", () => {
  it("adds an admin setup step while remote desktop is on", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: statusApi("connected"),
    });
    await vi.waitFor(() =>
      expect(rendered!.registered.onboardingSteps()).toEqual(["guacd"]),
    );
  });

  it("adds no step while an admin has turned remote desktop off", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: statusApi("disconnected", false),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rendered.registered.onboardingSteps()).toEqual([]);
  });

  it("says where guacd answers", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: statusApi("connected"),
    });
    await vi.waitFor(() =>
      expect(rendered!.registered.onboardingSteps()).toEqual(["guacd"]),
    );
    const step = rendered.renderOnboardingStep("guacd");
    expect(
      await screen.findByText("guacd is running at guacd:4822"),
    ).toBeTruthy();
    expect(step.canContinue()).toBe(true);
    expect(await step.next()).toBe(true);
  });

  it("explains what to do when guacd is missing, without blocking", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      api: statusApi("disconnected"),
    });
    await vi.waitFor(() =>
      expect(rendered!.registered.onboardingSteps()).toEqual(["guacd"]),
    );
    const step = rendered.renderOnboardingStep("guacd");
    expect(
      await screen.findByText("guacd is not answering at guacd:4822"),
    ).toBeTruthy();
    expect(screen.getByText(/guacamole\/guacd/)).toBeTruthy();
    expect(step.canContinue()).toBe(true);
  });
});
