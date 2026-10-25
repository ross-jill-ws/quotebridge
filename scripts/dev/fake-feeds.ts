// Synthetic feeds for `npm run dev`, covering every row state of the Feeds view. They run in the dev
// runner, not the server process, so they reconnect (ZeroMQ does) when the server restarts. As EA 1.11 they answer bar
// requests with synthetic bars ending at their price, so their charts are full. Three charts also carry simulated
// trading accounts (see fake-accounts.ts): two demo accounts on Demo-Broker and a real one on Real-Broker.
import { utcToBroker } from "../../src/shared/clock.js";
import { FakeEA } from "../../tests/fake-ea.js";
import { FakeAccount, type FakeAccountSpec } from "./fake-accounts.js";
import { fakeBars } from "./fake-bars.js";

/** The fake broker's clock: GMT+2, GMT+3 in US summer time, like most MetaTrader brokers. */
const BROKER_CLOCK = { winterOffsetMinutes: 120, dst: "us" } as const;
/** Broker seconds now, as MetaTrader stamps a quote. */
export const brokerNow = () => Math.floor(utcToBroker(BROKER_CLOCK, Date.now()) / 1000);
/** The PC's local time in seconds read as if UTC, as the EA's TimeLocal() reports it. */
export const localNow = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60_000) / 1000);

type Source = { terminal: string; installationFolder: string; dataFolder: string };
const QUOTEBRIDGE_MAGIC = 27012026;

/** The simulated accounts: an executor-ready demo account with an outside trade, a second ready demo account, a real one. */
const ACCOUNTS: Record<"main" | "second" | "real", FakeAccountSpec> = {
  main: {
    login: "50012345", currency: "USD", demo: true, enabled: true, ready: true, maxLots: "0.5", balance: 10000, leverage: 100,
    trades: [
      { kind: 0, symbol: "EURUSD", lots: 0.2, openPrice: 1.0815, stopLoss: 1.0765, takeProfit: 0, expiration: 0, magic: 0 },
      { kind: 2, symbol: "GBPUSD", lots: 0.1, openPrice: 1.265, stopLoss: 1.26, takeProfit: 1.275, expiration: 0, magic: QUOTEBRIDGE_MAGIC },
    ],
  },
  second: {
    login: "50067890", currency: "EUR", demo: true, enabled: true, ready: true, maxLots: "1", balance: 5000, leverage: 30,
    trades: [{ kind: 1, symbol: "EURUSD", lots: 0.1, openPrice: 1.0871, stopLoss: 1.0921, takeProfit: 1.0791, expiration: 0, magic: QUOTEBRIDGE_MAGIC }],
  },
  real: {
    login: "70011223", currency: "USD", demo: false, enabled: false, ready: true, maxLots: "0.5", balance: 2500, leverage: 50,
    trades: [{ kind: 0, symbol: "EURUSD", lots: 0.05, openPrice: 1.0832, stopLoss: 0, takeProfit: 0, expiration: 0, magic: 0 }],
  },
};

/** Synthetic feeds covering every row state of the Feeds view. Returns a function that stops them. */
export function fakeFeeds(endpoint: string, source?: Source, accountSources?: { secondDemo: Source; real: Source }): () => void {
  const terminal = source?.terminal ?? "mt4-0123456789ab";
  const broker = "Demo-Broker";
  type Fake = { ea: FakeEA; price?: number; spread?: number; frozen?: boolean; oldSession?: boolean; until?: number; seq: number; account?: FakeAccount };
  const quote = (brokerServer: string) => (symbol: string) => {
    const f = fakes.find((x) => x.ea.broker === brokerServer && x.ea.symbol === symbol && x.price !== undefined && x.spread !== undefined);
    return f && { bid: f.price!, ask: Number((f.price! + f.spread!).toFixed(f.ea.digits)), digits: f.ea.digits };
  };
  let tickets = 0;
  const make = (options: ConstructorParameters<typeof FakeEA>[0], extra: Partial<Fake> = {}, account?: FakeAccountSpec, chartSource = source): Fake => {
    const fake = { seq: 0, ...extra } as Fake;
    const brokerServer = options?.broker ?? broker;
    if (account) fake.account = new FakeAccount(account, quote(brokerServer), brokerNow, 81_000_000 + 100_000 * ++tickets);
    // A feed without a price has no bars to show: MetaTrader would still be loading them.
    const bars = (timeframe: number, count: number, shift: number) =>
      fake.price === undefined ? ("loading" as const) : fakeBars(timeframe, count, shift, brokerNow(), fake.price, options?.digits ?? 5);
    const commands = (message: string) => fake.account?.handle(fake.ea, message);
    fake.ea = new FakeEA({ terminal: chartSource?.terminal ?? terminal, broker, ...(chartSource ? { identity: chartSource } : {}), bars, commands, ...options }).connect(endpoint);
    return fake;
  };
  const fakes: Fake[] = [
    make({ symbol: "EURUSD", timeframe: 60 }, { price: 1.0842, spread: 0.00012 }, ACCOUNTS.main),
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
  if (accountSources) {
    // Another terminal on Demo-Broker with its own demo account, and a terminal on a real account's broker server.
    fakes.push(
      make({ symbol: "EURUSD", timeframe: 60 }, { price: 1.0842, spread: 0.00014 }, ACCOUNTS.second, accountSources.secondDemo),
      make({ symbol: "GBPUSD", timeframe: 60 }, { price: 1.2711, spread: 0.00017 }, undefined, accountSources.secondDemo),
      make({ symbol: "EURUSD", timeframe: 60, broker: "Real-Broker" }, { price: 1.0843, spread: 0.0001 }, ACCOUNTS.real, accountSources.real),
    );
  }
  fakes[4].ea.quoteStatus = "no-quote";
  fakes[6].ea.dropped = 1250;
  const frozenTime = brokerNow();

  const alive = (f: Fake) => f.until === undefined || Date.now() < f.until;
  const hello = () =>
    fakes.filter(alive).forEach((f) => void f.ea.hello().then(() => f.account && f.ea.send(f.account.announceWire(f.ea))).catch(() => {}));
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
