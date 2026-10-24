// The eight bundled packages against MetaTrader 4's own Data Window: EURUSD H1 on EasyForex-Demo, three closed bars
// on 2026-10-23, each indicator at the package's defaults. The fixture holds the 900 closed bars the app calculated
// from; MT4 calculated from its whole chart history. Each value must read as MT4 shows it, to MT4's own digits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { bundledPackages, IndicatorEngine, type RunResult } from "../src/server/indicators/index.js";

const engine = new IndicatorEngine();
test.after(() => engine.close());

const packages = await bundledPackages();
const fixture: { bars: [number, number, number, number][] } = JSON.parse(
  await readFile(new URL("./fixtures/eurusd-h1-mt4-parity.json", import.meta.url), "utf8"),
);
const bars = fixture.bars.map(([time, high, low, close]) => ({ time, high, low, close }));

/** A bar's time on the broker clock, in seconds, from MT4's Data Window label "2026.10.23 10:00". */
const dataWindowTime = (label: string) => Date.UTC(+label.slice(0, 4), +label.slice(5, 7) - 1, +label.slice(8, 10), +label.slice(11, 13), +label.slice(14, 16)) / 1000;
const CHECKED_TIMES = ["2026.10.23 10:00", "2026.10.23 14:00", "2026.10.23 18:00"].map(dataWindowTime);

/** A bundled package over the fixture, at its default parameters. */
async function run(id: string): Promise<RunResult> {
  const pkg = packages.find((p) => p.manifest.id === id)!;
  return engine.run(pkg, bars, Object.fromEntries(pkg.manifest.parameters.map((p) => [p.id, p.default])));
}

/** One output's points at the three checked bars. */
function checked(result: RunResult, output: string) {
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return CHECKED_TIMES.map((time) => result.outputs[output].find((p) => p.time === time)!);
}

/** One output at the three checked bars, as text to MT4's digits for it. */
const shown = (result: RunResult, output: string, digits: number) => checked(result, output).map((p) => p.value!.toFixed(digits));

test("the fixture holds the three bars as MT4 shows them", () => {
  assert.deepEqual(
    CHECKED_TIMES.map((time) => bars.find((b) => b.time === time)),
    [
      { time: CHECKED_TIMES[0], high: 1.12045, low: 1.11933, close: 1.11951 },
      { time: CHECKED_TIMES[1], high: 1.12074, low: 1.11964, close: 1.12035 },
      { time: CHECKED_TIMES[2], high: 1.1195, low: 1.11905, close: 1.11928 },
    ],
  );
});

// Each expected row is MT4's Data Window at 10:00, 14:00 and 18:00.
test("Moving average 20, simple, on the close: MA(20)", async () => {
  assert.deepEqual(shown(await run("quotebridge.ma"), "ma", 5), ["1.12120", "1.12080", "1.12033"]);
});

test("RSI 14: RSI(14)", async () => {
  assert.deepEqual(shown(await run("quotebridge.rsi"), "rsi", 4), ["38.3377", "46.7283", "41.0108"]);
});

test("Bollinger 20, 2: Bands(20) Upper and Lower, around a middle line that MT4 doesn't show but is MA(20)", async () => {
  const result = await run("quotebridge.bollinger");
  assert.deepEqual(shown(result, "upper", 5), ["1.12309", "1.12274", "1.12223"]);
  assert.deepEqual(shown(result, "lower", 5), ["1.11931", "1.11886", "1.11844"]);
  assert.deepEqual(shown(result, "middle", 5), ["1.12120", "1.12080", "1.12033"]);
});

test("Alligator 13/8, 8/5, 5/3: Gator Jaws, Teeth and Lips, shifted", async () => {
  const result = await run("quotebridge.alligator");
  assert.deepEqual(shown(result, "jaw", 5), ["1.12198", "1.12175", "1.12120"]);
  assert.deepEqual(shown(result, "teeth", 5), ["1.12157", "1.12091", "1.12046"]);
  assert.deepEqual(shown(result, "lips", 5), ["1.12113", "1.12018", "1.12010"]);
});

test("MACD 12, 26, 9: MACD(12,26,9) and Signal", async () => {
  const result = await run("quotebridge.macd");
  assert.deepEqual(shown(result, "macd", 6), ["-0.000655", "-0.000571", "-0.000616"]);
  assert.deepEqual(shown(result, "signal", 6), ["-0.000430", "-0.000578", "-0.000621"]);
});

test("AO: AO", async () => {
  assert.deepEqual(shown(await run("quotebridge.ao"), "ao", 6), ["-0.001770", "-0.001451", "-0.001147"]);
});

test("AC: AC, to MT4's seven places", async () => {
  assert.deepEqual(shown(await run("quotebridge.ac"), "ac", 7), ["-0.0003575", "0.0003361", "0.0000766"]);
});

test("EO 5, 34, 1: EO, with the histogram rising where MT4 sets Value 2 (Positive) and falling where it sets Value 3 (Negative)", async () => {
  const result = await run("quotebridge.eo");
  assert.deepEqual(shown(result, "eo", 6), ["-0.001464", "-0.001108", "-0.001218"]);
  assert.deepEqual(shown(result, "histogram", 6), ["-0.001464", "-0.001108", "-0.001218"]);
  assert.deepEqual(checked(result, "histogram").map((p) => p.styleKey), ["falling", "rising", "falling"]);
});
