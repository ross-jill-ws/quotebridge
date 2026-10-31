// Account/trading messages from QuoteBridgeTrading.mqh. Validation errors are static:
// these bodies contain private account identities and must never be copied into diagnostics.
export type AccountHello = {
  type: "account-hello";
  session: string;
  login: string;
  currency: string;
  demo: boolean;
  enabled: boolean;
  ready: boolean;
  /** EA 1.12+ new-order cap; null means an older peer did not advertise it. */
  maxLots: string | null;
  /** EA 1.13+ EnableRealTrading; false from an older peer, which never trades a real account. */
  realEnabled: boolean;
};

export const ORDERS_PER_PAGE = 20;
export const MAX_ACCOUNT_ORDERS = 1000;

export type AccountOrder = {
  ticket: string;
  kind: number;
  symbol: string;
  lots: string;
  openPrice: string;
  openTime: number;
  stopLoss: string;
  takeProfit: string;
  expiration: number;
  profit: string;
  swap: string;
  commission: string;
  magic: number;
  closePrice: string;
};

export type AccountPage = {
  type: "account-page";
  session: string;
  request: string;
  login: string;
  broker: string;
  currency: string;
  demo: boolean;
  balance: string;
  equity: string;
  margin: string;
  freeMargin: string;
  profit: string;
  leverage: number;
  ready: boolean;
  /** Broker seconds, not UTC. */
  capturedAt: number;
  total: number;
  offset: number;
  orders: AccountOrder[];
};

export type Conditions = {
  type: "conditions";
  session: string;
  request: string;
  login: string;
  symbol: string;
  bid: string;
  ask: string;
  digits: number;
  point: string;
  tickSize: string;
  minLots: string;
  maxLots: string;
  lotStep: string;
  stopLevel: number;
  freezeLevel: number;
  tradeAllowed: boolean;
  /** Broker seconds, not UTC. */
  quoteTime: number;
  tickValue: string;
  contractSize: string;
  marginRequired: string;
  swapLong: string;
  swapShort: string;
  swapType: number;
  profitCurrency: string;
  starting: number;
  expiration: number;
};

export type TradeResult = {
  type: "trade-result";
  session: string;
  request: string;
  login: string;
  status: "succeeded" | "rejected" | "unknown";
  /** "0" when the EA has no confirmed ticket. */
  ticket: string;
  code: number;
  message: string;
};

export type ReadError = {
  type: "read-error";
  session: string;
  request: string;
  /** "0" is possible if the terminal lost its account while reading. */
  login: string;
  message: string;
};

export type AccountMessage = AccountHello | AccountPage | Conditions | TradeResult | ReadError;

function invalid(): never { throw Error("Invalid account message"); }

const integer = (value: string, min: number, max: number) => {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return invalid();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) return invalid();
  return n;
};

const login = (value: string) => { integer(value, 1, 2147483647); return value; };
const request = (value: string) => /^[0-9a-f]{32}$/.test(value) ? value : invalid();
const time = (value: string, min = 0) => integer(value, min, 9999999999);
const signedInteger = (value: string) => {
  if (!/^(?:0|-?[1-9]\d*)$/.test(value)) return invalid();
  const n = Number(value);
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) return invalid();
  return n;
};
const flag = (value: string) => value === "1" ? true : value === "0" ? false : invalid();
const text = (value: string, max = 120) => {
  if (!value || value.length > max || value.trim() !== value || /[\x00-\x1f\x7f-\x9f\ufffd]/.test(value)) return invalid();
  return value;
};

/** Fixed decimal only, at most 15 integer and 10 fractional digits; keep the original lexeme. */
const decimal = (value: string, sign: "signed" | "nonnegative" | "positive" = "nonnegative") => {
  if (typeof value !== "string" || value.length > 27 || !/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,10})?$/.test(value)) return invalid();
  const zero = /^-?0(?:\.0+)?$/.test(value);
  if (sign !== "signed" && value.startsWith("-") && !zero) return invalid();
  if (sign === "positive" && zero) return invalid();
  return value;
};

function parseOrder(row: string): AccountOrder {
  const f = row.split(",");
  if (f.length !== 14) return invalid();
  return {
    ticket: login(f[0]), kind: integer(f[1], 0, 5), symbol: text(f[2]), lots: decimal(f[3], "positive"),
    openPrice: decimal(f[4], "positive"), openTime: time(f[5], 1), stopLoss: decimal(f[6]), takeProfit: decimal(f[7]),
    expiration: time(f[8]), profit: decimal(f[9], "signed"), swap: decimal(f[10], "signed"), commission: decimal(f[11], "signed"),
    magic: signedInteger(f[12]), closePrice: decimal(f[13]),
  };
}

