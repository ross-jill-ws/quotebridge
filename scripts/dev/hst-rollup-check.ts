// Read-only check of the app's period bucketing against MetaTrader's own HST files: for each symbol in a terminal's
// history folder, every period file is compared bar for bar with the bars rolled up from each finer file that can fill it
// (D1 for W1 and MN1, M1 for the rest), over the range both cover. Back a spec claim that something "matches MetaTrader"
// with its output. Usage: npx tsx scripts/dev/hst-rollup-check.ts "<data folder>\history\<broker server>" [...]
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PERIOD_MINUTES } from "../../src/server/history/chart-history.js";
import { HstFile, type HstBar } from "../../src/server/history/hst-file.js";
import { bucketStart, PERIODS, type Period } from "../../src/shared/periods.js";

type Bar = Pick<HstBar, "time" | "open" | "high" | "low" | "close">;

async function bars(path: string): Promise<HstBar[]> {
  const file = await HstFile.open(path);
  const out: HstBar[] = [];
  if (file) for await (const page of file.pages()) out.push(...page);
  return out;
}

/** The finer bars rolled up into the period's buckets, keyed by bucket start. */
function rollUp(finer: readonly HstBar[], period: Period): Map<number, Bar> {
  const buckets = new Map<number, Bar>();
  for (const b of finer) {
    const time = bucketStart(b.time, period);
    const w = buckets.get(time);
    buckets.set(time, w ? { time, open: w.open, high: Math.max(w.high, b.high), low: Math.min(w.low, b.low), close: b.close } : { time, open: b.open, high: b.high, low: b.low, close: b.close });
  }
  return buckets;
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const same = (a: Bar, b: Bar) => a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;

for (const folder of process.argv.slice(2)) {
  const names = new Set(readdirSync(folder).filter((n) => n.endsWith(".hst")));
  const symbols = new Set([...names].map((n) => n.replace(/\d+\.hst$/, "")));
  for (const symbol of [...symbols].sort()) {
    const has = (p: Period) => names.has(`${symbol}${PERIOD_MINUTES[p]}.hst`);
    for (const period of PERIODS) {
      if (period === "M1" || !has(period)) continue;
      const own = await bars(join(folder, `${symbol}${PERIOD_MINUTES[period]}.hst`));
      for (const fill of period === "W1" || period === "MN1" ? (["D1", "M1"] as const) : (["M1"] as const)) {
        if (!has(fill) || !own.length) continue;
        const rolled = rollUp(await bars(join(folder, `${symbol}${PERIOD_MINUTES[fill]}.hst`)), period);
        const starts = [...rolled.keys()];
        if (!starts.length) continue;
        // The first and last rolled buckets may be partial (the finer file starts or ends inside them), and the own file's
        // last bar may have been written while it was still forming.
        const common = own.slice(0, -1).filter((b) => b.time > starts[0] && b.time < starts.at(-1)!);
        const misses = common.filter((b) => !rolled.has(b.time) || !same(rolled.get(b.time)!, b));
        const first = misses[0];
        const detail = first ? `; first difference ${day(first.time)}: own ${[first.open, first.high, first.low, first.close].join("/")}, rolled ${rolled.get(first.time) ? [rolled.get(first.time)!.open, rolled.get(first.time)!.high, rolled.get(first.time)!.low, rolled.get(first.time)!.close].join("/") : "none"}` : "";
        console.log(`${symbol} ${period} from ${fill}: ${common.length - misses.length}/${common.length} match${detail}`);
      }
    }
  }
}
