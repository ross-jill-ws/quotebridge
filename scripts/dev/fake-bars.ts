// Synthetic chart bars for the dev run's fake EAs: a random walk, one bar per bucket of the broker clock, ending at the
// feed's price, so `npm run dev` charts look like full MetaTrader charts.
import { bucketStart } from "../../src/shared/periods.js";
import { PERIOD_OF } from "../../src/server/history/index.js";
import type { FakeBar } from "../../tests/fake-ea.js";

/** The broker's first bar. */
const HISTORY_START = Date.UTC(2000, 0, 1) / 1000;

/**
 * `count` closed bars of `timeframe` minutes, oldest first, ending `shift` bars before the last closed one before
 * `now` (broker seconds), the newest closing at `price`; none before 2000, as a broker's history has a start. The same
 * request gives the same bars.
 */
export function fakeBars(timeframe: number, count: number, shift: number, now: number, price: number, digits: number): FakeBar[] {
  const period = PERIOD_OF.get(timeframe);
  if (!period) return [];
  const starts: number[] = [];
  let start = bucketStart(now, period);
  for (let i = 0; i < count + shift; i++) starts.unshift((start = bucketStart(start - 1, period)));
  let seed = timeframe * 7919 + count;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  const round = (p: number) => Number(p.toFixed(digits));
  const step = price * 4e-4 * Math.sqrt(timeframe / 60);
  const out: FakeBar[] = [];
  let close = price;
  for (const time of starts.slice(0, count).filter((t) => t >= HISTORY_START).reverse()) {
    const open = close - random() * step;
    out.unshift({
      time,
      open: round(open),
      high: round(Math.max(open, close) + Math.abs(random()) * step * 0.5),
      low: round(Math.min(open, close) - Math.abs(random()) * step * 0.5),
      close: round(close),
      volume: 50 + Math.round(Math.abs(random()) * 400),
    });
    close = open;
  }
  return out;
}
