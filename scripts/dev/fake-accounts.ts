// Synthetic trading accounts for `npm run dev`: a fake EA chart announces its account (I) after each hello and answers
// Funds/order snapshots (V), symbol conditions (P) and demo executions (X) from an in-memory account. Nothing here
// touches MetaTrader or a broker. Lots of exactly 0.07 are never answered, so the request becomes unknown after 20 s
// and the review flow can be tried.
import type { FakeEA } from "../../tests/fake-ea.js";

/** The magic number QuoteBridge's EA stamps on the trades it places; others count as placed outside QuoteBridge. */
const QUOTEBRIDGE_MAGIC = 27012026;
const PAGE = 20;
const RESULT_DELAY_MS = 400;
const UNANSWERED_LOTS = 0.07;

export type FakeQuote = { bid: number; ask: number; digits: number };
type Trade = { ticket: number; kind: number; symbol: string; lots: number; openPrice: number; openTime: number; stopLoss: number; takeProfit: number; expiration: number; magic: number };
export type FakeAccountSpec = {
  login: string;
  currency: string;
  demo: boolean;
  /** EnableDemoTrading on this chart, and whether the EA is ready (AutoTrading, permissions). */
  enabled: boolean;
  ready: boolean;
  /** The EA's MaxDemoOrderLots. */
  maxLots: string;
  balance: number;
  leverage: number;
  /** Trades already open when the run starts; `magic` other than QuoteBridge's marks one placed outside it. */
  trades: Omit<Trade, "ticket" | "openTime">[];
};

const decimal = (value: number) => {
  const text = value.toFixed(10);
  return text === "-0.0000000000" ? "0.0000000000" : text;
};

export class FakeAccount {
  private readonly trades: Trade[];
  private balance: number;
  private nextTicket: number;

  constructor(
    private readonly spec: FakeAccountSpec,
    private readonly quote: (symbol: string) => FakeQuote | undefined,
    private readonly brokerNow: () => number,
    ticketBase: number,
  ) {
    this.balance = spec.balance;
    this.nextTicket = ticketBase;
    this.trades = spec.trades.map((t, i) => ({ ...t, ticket: this.nextTicket++, openTime: brokerNow() - 3600 * (i + 2) }));
  }

  /** The account announcement the EA sends after each hello. */
  announceWire(ea: FakeEA) {
    const s = this.spec;
    return ["I", "1", ea.session, s.login, s.currency, Number(s.demo), Number(s.enabled), Number(s.ready), decimal(Number(s.maxLots))].join("|");
  }

  /** Answers a V, P or X command addressed to this chart. */
  handle(ea: FakeEA, message: string) {
    const fields = message.split("|");
    const [type, , , request, login] = fields;
    if (login !== this.spec.login) return;
    if (type === "V") this.snapshot(ea, request);
    else if (type === "P") this.conditions(ea, request, fields[6]);
    else if (type === "X") this.execute(ea, fields);
  }

  private contract(symbol: string) {
    const quote = this.quote(symbol);
    if (!quote) return undefined;
    const point = 10 ** -quote.digits;
    const contractSize = symbol.startsWith("XAU") ? 100 : 100000;
    return { ...quote, point, contractSize, tickValue: point * contractSize };
  }

  private profit(t: Trade) {
    const c = this.contract(t.symbol);
    if (!c || t.kind > 1) return 0;
    const close = t.kind === 0 ? c.bid : c.ask;
    return ((t.kind === 0 ? close - t.openPrice : t.openPrice - close) / c.point) * c.tickValue * t.lots;
  }

  private marginPerLot(symbol: string) {
    const c = this.contract(symbol);
    return c ? (c.ask * c.contractSize) / this.spec.leverage / (symbol.endsWith("USD") ? 1 : c.ask) : 0;
  }

