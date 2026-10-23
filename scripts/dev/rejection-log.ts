// Console lines for rejected EA messages in dev runs: at most one per reason and route every few seconds,
// so a repeating rejection shows without flooding the log.
import type { Rejection, RejectionListener } from "../../src/server/bridge/index.js";

export type RejectionLoggerOptions = {
  log?: (line: string) => void;
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
  /** At most one line per reason and route this often (default 5 s). */
  intervalMs?: number;
};

/** Bounds the memory a flood of distinct routes can take; windows that have passed are forgotten first. */
const MAX_KEYS = 1000;

export function rejectionLogger(options: RejectionLoggerOptions = {}): RejectionListener {
  const log = options.log ?? ((line) => console.warn(line));
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 5000;
  const windows = new Map<string, { since: number; held: number }>();
  return (r: Rejection) => {
    const key = JSON.stringify([r.reason, r.route]);
    const time = now();
    const window = windows.get(key);
    if (window && time - window.since < intervalMs) {
      window.held++;
      return;
    }
    if (windows.size >= MAX_KEYS) for (const [k, w] of windows) if (time - w.since >= intervalMs) windows.delete(k);
    windows.set(key, { since: time, held: 0 });
    const held = window?.held ? ` (+${window.held} more since the last line)` : "";
    log(`EA message rejected (${r.reason}) from route ${r.route}, ${r.feed ? `feed ${r.feed}` : "no known feed"}: ${r.excerpt}${held}`);
  };
}
