import { describe, expect, it } from "vitest";
import {
  arrangeButtons,
  countFittingButtons,
  readButtonLayout,
  readToolbarValues,
  visibleButtons,
} from "../../src/frontend/toolbar-settings.js";

const items = ["a", "b", "c", "d"].map((id) => ({ id }));

describe("toolbar settings", () => {
  it("reads the host values with defaults", () => {
    expect(readToolbarValues({})).toEqual({
      position: "top",
      labels: "labeled",
      buttons: { order: [], hidden: [] },
    });
    expect(
      readToolbarValues({
        toolbarPosition: "bottom",
        toolbarLabels: "icons",
        toolbarButtons: '{"order":["b"],"hidden":["c",1]}',
      }),
    ).toEqual({
      position: "bottom",
      labels: "icons",
      buttons: { order: ["b"], hidden: ["c"] },
    });
    expect(readButtonLayout("not json")).toEqual({ order: [], hidden: [] });
  });

  it("orders saved buttons first and keeps new ones at the end", () => {
    const layout = { order: ["c", "a"], hidden: ["d"] };
    expect(arrangeButtons(items, layout).map((i) => i.id)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(visibleButtons(items, layout).map((i) => i.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("counts what fits, saving room for the More menu", () => {
    expect(countFittingButtons([10, 10, 10], 30, 8)).toBe(3);
    expect(countFittingButtons([10, 10, 10], 29, 8)).toBe(2);
    expect(countFittingButtons([10, 10, 10], 5, 8)).toBe(0);
  });
});