  private snapshot(ea: FakeEA, request: string) {
    const s = this.spec;
    const open = this.trades.filter((t) => t.kind <= 1);
    const profit = open.reduce((sum, t) => sum + this.profit(t), 0);
    const margin = open.reduce((sum, t) => sum + t.lots * this.marginPerLot(t.symbol), 0);
    const equity = this.balance + profit;
    const rows = this.trades.map((t) => {
      const c = this.contract(t.symbol);
      const current = c ? (t.kind % 2 === 0 ? c.bid : c.ask) : t.openPrice;
      return [t.ticket, t.kind, t.symbol, decimal(t.lots), decimal(t.openPrice), t.openTime, decimal(t.stopLoss), decimal(t.takeProfit), t.expiration,
        decimal(this.profit(t)), decimal(0), decimal(0), t.magic, decimal(current)].join(",");
    });
    const head = ["V", "1", ea.session, request, s.login, ea.broker, s.currency, Number(s.demo), decimal(this.balance), decimal(equity), decimal(margin),
      decimal(equity - margin), decimal(profit), s.leverage, Number(s.ready), this.brokerNow(), rows.length];
    if (!rows.length) return void ea.send([...head, 0, ""].join("|")).catch(() => {});
    for (let offset = 0; offset < rows.length; offset += PAGE) {
      void ea.send([...head, offset, rows.slice(offset, offset + PAGE).join(";")].join("|")).catch(() => {});
    }
  }

  private conditions(ea: FakeEA, request: string, symbol: string) {
    const c = this.contract(symbol);
    if (!c) return void ea.send(`E|1|${ea.session}|${request}|${this.spec.login}|Unknown symbol`).catch(() => {});
    const fields = ["P", "1", ea.session, request, this.spec.login, symbol, decimal(c.bid), decimal(c.ask), c.digits, decimal(c.point), decimal(c.point),
      decimal(0.01), decimal(50), decimal(0.01), 10, 5, 1, this.brokerNow(), decimal(c.tickValue), decimal(c.contractSize), decimal(this.marginPerLot(symbol)),
      decimal(-1.25), decimal(0.5), 0, symbol.slice(3, 6) || this.spec.currency, 0, 0];
    void ea.send(fields.join("|")).catch(() => {});
  }

  private execute(ea: FakeEA, f: string[]) {
    const [, , , request, , , action, kind, symbol, ticket, lots, price, stopLoss, takeProfit, expiry] = f;
    if (Number(lots) === UNANSWERED_LOTS) return;
    const reply = (status: "succeeded" | "rejected", resultTicket: number, code: number, text: string) =>
      setTimeout(() => void ea.send(`X|1|${ea.session}|${request}|${this.spec.login}|${status}|${resultTicket}|${code}|${text}`).catch(() => {}), RESULT_DELAY_MS);
    if (action === "N") {
      const trade: Trade = { ticket: this.nextTicket++, kind: Number(kind), symbol, lots: Number(lots), openPrice: Number(price), openTime: this.brokerNow(),
        stopLoss: Number(stopLoss), takeProfit: Number(takeProfit), expiration: Number(expiry), magic: QUOTEBRIDGE_MAGIC };
      this.trades.push(trade);
      return reply("succeeded", trade.ticket, 0, "Simulated order placed");
    }
    const index = this.trades.findIndex((t) => t.ticket === Number(ticket));
    if (index < 0) return reply("rejected", 0, 4108, "Invalid ticket");
    const trade = this.trades[index];
    if (action === "M") {
      Object.assign(trade, { stopLoss: Number(stopLoss), takeProfit: Number(takeProfit) });
      if (trade.kind > 1) Object.assign(trade, { openPrice: Number(price), expiration: Number(expiry) });
    } else {
      if (action === "C") this.balance += this.profit(trade);
      this.trades.splice(index, 1);
    }
    reply("succeeded", trade.ticket, 0, action === "M" ? "Simulated order modified" : action === "C" ? "Simulated position closed" : "Simulated order cancelled");
  }
}
