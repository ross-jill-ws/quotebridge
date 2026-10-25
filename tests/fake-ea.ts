// A fake QuoteBridge EA: a real ZeroMQ DEALER speaking the EA wire protocol.
// Synthetic fixture: no MetaTrader, broker or DLL is involved.
import { Dealer } from "zeromq";
import { BARS_PER_PAGE, feedKey } from "../src/server/bridge/index.js";
import { freePort } from "./free-port.js";
import { normaliseFolderPath } from "../src/shared/terminal-catalog/paths.js";

type TerminalPaths = { installationFolder: string; dataFolder: string };
const fixtureTerminals = new Map<string, string>();
const pathsKey = (paths: TerminalPaths) => JSON.stringify([normaliseFolderPath(paths.installationFolder), normaliseFolderPath(paths.dataFolder)]);
/** Synthetic catalog boundary for standalone server tests. Real-catalog tests supply actual temporary folders. */
export const fakeTerminalIdentity = (paths: TerminalPaths) => fixtureTerminals.get(pathsKey(paths));

export type FakeEAOptions = {
  session?: string;
  terminal?: string;
  broker?: string;
  symbol?: string;
  digits?: number;
  timeframe?: number;
  /** The EA version sent as the 14th hello field (EA 1.08+). `null` sends a 13-field hello, like EA 1.07. */
  eaVersion?: string | null;
  /** TerminalInfoString paths for the 1.11 hello; null deliberately sends an unverifiable older hello. */
  identity?: TerminalPaths | null;
  /**
   * Answers bar requests (EA 1.10+) with these bars of a timeframe, oldest first, or says MetaTrader is still loading
   * them. Without it, bar requests are left unanswered, like an older EA. With it, the chart reads its socket itself and
   * `receive` hands out the other messages.
   */
  bars?: BarAnswer;
  /** With `bars`: handles account commands (`V`, `P`, `X`) itself instead of leaving them for `receive`. */
  commands?: (message: string) => void;
};

/** A closed bar as the fake EA sends it; `time` in broker seconds. */
export type FakeBar = { time: number; open: number; high: number; low: number; close: number; volume?: number };
export type BarAnswer = (timeframe: number, count: number, shift: number) => readonly FakeBar[] | "loading";

export type Quote = { seq: number; bid: number; ask: number; quoteTime: number; sampledTime?: number };

/** Unread messages a chart answering bar requests keeps. */
const MAX_UNREAD = 100;

export class FakeEA {
  readonly session: string;
  readonly terminal: string;
  readonly broker: string;
  readonly symbol: string;
  readonly digits: number;
  readonly timeframe: number;
  readonly eaVersion: string | null;
  readonly identity: TerminalPaths | null;
  dropped = 0;
  quoteStatus: "ok" | "no-quote" = "ok";
  private socket: Dealer;
  private sending: Promise<unknown> = Promise.resolve();
  private readonly bars?: BarAnswer;
  private readonly commands?: (message: string) => void;
  /** Bar requests received, as [timeframe, count, shift]. */
  readonly barRequests: [number, number, number][] = [];
  private readonly inbox: string[] = [];
  private readonly waiting: ((message: string) => void)[] = [];

  constructor(options: FakeEAOptions = {}) {
    this.session = options.session ?? `chart-${Math.random().toString(36).slice(2, 10)}`;
    this.terminal = options.terminal ?? "mt4-0123456789ab";
    this.broker = options.broker ?? "Demo-Broker";
    this.symbol = options.symbol ?? "EURUSD";
    this.digits = options.digits ?? 5;
    this.timeframe = options.timeframe ?? 60;
    this.eaVersion = options.eaVersion === undefined ? "1.11" : options.eaVersion;
    this.identity = options.identity === undefined
      ? { installationFolder: `C:\\QuoteBridge-fixtures\\${this.terminal}\\installation`, dataFolder: `C:\\QuoteBridge-fixtures\\${this.terminal}\\data` }
      : options.identity;
    if (this.identity) fixtureTerminals.set(pathsKey(this.identity), this.terminal);
    this.bars = options.bars;
    this.commands = options.commands;
    this.socket = new Dealer({ routingId: this.session, receiveTimeout: this.bars ? -1 : 2000, linger: 0 });
  }

