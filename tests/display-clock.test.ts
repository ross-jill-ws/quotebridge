// The display clock (pure): UTC times shown in broker time, this computer's local time or UTC (ADR 11).
import assert from "node:assert/strict";
import { test } from "node:test";
import { clockLabel, displayCandles, displaySeconds, type DisplayClock } from "../src/dashboard/display-clock.js";

const GMT2_US = { winterOffsetMinutes: 120, dst: "us" as const };
/** London: GMT in winter, BST (+1) from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October. */
const london = (utcMs: number) => (utcMs >= Date.UTC(2026, 2, 29, 1) && utcMs < Date.UTC(2026, 9, 25, 1) ? 60 : 0);
const clock = (shown: DisplayClock["shown"], rule: DisplayClock["rule"] = GMT2_US): DisplayClock => ({ shown, rule, localOffsetMinutes: london });
const s = (...parts: [number, number, number, number, number?]) => Date.UTC(...parts) / 1000;

test("broker time follows the broker server's clock rule across its daylight-saving change", () => {
  // The US switch on Sunday 8 March 2026 at 07:00 UTC: GMT+2 before, GMT+3 after.
  assert.equal(displaySeconds(clock("broker"), s(2026, 2, 8, 6, 30)), s(2026, 2, 8, 8, 30));
  assert.equal(displaySeconds(clock("broker"), s(2026, 2, 8, 7, 30)), s(2026, 2, 8, 10, 30));
  // Broker midnight of a D1 bar in summer is 21:00 UTC the day before.
  assert.equal(displaySeconds(clock("broker"), s(2026, 6, 14, 21)), s(2026, 6, 15, 0));
});

test("local time follows this computer's clock, which changes on its own dates", () => {
  // London has not changed yet on 8 March, when the broker has.
  assert.equal(displaySeconds(clock("local"), s(2026, 2, 8, 6, 30)), s(2026, 2, 8, 6, 30));
  assert.equal(displaySeconds(clock("local"), s(2026, 2, 8, 7, 30)), s(2026, 2, 8, 7, 30));
  // It does on 29 March at 01:00 UTC.
  assert.equal(displaySeconds(clock("local"), s(2026, 2, 29, 0, 30)), s(2026, 2, 29, 0, 30));
  assert.equal(displaySeconds(clock("local"), s(2026, 2, 29, 1, 30)), s(2026, 2, 29, 2, 30));
});

test("UTC is shown as it is, whatever the broker's rule", () => {
  for (const rule of [GMT2_US, null]) assert.equal(displaySeconds(clock("utc", rule), s(2026, 2, 8, 7, 30)), s(2026, 2, 8, 7, 30));
});

test("while a broker server's rule is unknown, its broker time is the time the server handed out", () => {
  assert.equal(displaySeconds(clock("broker", null), s(2026, 2, 8, 7, 30)), s(2026, 2, 8, 7, 30));
});

test("candles keep their prices and get display times that always ascend, even through the hour a local clock repeats", () => {
  const candle = (utc: number, close: number) => ({ time: utc, open: close, high: close, low: close, close });
  const shown = displayCandles([candle(s(2026, 2, 8, 6, 59), 1.1), candle(s(2026, 2, 8, 7, 0), 1.2)], clock("broker"));
  assert.deepEqual(shown.map((c) => [c.time, c.close]), [
    [s(2026, 2, 8, 8, 59), 1.1],
    [s(2026, 2, 8, 10, 0), 1.2],
  ]);

  // London falls back at 01:00 UTC on 25 October 2026: 00:59 UTC is 01:59 BST, 01:00 UTC is 01:00 GMT.
  const autumn = displayCandles([candle(s(2026, 9, 25, 0, 59), 1), candle(s(2026, 9, 25, 1, 0), 2), candle(s(2026, 9, 25, 2, 0), 3)], clock("local"));
  const times = autumn.map((c) => c.time);
  assert.ok(times[1] > times[0] && times[2] > times[1], times.join(", "));
  assert.equal(times[2], s(2026, 9, 25, 2, 0));
});

test("each clock has a label for headings and tooltips", () => {
  assert.equal(clockLabel("broker"), "Broker time");
  assert.equal(clockLabel("local"), "Local time");
  assert.equal(clockLabel("utc"), "UTC");
});
