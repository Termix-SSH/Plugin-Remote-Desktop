import { describe, expect, it } from "vitest";
import {
  getGuacamoleDisplaySize,
  readConfiguredDimension,
} from "../../src/frontend/guacamole-display-size";

describe("getGuacamoleDisplaySize", () => {
  it("requests native pixels and matching DPI for HiDPI RDP", () => {
    expect(getGuacamoleDisplaySize(1280, 720, "rdp", 2)).toEqual({
      width: 2560,
      height: 1440,
      dpi: 192,
      pixelRatio: 2,
    });
  });

  it("sends a configured RDP DPI as entered, at CSS pixels", () => {
    expect(getGuacamoleDisplaySize(1000, 600, "rdp", 2, 192)).toEqual({
      width: 1000,
      height: 600,
      dpi: 192,
      pixelRatio: 1,
    });
  });

  it("does not multiply a configured resolution on HiDPI screens", () => {
    expect(
      getGuacamoleDisplaySize(1920, 1080, "rdp", 2, undefined, true),
    ).toEqual({ width: 1920, height: 1080, dpi: 96, pixelRatio: 1 });
  });

  it("leaves non-RDP protocols at CSS-pixel dimensions", () => {
    expect(getGuacamoleDisplaySize(1280, 720, "vnc", 2)).toEqual({
      width: 1280,
      height: 720,
      pixelRatio: 1,
    });
  });

  it("caps pathological pixel ratios to protect remote session size", () => {
    expect(getGuacamoleDisplaySize(400, 800, "rdp", 4)).toEqual({
      width: 1200,
      height: 2400,
      dpi: 288,
      pixelRatio: 3,
    });
  });

  it("uses a configured resolution in place of the container size", () => {
    expect(
      getGuacamoleDisplaySize(800, 600, "rdp", 1, undefined),
    ).toMatchObject({ width: 800, height: 600 });
    expect(
      getGuacamoleDisplaySize(1920, 1080, "rdp", 1, undefined),
    ).toMatchObject({ width: 1920, height: 1080 });
  });
});

describe("readConfiguredDimension", () => {
  it("accepts the strings the host editor stores", () => {
    expect(readConfiguredDimension("1920")).toBe(1920);
    expect(readConfiguredDimension(1080)).toBe(1080);
  });

  it("treats an unset or unusable value as 'follow the container'", () => {
    expect(readConfiguredDimension("")).toBeUndefined();
    expect(readConfiguredDimension(undefined)).toBeUndefined();
    expect(readConfiguredDimension(null)).toBeUndefined();
    expect(readConfiguredDimension("auto")).toBeUndefined();
    expect(readConfiguredDimension("0")).toBeUndefined();
    expect(readConfiguredDimension("-1080")).toBeUndefined();
  });
});
