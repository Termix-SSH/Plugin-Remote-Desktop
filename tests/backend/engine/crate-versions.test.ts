import fs from "node:fs";
import { describe, expect, it } from "vitest";

const lock = fs.readFileSync(
  new URL("../../../native/engine/Cargo.lock", import.meta.url),
  "utf8",
);

function versionsOf(name: string): number[][] {
  const re = new RegExp(`name = "${name}"\nversion = "([^"]+)"`, "g");
  return [...lock.matchAll(re)].map((m) => m[1].split(".").map(Number));
}

function atLeast(found: number[], min: number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    if ((found[i] ?? 0) !== min[i]) return (found[i] ?? 0) > min[i];
  }
  return true;
}

describe("engine crates with security fixes", () => {
  it.each([
    ["crypto-bigint", [0, 7, 6]],
    ["ctutils", [0, 4, 4]],
    ["libz-sys", [1, 1, 31]],
  ])("%s is at least the fixed release", (name, min) => {
    const found = versionsOf(name);
    expect(found.length).toBeGreaterThan(0);
    for (const version of found) expect(atLeast(version, min)).toBe(true);
  });
});
