// Dev dashboard: the bridge server with the dashboard rebuilt on change, optionally fed by fake EAs.
//
//   npm run dev:dashboard                 # server + dashboard watch build
//   npm run dev:dashboard -- --fake-ea    # plus synthetic feeds (no MetaTrader needed)
//
// Ports come from QUOTEBRIDGE_EA_PORT / QUOTEBRIDGE_HTTP_PORT (defaults 6655 / 6680, away from the
// app's own 5555 / 5580). Open the printed sign-in link in a browser; press Enter for a new one.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/server/index.js";
import { FakeEA } from "../tests/fake-ea.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const eaPort = Number(process.env.QUOTEBRIDGE_EA_PORT ?? 6655);
const httpPort = Number(process.env.QUOTEBRIDGE_HTTP_PORT ?? 6680);
const withFakeEA = process.argv.includes("--fake-ea");

const token = () => randomBytes(24).toString("base64url");

const build = spawn(process.execPath, [`${root}scripts/build-dashboard.mjs`, "--watch"], { stdio: "inherit" });

const firstToken = token();
const server = await startServer({ eaPort, httpPort, windowToken: firstToken, dashboardFolder: `${root}dist/dashboard` });
const signIn = (t: string) => console.log(`\nDashboard: ${server.httpOrigin}/session?token=${t}\n(one-time link; press Enter for another, Ctrl+C to stop)\n`);
signIn(firstToken);

const stopFeeds = withFakeEA ? fakeFeeds(`tcp://127.0.0.1:${eaPort}`) : () => {};

const input = createInterface({ input: process.stdin });
input.on("line", () => {
  const t = token();
  server.addWindowToken(t);
  signIn(t);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  input.close();
  stopFeeds();
  build.kill();
  await server.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

/** Synthetic feeds covering every row state of the Feeds view. Returns a function that stops them. */
function fakeFeeds(endpoint: string): () => void {
  const terminal = "mt4-0123456789ab";
  const broker = "Demo-Broker";
  type Fake = { ea: FakeEA; price?: number; spread?: number; frozen?: boolean; until?: number; seq: number };
  const make = (options: ConstructorParameters<typeof FakeEA>[0], extra: Partial<Fake> = {}): Fake => ({
    ea: new FakeEA({ terminal, broker, ...options }).connect(endpoint),
    seq: 0,
    ...extra,
  });
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
  ];
  fakes[4].ea.quoteStatus = "no-quote";
  fakes[6].ea.dropped = 1250;
  const frozenTime = Math.floor(Date.now() / 1000);

  const alive = (f: Fake) => f.until === undefined || Date.now() < f.until;
  const hello = () => fakes.filter(alive).forEach((f) => void f.ea.hello().catch(() => {}));
  const tick = () => {
    for (const f of fakes.filter(alive)) {
      if (f.price === undefined || f.spread === undefined) continue;
      const step = 10 ** -f.ea.digits;
      f.price = Number((f.price + (Math.round(Math.random() * 6) - 3) * step).toFixed(f.ea.digits));
      const quoteTime = f.frozen ? frozenTime : Math.floor(Date.now() / 1000);
      const ask = Number((f.price + f.spread).toFixed(f.ea.digits));
      void f.ea.ticks([{ seq: ++f.seq, bid: f.price, ask, quoteTime }]).catch(() => {});
    }
  };
  hello();
  const timers = [setInterval(hello, 2000), setInterval(tick, 700)];
  return () => {
    timers.forEach(clearInterval);
    fakes.forEach((f) => f.ea.close());
  };
}
