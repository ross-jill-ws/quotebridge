// Recording: every sample of the recorded markets, from whichever terminals supply them, kept until the trader deletes
// it. A market is a symbol on a broker server, so two terminals on one server record once and a login switch records
// into the new market (ADR 11). Samples are buffered and appended in batches; close() flushes, so the stop path's
// CHECKPOINT finds them written (ADR 10).
import { brokerToUtc, UNKNOWN_RULE, type ClockRule } from "../../shared/clock.js";
import { marketKey, type BridgeServer, type Market, type SampleEvent } from "../bridge/index.js";
import type { RecordingStore, SampleRow, StoredMarket } from "./recording-store.js";

/** Buffered samples are appended this often, or sooner once there are FLUSH_SAMPLES of them. */
export const FLUSH_EVERY_MS = 1000;
export const FLUSH_SAMPLES = 500;
/** What a stored sample takes on disk on average, for the "about" size; an estimate, as DuckDB compresses. */
export const SAMPLE_BYTES = 32;

/** What Settings › Recording shows for a market; times are UTC epoch milliseconds. */
export type RecordingView = {
  brokerServer: string;
  symbol: string;
  digits: number | null;
  recording: boolean;
  recordingSince: number | null;
  samples: number;
  first: number | null;
  last: number | null;
  /** Samples × an average row size: an estimate. */
  aboutBytes: number;
  /** The broker server's clock rule, for showing times in broker time; null while unknown. */
  clockRule: ClockRule | null;
};

/** A request the user can fix; `status` is the HTTP status to answer with. */
export class RecordingRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RecorderOptions = {
  /** Clock in epoch milliseconds; injectable for tests. */
  now?: () => number;
  /** A broker server's clock rule, or null while unknown (broker seconds are then stored as UTC until it is known). */
  clockRule: (brokerServer: string) => ClockRule | null;
  /** The digits of a market's feeds, if any is known. */
  digits: (market: Market) => number | undefined;
};

type Last = Pick<SampleRow, "brokerSeconds" | "bid" | "ask">;

