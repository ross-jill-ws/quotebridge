// One package run in QuickJS (ADR 12), inside the engine's worker thread: a fresh runtime per run with a 32 MiB heap and
// a 500 ms deadline, no Date or Math.random (QuickJS has no network, files or modules to begin with). The package's code
// never runs outside QuickJS. What it returns is checked against its manifest and the bars before anyone sees it.
import { newQuickJSWASMModuleFromVariant, DefaultIntrinsics, type QuickJSWASMModule } from "quickjs-emscripten-core";
import type { Manifest } from "../../shared/indicator-manifest.js";

export const RUN_LIMIT_MS = 500;
export const MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;
const STACK_BYTES = 1024 * 1024;
/** The most bars one run takes. */
export const MAX_BARS = 50_000;

/** A bar as a package's source is made from (UTC seconds). */
export type IndicatorBar = { time: number; high: number; low: number; close: number };
/** An output's value at a bar, null where it has none; `styleKey` picks a colour from the output's palette. */
export type OutputPoint = { time: number; value: number | null; styleKey?: string };
/** A run's outputs, or why it failed; `timedOut` when the deadline stopped it. */
export type SandboxResult = { ok: true; outputs: Record<string, OutputPoint[]> } | { ok: false; reason: string; timedOut?: boolean };

const TOO_SLOW = `The calculation took longer than ${RUN_LIMIT_MS} ms.`;
const OUT_OF_MEMORY = `The calculation ran out of memory (${MEMORY_LIMIT_BYTES / 1024 / 1024} MiB).`;

let module: Promise<QuickJSWASMModule> | undefined;

/** Runs the package's code over `bars` (oldest first) with these parameters, in a QuickJS runtime of its own. */
export async function runInSandbox(manifest: Manifest, code: string, bars: readonly IndicatorBar[], parameters: Record<string, number | string>): Promise<SandboxResult> {
  if (bars.length > MAX_BARS) return { ok: false, reason: `A run takes at most ${MAX_BARS} bars.` };
  const median = manifest.inputs[0].field === "median";
  const timeline = bars.map((b) => b.time);
  const context = {
    inputs: { source: { kind: "numeric", points: bars.map((b) => ({ time: b.time, value: median ? (b.high + b.low) / 2 : b.close })) } },
    parameters,
    timeline,
    asOf: timeline.at(-1) ?? 0,
  };
  const quickjs = await (module ??= newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-wasmfile-release-sync")));
  const runtime = quickjs.newRuntime();
  let answer: string;
  try {
    runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
    runtime.setMaxStackSize(STACK_BYTES);
    const deadline = Date.now() + RUN_LIMIT_MS;
    let interrupted = false;
    runtime.setInterruptHandler(() => (interrupted ||= Date.now() > deadline));
    const vm = runtime.newContext({ intrinsics: { ...DefaultIntrinsics, Date: false } });
    try {
      const input = vm.newString(JSON.stringify(context));
      vm.setProp(vm.global, "__input", input);
      input.dispose();
      const result = vm.evalCode(`(() => {
        const input = globalThis.__input;
        delete globalThis.__input;
        const encode = JSON.stringify, parse = JSON.parse;
        Math.random = undefined;
        const entry = {};
        ((exports) => { ${code}\n })(entry);
        if (typeof entry.calculate !== "function") throw new Error("calculate.js exports no calculate function");
        return encode(entry.calculate(parse(input)), (key, value) => (typeof value === "number" && !Number.isFinite(value) ? "non-finite" : value));
      })()`);
      if (result.error) {
        const error = vm.dump(result.error) as { name?: string; message?: string } | string;
        result.error.dispose();
        const message = typeof error === "object" && error !== null ? String(error.message ?? error.name ?? "") : String(error);
        if (interrupted) return { ok: false, reason: TOO_SLOW, timedOut: true };
        if (/out of memory/i.test(message)) return { ok: false, reason: OUT_OF_MEMORY };
        return { ok: false, reason: `The calculation threw: ${message.slice(0, 300)}` };
      }
      const value = vm.dump(result.value);
      result.value.dispose();
      if (typeof value !== "string") return invalid("calculate returned nothing that can be read as outputs.");
      answer = value;
    } finally {
      vm.dispose();
    }
  } catch (e) {
    // QuickJS itself gave up (its memory, most likely).
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: /memory/i.test(message) ? OUT_OF_MEMORY : `The calculation failed: ${message.slice(0, 300)}` };
  } finally {
    try {
      runtime.dispose();
    } catch {
      // A runtime left mid-allocation by an out-of-memory error may not free cleanly; the next run makes its own.
    }
  }
  return checked(manifest, timeline, JSON.parse(answer));
}

const invalid = (detail: string): SandboxResult => ({ ok: false, reason: `Invalid output: ${detail}` });

/** The outputs, when they are the manifest's, at the bars' times in order, with finite values and known style keys. */
function checked(manifest: Manifest, timeline: readonly number[], parsed: unknown): SandboxResult {
  const outputs = (parsed as { outputs?: unknown } | null)?.outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return invalid("calculate must return { outputs }.");
  const ids = manifest.outputs.map((o) => o.id);
  const returned = Object.keys(outputs);
  if (returned.length !== ids.length || !ids.every((id) => returned.includes(id))) return invalid(`the outputs must be ${ids.join(", ")}, as the manifest lists them.`);
  const times = new Set(timeline);
  const out: Record<string, OutputPoint[]> = {};
  for (const o of manifest.outputs) {
    const points = (outputs as Record<string, unknown>)[o.id];
    if (!Array.isArray(points) || points.length > timeline.length) return invalid(`${o.id} must be a list of points, at most one per bar.`);
    let previous = -Infinity;
    const list: OutputPoint[] = [];
    for (const point of points as unknown[]) {
      const p = point as Partial<OutputPoint> | null;
      if (!p || typeof p !== "object" || typeof p.time !== "number" || !times.has(p.time) || p.time <= previous) return invalid(`each point of ${o.id} must be at a bar's time, in order.`);
      if (p.value !== null && (typeof p.value !== "number" || !Number.isFinite(p.value))) return invalid(`${o.id} at ${p.time} has a value that is not a finite number or null.`);
      if (p.styleKey !== undefined && (typeof p.styleKey !== "string" || !o.palette || !Object.hasOwn(o.palette, p.styleKey))) return invalid(`${o.id} at ${p.time} has a styleKey its palette does not list.`);
      previous = p.time;
      list.push(p.styleKey === undefined ? { time: p.time, value: p.value } : { time: p.time, value: p.value, styleKey: p.styleKey });
    }
    out[o.id] = list;
  }
  return { ok: true, outputs: out };
}
