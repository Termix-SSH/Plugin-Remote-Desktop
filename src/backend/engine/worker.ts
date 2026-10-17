import { parentPort, workerData } from "node:worker_threads";
import type { FromWorker, ToWorker } from "./messages.js";
import { EngineCore } from "./worker/core.js";
import { CLIENTS } from "./worker/clients.js";
import { loadWasm } from "./worker/wasm.js";

// Entry of dist/workers/engine.js: one remote desktop session per worker.
const port = parentPort;
if (port) {
  const wasm = loadWasm((workerData as { wasm: WebAssembly.Module }).wasm);
  const core = new EngineCore(
    { post: (message: FromWorker) => port.postMessage(message) },
    wasm,
    CLIENTS,
  );
  port.on("message", (message: ToWorker) => {
    core.handle(message);
    if (message.t === "stop") setTimeout(() => process.exit(0), 200);
  });
}
