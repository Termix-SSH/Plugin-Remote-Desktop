// Builds native/engine (Rust) into the WASM module the backend ships.
// Needs rustup with the wasm32-unknown-unknown target and wasm-bindgen-cli
// at the version Cargo.toml pins. The output is committed, so plugin CI and
// anyone not touching the Rust code never need a Rust toolchain.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { engineSourceHash } from "./engine-hash.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crate = path.join(root, "native", "engine");
const out = path.join(root, "src", "backend", "engine", "wasm");

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false });
  if (result.status !== 0) {
    console.error(`${cmd} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}

run("cargo", ["build", "--release", "--locked"], crate);

const wasm = path.join(
  crate,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "termix_rd_engine.wasm",
);
fs.mkdirSync(out, { recursive: true });
run(
  "wasm-bindgen",
  [wasm, "--target", "web", "--out-dir", out, "--out-name", "engine"],
  root,
);
// Only engine.d.ts is needed; the backend imports the module as bytes.
fs.rmSync(path.join(out, "engine_bg.wasm.d.ts"), { force: true });

fs.writeFileSync(
  path.join(out, "source-hash.txt"),
  `${engineSourceHash(crate)}\n`,
);
const size = fs.statSync(path.join(out, "engine_bg.wasm")).size;
console.log(`engine.wasm ${(size / 1024 / 1024).toFixed(2)} MB`);
