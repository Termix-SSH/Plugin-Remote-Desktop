import { describe, expect, it, vi } from "vitest";
import { bindAudioUnlock } from "../../src/frontend/guacamole-audio";

describe("Guacamole audio activation", () => {
  it("resumes on session input, retries rejection, and removes listeners", async () => {
    const element = document.createElement("div");
    const resume = vi
      .fn()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValue(undefined);
    const getContext = vi.fn(
      () => ({ state: "suspended", resume }) as unknown as AudioContext,
    );
    const unbind = bindAudioUnlock(element, getContext);
    expect(getContext).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("pointerup"));
    expect(resume).not.toHaveBeenCalled();
    element.dispatchEvent(new Event("pointerup"));
    await Promise.resolve();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(resume).toHaveBeenCalledTimes(2);
    unbind();
    element.dispatchEvent(new Event("pointerup"));
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it("does not resume running, closed, or unavailable contexts", () => {
    const element = document.createElement("div");
    const resume = vi.fn();
    for (const state of ["running", "closed", null]) {
      const unbind = bindAudioUnlock(element, () =>
        state ? ({ state, resume } as unknown as AudioContext) : null,
      );
      element.dispatchEvent(new Event("pointerup"));
      unbind();
    }
    expect(resume).not.toHaveBeenCalled();
  });
});