  connect(endpoint: string) {
    this.socket.connect(endpoint);
    if (this.bars) void this.pump();
    return this;
  }

  /** Reads every message: bar requests are answered, the rest wait for `receive`. */
  private async pump() {
    while (!this.socket.closed) {
      let message: string;
      try {
        message = (await this.socket.receive())[0].toString();
      } catch {
        continue;
      }
      if (message.startsWith("G|")) void this.answer(message.split("|")).catch(() => {});
      else if (this.commands && /^[VPX]\|/.test(message)) this.commands(message);
      else if (this.waiting.length) this.waiting.shift()!(message);
      // Unread replies are kept up to a point: a chart that never reads them (the dev run's) must not pile them up.
      else if (this.inbox.push(message) > MAX_UNREAD) this.inbox.shift();
    }
  }

  private async answer([, , , request, timeframe, count, shift]: string[]) {
    this.barRequests.push([Number(timeframe), Number(count), Number(shift)]);
    const head = `G|1|${this.session}|${request}|${timeframe}`;
    const bars = this.bars!(Number(timeframe), Number(count), Number(shift));
    if (bars === "loading") return this.send(`${head}|loading|0|0|`);
    for (let offset = 0; offset < bars.length; offset += BARS_PER_PAGE) {
      const rows = bars.slice(offset, offset + BARS_PER_PAGE).map((b) => [b.time, ...[b.open, b.high, b.low, b.close].map((p) => p.toFixed(this.digits)), b.volume ?? 0].join(","));
      await this.send(`${head}|ok|${bars.length}|${offset}|${rows.join(";")}`);
    }
  }

  /** The hello as EA 1.11 sends it; explicit older versions omit the installation paths. */
  helloWire() {
    const fields = ["H", "1", this.session, this.terminal, this.broker, this.symbol, this.digits, 500, this.dropped, this.quoteStatus, this.timeframe, 2000, 1];
    if (this.eaVersion !== null) fields.push(this.eaVersion);
    const [major, minor] = (this.eaVersion ?? "").split(".").map(Number);
    if (this.identity && (major > 1 || (major === 1 && minor >= 11))) fields.push(this.identity.installationFolder, this.identity.dataFolder);
    return fields.join("|");
  }

  /** The feed this chart sends, as the bridge keys it. */
  feedKey() {
    return feedKey(this);
  }

  tickWire(quotes: Quote[]) {
    const rows = quotes.map((q) => [q.seq, q.bid, q.ask, q.quoteTime, q.sampledTime ?? q.quoteTime + 1].join(","));
    return `T|1|${this.session}|${rows.join(";")}`;
  }

  /** Sends one message after any still in flight: a ZeroMQ socket refuses a second send while one is pending. */
  send(wire: string) {
    const sent = this.sending.then(() => this.socket.send(wire));
    this.sending = sent.catch(() => {});
    return sent;
  }

  hello() {
    return this.send(this.helloWire());
  }

  ticks(quotes: Quote[]) {
    return this.send(this.tickWire(quotes));
  }

  /** The next message from the bridge server, as text. Rejects after the receive timeout. */
  async receive() {
    if (!this.bars) {
      const [frame] = await this.socket.receive();
      return frame.toString();
    }
    if (this.inbox.length) return this.inbox.shift()!;
    return new Promise<string>((resolve, reject) => {
      const take = (message: string) => {
        clearTimeout(timer);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(take), 1);
        reject(Error("No message within 2 s"));
      }, 2000);
      this.waiting.push(take);
    });
  }

  /** Sends and waits for the reply. */
  async request(wire: string) {
    await this.send(wire);
    return this.receive();
  }

  close() {
    this.socket.close();
  }
}

/** A ZeroMQ endpoint on a free port (see free-port.ts). */
export async function freeEndpoint(): Promise<string> {
  return `tcp://127.0.0.1:${await freePort()}`;
}

/** A clock the test moves by hand. */
export class FakeClock {
  constructor(public time = 1_800_000_000_000) {}
  now = () => this.time;
  advance(ms: number) {
    this.time += ms;
  }
}
