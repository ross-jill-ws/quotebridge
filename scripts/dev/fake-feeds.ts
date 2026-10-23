// Synthetic feeds for `npm run dev`, covering every row state of the Feeds view. They run in the dev
// runner, not the server process, so they reconnect (ZeroMQ does) when the server restarts. As EA 1.10 they answer bar
// requests with synthetic bars ending at their price, so their charts are full.
import { utcToBroker } from "../../src/shared/clock.js";
import { FakeEA } from "../../tests/fake-ea.js";
import { fakeBars } from "./fake-bars.js";

/** The fake broker's clock: GMT+2, GMT+3 in US summer time, like most MetaTrader brokers. */
const BROKER_CLOCK = { winterOffsetMinutes: 120, dst: "us" } as const;
/** Broker seconds now, as MetaTrader stamps a quote. */
export const brokerNow = () => Math.floor(utcToBroker(BROKER_CLOCK, Date.now()) / 1000);
/** The PC's local time in seconds read as if UTC, as the EA's TimeLocal() reports it. */
export const localNow = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60_000) / 1000);

/** Synthetic feeds covering every row state of the Feeds view. Returns a function that stops them. */
export function fakeFeeds(endpoint: string): () => void {
  const terminal = "mt4-0123456789ab";
  const broker = "Demo-Broker";
  type Fake = { ea: FakeEA; price?: number; spread?: number; frozen?: boolean; oldSession?: boolean; until?: number; seq: number };
  const make = (options: ConstructorParameters<typeof FakeEA>[0], extra: Partial<Fake> = {}): Fake => {
    const fake = { seq: 0, ...extra } as Fake;
    // A feed without a price has no bars to show: MetaTrader would still be loading them.
    const bars = (timeframe: number, count: number, shift: number) =>
      fake.price === undefined ? ("loading" as const) : fakeBars(timeframe, count, shift, brokerNow(), fake.price, options?.digits ?? 5);
    fake.ea = new FakeEA({ terminal, broker, eaVersion: "1.10", bars, ...options }).connect(endpoint);
    return fake;
  };
  const fakes: Fake[] = [
    make({ symbol: "EURUSD", timeframe: 60 }, { price: 1.0842, spread: 0.00012 }),
    make({ symbol: "GBPUSD", timeframe: 15 }, { price: 1.2711, spread: 0.00015 }),
    make({ symbol: "USDJPY", timeframe: 240, digits: 3 }, { price: 151.234, spread: 0.014 }),
    // Quote time never moves: stale after 10 s.
    make({ symbol: "XAUUSD", timeframe: 60, digits: 2 }, { price: 2401.5, spread: 0.35, frozen: true }),
    // The EA cannot read the symbol.
    make({ symbol: "US30.cash", timeframe: 60, digits: 1 }),
    // A second chart sending EURUSD: duplicate EAs.
    make({ symbol: "EURUSD", timeframe: 5 }, { price: 1.0842, spread: 0.00012 }),
    // Dropped samples while the app was away.
    make({ symbol: "AUDUSD", timeframe: 60 }, { price: 0.6612, spread: 0.0001 }),
    // Goes quiet after 5 s: offline after 7 s more, then removable.
    make({ symbol: "NZDUSD", timeframe: 1440 }, { price: 0.6011, spread: 0.00018, until: Date.now() + 5000 }),
    // Batches name an old session, as after a chart change on EA 1.08: rejected, so no quotes received after 30 s.
    make({ symbol: "USDCAD", timeframe: 60 }, { price: 1.3721, spread: 0.00016, oldSession: true }),
    // Says hello but sends no samples: no quotes received after 30 s.
    make({ symbol: "USDCHF", timeframe: 60 }),
  ];
  fakes[4].ea.quoteStatus = "no-quote";
  fakes[6].ea.dropped = 1250;
  const frozenTime = brokerNow();

  const alive = (f: Fake) => f.until === undefined || Date.now() < f.until;
  const hello = () => fakes.filter(alive).forEach((f) => void f.ea.hello().catch(() => {}));
  const tick = () => {
    for (const f of fakes.filter(alive)) {
      if (f.price === undefined || f.spread === undefined) continue;
      const step = 10 ** -f.ea.digits;
      f.price = Number((f.price + (Math.round(Math.random() * 6) - 3) * step).toFixed(f.ea.digits));
      const quoteTime = f.frozen ? frozenTime : brokerNow();
      const ask = Number((f.price + f.spread).toFixed(f.ea.digits));
      const wire = f.ea.tickWire([{ seq: ++f.seq, bid: f.price, ask, quoteTime, sampledTime: localNow() }]);
      void f.ea.send(f.oldSession ? wire.replace(f.ea.session, `${f.ea.session}-old`) : wire).catch(() => {});
    }
  };
  hello();
  const timers = [setInterval(hello, 2000), setInterval(tick, 700)];
  return () => {
    timers.forEach(clearInterval);
    fakes.forEach((f) => f.ea.close());
  };
}
