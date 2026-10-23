// The indicator engine (ADR 12): its one call takes a package, bars and parameters, and returns each output's values
// per bar, or the reason it failed. Runs go one at a time to a worker thread, where the package runs in QuickJS
// (sandbox.ts). After a timeout the worker is replaced, and a worker that stops answering is too.
import { Worker } from "node:worker_threads";
import type { Manifest, ParameterValues } from "../../shared/indicator-manifest.js";
import type { IndicatorPackage } from "./packages.js";
import type { IndicatorBar, OutputPoint, SandboxResult } from "./sandbox.js";

/** Each output's values per bar, or why there are none. */
export type RunResult = { ok: true; outputs: Record<string, OutputPoint[]> } | { ok: false; reason: string };

/** A run as the worker thread gets it. */
export type WorkerRequest = { id: number; manifest: Manifest; code: string; bars: readonly IndicatorBar[]; parameters: ParameterValues };

/** A run with no answer by then means the worker itself is stuck (not the package, which QuickJS interrupts). */
const WORKER_STUCK_MS = 10_000;

/**
 * The worker beside this module, with its extension: the TypeScript source under tsx (tests), the compiled .js once
 * built, and the dev run's bundled .mjs (scripts/dev/dev.ts builds it beside the server's bundle).
 */
const WORKER_URL = new URL(`./sandbox-worker${import.meta.url.match(/\.[cm]?[jt]s$/)![0]}`, import.meta.url);

/** Runs packages one at a time in a sandboxed worker thread; `close` stops it. */
export class IndicatorEngine {
  private worker?: Worker;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 0;
  private closed = false;

  /** The package's outputs over `bars` (oldest first) with these parameters, or why there are none. */
  run(pkg: IndicatorPackage, bars: readonly IndicatorBar[], parameters: ParameterValues): Promise<RunResult> {
    const run = this.queue.then(() => this.send(pkg, bars, parameters));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private send(pkg: IndicatorPackage, bars: readonly IndicatorBar[], parameters: ParameterValues): Promise<RunResult> {
    if (this.closed) return Promise.resolve({ ok: false, reason: "The app is closing." });
    const worker = (this.worker ??= this.spawn());
    const id = ++this.nextId;
    return new Promise<RunResult>((resolve) => {
      const done = (result: SandboxResult) => {
        clearTimeout(stuck);
        worker.off("message", onMessage);
        worker.off("exit", onExit);
        if (!result.ok && result.timedOut) this.replace(worker);
        resolve(result.ok ? result : { ok: false, reason: result.reason });
      };
      const onMessage = (message: { id: number; result: SandboxResult }) => message.id === id && done(message.result);
      const onExit = () => {
        if (this.worker === worker) this.worker = undefined;
        done({ ok: false, reason: "The calculation stopped unexpectedly." });
      };
      // Replaced like a timeout: the worker may be running yet.
      const stuck = setTimeout(() => done({ ok: false, reason: "The calculation stopped answering.", timedOut: true }), WORKER_STUCK_MS);
      worker.on("message", onMessage);
      worker.on("exit", onExit);
      worker.postMessage({ id, manifest: pkg.manifest, code: pkg.code, bars, parameters } satisfies WorkerRequest);
    });
  }

  private spawn(): Worker {
    const worker = new Worker(WORKER_URL);
    // Nothing waits on an idle worker: the process may exit around it.
    worker.unref();
    worker.on("error", (e) => console.error("The indicator worker failed", e));
    return worker;
  }

  private replace(worker: Worker) {
    if (this.worker === worker) this.worker = undefined;
    void worker.terminate();
  }

  /** Stops the worker at once: a run under way fails, and later ones are refused. */
  async close() {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    await worker?.terminate();
  }
}
