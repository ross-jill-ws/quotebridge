// The engine's worker thread: runs one package at a time in the sandbox and answers with its outputs or the reason it
// failed. It keeps package code off the utility process's main thread, so a busy package never blocks quotes or HTTP.
import { parentPort } from "node:worker_threads";
import { runInSandbox, type SandboxResult } from "./sandbox.js";
import type { WorkerRequest } from "./engine.js";

parentPort!.on("message", async ({ id, manifest, code, bars, parameters }: WorkerRequest) => {
  let result: SandboxResult;
  try {
    result = await runInSandbox(manifest, code, bars, parameters);
  } catch (e) {
    result = { ok: false, reason: `The calculation failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  parentPort!.postMessage({ id, result });
});
