// A fake QuoteBridge EA: a real ZeroMQ DEALER speaking the EA wire protocol.
// Synthetic fixture: no MetaTrader, broker or DLL is involved.
import { createServer } from "node:net";
import { Dealer } from "zeromq";

export type FakeEAOptions = {
  session?: string;
  terminal?: string;
  broker?: string;
  symbol?: string;
  digits?: number;
  timeframe?: number;
  /** The EA version sent as the 14th hello field (EA 1.08+). `null` sends a 13-field hello, like EA 1.07. */
  eaVersion?: string | null;
};

export type Quote = { seq: number; bid: number; ask: number; quoteTime: number; sampledTime?: number };

export class FakeEA {
  readonly session: string;
  readonly terminal: string;
  readonly broker: string;
  readonly symbol: string;
  readonly digits: number;
  readonly timeframe: number;
  readonly eaVersion: string | null;
  dropped = 0;
  quoteStatus: "ok" | "no-quote" = "ok";
  private socket: Dealer;

  constructor(options: FakeEAOptions = {}) {
    this.session = options.session ?? `chart-${Math.random().toString(36).slice(2, 10)}`;
    this.terminal = options.terminal ?? "mt4-0123456789ab";
    this.broker = options.broker ?? "Demo-Broker";
    this.symbol = options.symbol ?? "EURUSD";
    this.digits = options.digits ?? 5;
    this.timeframe = options.timeframe ?? 60;
    this.eaVersion = options.eaVersion === undefined ? "1.08" : options.eaVersion;
    this.socket = new Dealer({ routingId: this.session, receiveTimeout: 2000, linger: 0 });
  }

  connect(endpoint: string) {
    this.socket.connect(endpoint);
    return this;
  }

  /** The hello as EA 1.08 sends it (14 fields), or as EA 1.07 (13 fields) when eaVersion is null. */
  helloWire() {
    const fields = ["H", "1", this.session, this.terminal, this.broker, this.symbol, this.digits, 500, this.dropped, this.quoteStatus, this.timeframe, 2000, 1];
    if (this.eaVersion !== null) fields.push(this.eaVersion);
    return fields.join("|");
  }

  tickWire(quotes: Quote[]) {
    const rows = quotes.map((q) => [q.seq, q.bid, q.ask, q.quoteTime, q.sampledTime ?? q.quoteTime + 1].join(","));
    return `T|1|${this.session}|${rows.join(";")}`;
  }

  send(wire: string) {
    return this.socket.send(wire);
  }

  hello() {
    return this.send(this.helloWire());
  }

  ticks(quotes: Quote[]) {
    return this.send(this.tickWire(quotes));
  }

  /** The next message from the bridge server, as text. Rejects after the receive timeout. */
  async receive() {
    const [frame] = await this.socket.receive();
    return frame.toString();
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

/** A free high TCP port on 127.0.0.1 (never the legacy 5555). */
export function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(Error("no port"))));
    });
  });
}

/** A ZeroMQ endpoint on a free high port. */
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