function parsePage(p: string[]): AccountPage {
  if (p.length !== 19) return invalid();
  const total = integer(p[16], 0, MAX_ACCOUNT_ORDERS);
  const offset = integer(p[17], 0, MAX_ACCOUNT_ORDERS);
  const rows = p[18] ? p[18].split(";") : [];
  if (total === 0 ? offset !== 0 || rows.length !== 0
    : offset >= total || offset % ORDERS_PER_PAGE !== 0 || rows.length !== Math.min(ORDERS_PER_PAGE, total - offset)) return invalid();
  return {
    type: "account-page", session: p[2], request: request(p[3]), login: login(p[4]), broker: text(p[5]), currency: text(p[6]), demo: flag(p[7]),
    balance: decimal(p[8], "signed"), equity: decimal(p[9], "signed"), margin: decimal(p[10]), freeMargin: decimal(p[11], "signed"), profit: decimal(p[12], "signed"),
    leverage: integer(p[13], 1, 1000000), ready: flag(p[14]), capturedAt: time(p[15], 1), total, offset, orders: rows.map(parseOrder),
  };
}

// Fixed-scale integer comparison avoids losing the last decimal place at the lexical upper bound.
const scaled = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10000000000n + BigInt(fraction.padEnd(10, "0"));
};

function parseConditions(p: string[]): Conditions {
  if (p.length !== 27) return invalid();
  const bid = decimal(p[6], "positive"), ask = decimal(p[7], "positive");
  const minLots = decimal(p[11], "positive"), maxLots = decimal(p[12], "positive"), lotStep = decimal(p[13], "positive");
  if (scaled(ask) < scaled(bid) || scaled(maxLots) < scaled(minLots) || scaled(lotStep) > scaled(maxLots)) return invalid();
  return {
    type: "conditions", session: p[2], request: request(p[3]), login: login(p[4]), symbol: text(p[5]), bid, ask,
    digits: integer(p[8], 0, 10), point: decimal(p[9], "positive"), tickSize: decimal(p[10], "positive"), minLots, maxLots, lotStep,
    stopLevel: integer(p[14], 0, 2147483647), freezeLevel: integer(p[15], 0, 2147483647), tradeAllowed: flag(p[16]), quoteTime: time(p[17], 1),
    tickValue: decimal(p[18]), contractSize: decimal(p[19], "positive"), marginRequired: decimal(p[20]),
    swapLong: decimal(p[21], "signed"), swapShort: decimal(p[22], "signed"), swapType: integer(p[23], 0, 3),
    profitCurrency: p[24] === "" ? "" : text(p[24]), starting: time(p[25]), expiration: time(p[26]),
  };
}

function parseResult(p: string[]): TradeResult {
  if (p.length !== 9) return invalid();
  const status = p[5];
  if (status !== "succeeded" && status !== "rejected" && status !== "unknown") return invalid();
  const ticket = integer(p[6], 0, 2147483647), code = integer(p[7], 0, 2147483647);
  if (status === "succeeded" ? ticket === 0 || code !== 0 : ticket !== 0 || (status === "rejected" && code === 0)) return invalid();
  return { type: "trade-result", session: p[2], request: request(p[3]), login: login(p[4]), status, ticket: p[6], code, message: text(p[8], 512) };
}

function parseReadError(p: string[]): ReadError {
  if (p.length !== 6) return invalid();
  integer(p[4], 0, 2147483647);
  return { type: "read-error", session: p[2], request: request(p[3]), login: p[4], message: text(p[5], 512) };
}

export function parseAccountMessage(p: string[]): AccountMessage {
  if (p[0] === "V") return parsePage(p);
  if (p[0] === "P") return parseConditions(p);
  if (p[0] === "X") return parseResult(p);
  if (p[0] === "E") return parseReadError(p);
  if (p[0] !== "I" || p.length < 8 || p.length > 10) return invalid();
  return {
    type: "account-hello", session: p[2], login: login(p[3]), currency: text(p[4]),
    demo: flag(p[5]), enabled: flag(p[6]), ready: flag(p[7]),
    maxLots: p.length >= 9 ? decimal(p[8], "signed") : null,
    realEnabled: p.length === 10 ? flag(p[9]) : false,
  };
}
