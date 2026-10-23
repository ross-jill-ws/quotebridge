import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rejection } from "../src/server/bridge/index.js";
import { rejectionLogger } from "../scripts/dev/rejection-log.js";
import { FakeClock } from "./fake-ea.js";

const rejection = (reason: string, route = "chart-new"): Rejection => ({
  time: 0,
  reason,
  route,
  excerpt: "T|1|chart-old|7,1.1,1.1002,1700000000,1700000001",
  feed: '["mt4-0123456789ab","EURUSD"]',
});

test("a repeating rejection logs one line per reason and route every few seconds, counting the ones it held back", () => {
  const clock = new FakeClock();
  const lines: string[] = [];
  const log = rejectionLogger({ log: (line) => lines.push(line), now: clock.now, intervalMs: 5000 });

  log(rejection("Routing identity mismatch"));
  for (let i = 0; i < 9; i++) {
    clock.advance(500);
    log(rejection("Routing identity mismatch"));
  }
  log(rejection("Invalid quote")); // another reason: its own line
  log(rejection("Routing identity mismatch", "chart-other")); // another route: its own line
  clock.advance(500);
  log(rejection("Routing identity mismatch"));

  assert.deepEqual(lines, [
    'EA message rejected (Routing identity mismatch) from route chart-new, feed ["mt4-0123456789ab","EURUSD"]: T|1|chart-old|7,1.1,1.1002,1700000000,1700000001',
    'EA message rejected (Invalid quote) from route chart-new, feed ["mt4-0123456789ab","EURUSD"]: T|1|chart-old|7,1.1,1.1002,1700000000,1700000001',
    'EA message rejected (Routing identity mismatch) from route chart-other, feed ["mt4-0123456789ab","EURUSD"]: T|1|chart-old|7,1.1,1.1002,1700000000,1700000001',
    'EA message rejected (Routing identity mismatch) from route chart-new, feed ["mt4-0123456789ab","EURUSD"]: T|1|chart-old|7,1.1,1.1002,1700000000,1700000001 (+9 more since the last line)',
  ]);
});

test("a rejection from an unknown route says so", () => {
  const lines: string[] = [];
  rejectionLogger({ log: (line) => lines.push(line) })({ ...rejection("Unknown message", "chart-stranger"), feed: null, excerpt: "Z|1|chart-stranger|what" });

  assert.deepEqual(lines, ["EA message rejected (Unknown message) from route chart-stranger, no known feed: Z|1|chart-stranger|what"]);
});
