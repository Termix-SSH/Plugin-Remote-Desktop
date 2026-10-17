import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** A hash of everything the WASM module is built from. */
export function engineSourceHash(crate) {
  const files = ["Cargo.toml", "Cargo.lock", ".cargo/config.toml"];
  const walk = (dir) => {
    for (const name of fs.readdirSync(path.join(crate, dir)).sort()) {
      const rel = path.posix.join(dir, name);
      if (fs.statSync(path.join(crate, rel)).isDirectory()) walk(rel);
      else if (name.endsWith(".rs")) files.push(rel);
    }
  };
  walk("src");
  const hash = crypto.createHash("sha256");
  for (const rel of files) {
    hash.update(rel);
    // Line endings differ between checkouts, the code doesn't.
    hash.update(
      fs.readFileSync(path.join(crate, rel), "utf8").replace(/\r\n/g, "\n"),
    );
  }
  return hash.digest("hex");
}