export class Recorder {
  private readonly markets = new Map<string, StoredMarket>();
  /** Per market ID: the last sample kept (stored or buffered), for the merge rule. */
  private readonly last = new Map<number, Last>();
  private buffer: SampleRow[] = [];
  private readonly now: () => number;
  private unsubscribe = () => {};
  private readonly timer: NodeJS.Timeout;
  /** Database work, one job at a time, in order. */
  private work: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly store: RecordingStore,
    private readonly options: RecorderOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.timer = setInterval(() => void this.flush().catch(() => {}), FLUSH_EVERY_MS);
  }

  /** Loads the markets and each one's last sample, then records from the bridge's samples. */
  static async open(bridge: BridgeServer, store: RecordingStore, options: RecorderOptions): Promise<Recorder> {
    const recorder = new Recorder(store, options);
    try {
      for (const market of await store.markets()) recorder.markets.set(marketKey(market), market);
      for (const [id, last] of await store.lastSamples()) recorder.last.set(id, last);
    } catch (e) {
      clearInterval(recorder.timer);
      throw e;
    }
    recorder.unsubscribe = bridge.onSamples((event) => recorder.handle(event));
    return recorder;
  }

  /** Every market stored (recorded or once recorded). */
  storedMarkets(): StoredMarket[] {
    return [...this.markets.values()];
  }

  isRecording(market: Market): boolean {
    return this.markets.get(marketKey(market))?.recording ?? false;
  }

  /** Switches a market's recording on or off; off keeps its samples. */
  async setRecording(request: unknown): Promise<{ brokerServer: string; symbol: string; recording: boolean }> {
    const { brokerServer, symbol, on } = (request ?? {}) as { brokerServer?: unknown; symbol?: unknown; on?: unknown };
    const market = checkMarket(brokerServer, symbol);
    if (typeof on !== "boolean") throw new RecordingRequestError(400, '"on" must be true or false.');
    return this.serial(async () => {
      let stored = this.markets.get(marketKey(market));
      const digits = this.options.digits(market);
      if (!stored && digits === undefined) throw new RecordingRequestError(404, `No feed of ${market.symbol} on ${market.brokerServer} is known.`);
      if (!stored || (stored.digits === null && digits !== undefined)) {
        const id = await this.store.addMarket(market.brokerServer, market.symbol, digits ?? null);
        stored = { id, ...market, digits: digits ?? stored?.digits ?? null, recording: stored?.recording ?? false, recordingSince: stored?.recordingSince ?? null };
        this.markets.set(marketKey(market), stored);
      }
      if (stored.recording !== on) {
        const since = on ? this.now() : null;
        // Samples buffered before a stop are kept.
        if (!on) await this.write();
        await this.store.setRecording(stored.id, on, since);
        stored.recording = on;
        stored.recordingSince = since;
      }
      return { ...market, recording: on };
    });
  }

  /** Recorded and once-recorded markets, by symbol then broker server. */
  async list(): Promise<RecordingView[]> {
    return this.serial(async () => {
      await this.write();
      const summaries = new Map((await this.store.summaries()).map((s) => [s.marketId, s]));
      return [...this.markets.values()]
        .filter((m) => m.recording || summaries.has(m.id))
        .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.brokerServer.localeCompare(b.brokerServer))
        .map((m) => {
          const summary = summaries.get(m.id);
          const samples = summary?.samples ?? 0;
          return {
            brokerServer: m.brokerServer,
            symbol: m.symbol,
            digits: m.digits,
            recording: m.recording,
            recordingSince: m.recordingSince,
            samples,
            first: summary?.first ?? null,
            last: summary?.last ?? null,
            aboutBytes: samples * SAMPLE_BYTES,
            clockRule: this.options.clockRule(m.brokerServer),
          };
        });
    });
  }

  /** Deletes a market's samples (recording, if on, goes on) and answers the list. */
  async deleteSamples(request: unknown): Promise<RecordingView[]> {
    const { brokerServer, symbol } = (request ?? {}) as { brokerServer?: unknown; symbol?: unknown };
    const market = checkMarket(brokerServer, symbol);
    const stored = this.markets.get(marketKey(market));
    if (!stored) throw new RecordingRequestError(404, `Nothing is recorded for ${market.symbol} on ${market.brokerServer}.`);
    await this.serial(async () => {
      this.buffer = this.buffer.filter((row) => row.marketId !== stored.id);
      await this.store.deleteSamples(stored.id);
      this.last.delete(stored.id);
    });
    return this.list();
  }

  /** A broker server's rule changed: stored UTC times are recomputed from their broker seconds. */
  ruleChanged(brokerServer: string, rule: ClockRule): Promise<void> {
    return this.serial(async () => {
      await this.write();
      await this.store.recomputeUtc(brokerServer, rule);
    });
  }

  private handle(event: SampleEvent) {
    if (event.type !== "samples" || this.closed) return;
    const market = this.markets.get(marketKey(event.market));
    if (!market?.recording) return;
    const rule = this.options.clockRule(market.brokerServer) ?? UNKNOWN_RULE;
    const receivedMs = this.now();
    for (const sample of event.samples) {
      const last = this.last.get(market.id);
      // The merge rule: another terminal's (or a replayed) older sample, or the same reading again, is not kept.
      if (last && (sample.quoteTime < last.brokerSeconds || (sample.quoteTime === last.brokerSeconds && sample.bid === last.bid && sample.ask === last.ask))) continue;
      this.last.set(market.id, { brokerSeconds: sample.quoteTime, bid: sample.bid, ask: sample.ask });
      this.buffer.push({ marketId: market.id, utcMs: brokerToUtc(rule, sample.quoteTime * 1000), brokerSeconds: sample.quoteTime, bid: sample.bid, ask: sample.ask, receivedMs });
    }
    if (this.buffer.length >= FLUSH_SAMPLES) void this.flush().catch(() => {});
  }

  /** Appends the buffered samples. */
  flush(): Promise<void> {
    return this.serial(() => this.write());
  }

  private async write() {
    if (!this.buffer.length) return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      await this.store.append(rows);
    } catch (e) {
      // The EA has been told they arrived: keep them for the next flush (an appender flush is all or nothing).
      this.buffer = [...rows, ...this.buffer];
      console.error(`${rows.length} recorded samples could not be written; trying again`, e);
      throw e;
    }
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.work.then(job);
    this.work = next.catch(() => {});
    return next;
  }

  /** Stops recording and writes what is buffered; samples that still cannot be written are reported and lost. */
  async close() {
    this.closed = true;
    this.unsubscribe();
    clearInterval(this.timer);
    await this.flush().catch(() => console.error(`${this.buffer.length} recorded samples were lost at the stop`));
  }
}

function checkMarket(brokerServer: unknown, symbol: unknown): Market {
  if (typeof brokerServer !== "string" || !brokerServer.length || brokerServer.length > 120) throw new RecordingRequestError(400, "Expected a broker server.");
  if (typeof symbol !== "string" || !symbol.length || symbol.length > 120) throw new RecordingRequestError(400, "Expected a symbol.");
  return { brokerServer, symbol };
}
