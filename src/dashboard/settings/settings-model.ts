// The Settings view's model: reading a typed port, what a port change will do, the note shown when the server
// runs on other ports than the saved ones (a development run's overrides), the Recording list and the API keys.
import type { ApiKeyView } from "../../server/auth/index.js";
import type { RecordingView } from "../../server/recording/index.js";
import type { SettingsView } from "../../server/settings/index.js";
import type { AccountView } from "../trading/trading-model.js";
import type { TimeShown } from "../../shared/settings-store.js";
import { browserOffsetMinutes, displaySeconds } from "../display-clock.js";
import { count, minuteStamp } from "../format.js";

export type PortRole = "ea" | "http";

export const PORT_LABELS: Record<PortRole, string> = { ea: "EA port", http: "Dashboard port" };
const IN_SENTENCE: Record<PortRole, string> = { ea: "EA port", http: "dashboard port" };

/** The typed port, or why it cannot be used (the server checks again, and whether it is free). */
export function parsePort(text: string, role: PortRole, view: SettingsView): { port: number } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { error: "Type a port number." };
  const port = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || port < 1024 || port > 65535) return { error: "Use a whole number from 1024 to 65535." };
  const other: PortRole = role === "ea" ? "http" : "ea";
  if (port === view.ports[other]) return { error: `The ${IN_SENTENCE[other]} already uses ${port}.` };
  if (port === view.ports[role]) return { error: `The ${IN_SENTENCE[role]} is already ${port}.` };
  return { port };
}

/** The confirmation for a port change: what restarts, and what the user must do in MetaTrader afterwards. */
export function portChange(role: PortRole, port: number, managedTerminals: number): { title: string; body: string; confirm: string } {
  const title = `Change the ${IN_SENTENCE[role]} to ${port}?`;
  const confirm = `Restart on port ${port}`;
  if (role === "http") {
    return { title, confirm, body: "QuoteBridge restarts on the new port and this window reconnects by itself. Nothing changes in MetaTrader." };
  }
  const terminals =
    managedTerminals === 0 ? "" : ` The QuoteBridge template in your ${managedTerminals === 1 ? "managed terminal" : `${managedTerminals} managed terminals`} is updated.`;
  return {
    title,
    confirm,
    body: `QuoteBridge restarts on the new port.${terminals} Charts already running the EA keep the old port and stop sending quotes: apply the QuoteBridge template to each chart again.`,
  };
}

/** Null while the server runs on the saved ports. */
export function portsNote(view: SettingsView): string | null {
  const { ports, portsInUse } = view;
  if (ports.ea === portsInUse.ea && ports.http === portsInUse.http) return null;
  return `This run listens on EA port ${portsInUse.ea} and dashboard port ${portsInUse.http}: a development run's port overrides win over the saved ports.`;
}

/** One market of Settings › Recording, as shown. */
export type RecordingRow = {
  key: string;
  symbol: string;
  brokerServer: string;
  /** "Recording since 2027-01-15 10:00", or "Stopped". */
  state: string;
  /** "1,234,567 samples", "1 sample", "No samples yet". */
  samples: string;
  /** "2027-01-15 10:00 to 2027-01-16 23:59" on the chosen clock; empty without samples. */
  range: string;
  /** "about 39.5 MB": an estimate. */
  size: string;
  canStop: boolean;
  canDelete: boolean;
};

/** `localOffsetMinutes` is this computer's offset from UTC (injectable for tests). */
export function recordingRows(recordings: readonly RecordingView[], shown: TimeShown, localOffsetMinutes = browserOffsetMinutes): RecordingRow[] {
  return recordings.map((r) => {
    const when = (utcMs: number) => minuteStamp(displaySeconds({ shown, rule: r.clockRule, localOffsetMinutes }, utcMs / 1000));
    return {
      key: `${r.brokerServer}\n${r.symbol}`,
      symbol: r.symbol,
      brokerServer: r.brokerServer,
      state: r.recording ? (r.recordingSince === null ? "Recording" : `Recording since ${when(r.recordingSince)}`) : "Stopped",
      samples: r.samples === 0 ? "No samples yet" : sampleCount(r.samples),
      range: r.first === null || r.last === null ? "" : `${when(r.first)} to ${when(r.last)}`,
      size: `about ${bytes(r.aboutBytes)}`,
      canStop: r.recording,
      canDelete: r.samples > 0,
    };
  });
}

/** The confirmation for Delete data…. */
export function deleteRecording(r: Pick<RecordingView, "symbol" | "brokerServer" | "samples" | "recording">): { title: string; body: string; confirm: string } {
  const goes = r.recording ? " Recording goes on: new samples are kept from now." : "";
  return {
    title: `Delete the recorded data of ${r.symbol} on ${r.brokerServer}?`,
    body: `${sampleCount(r.samples)} ${r.samples === 1 ? "is" : "are"} deleted. This cannot be undone.${goes}`,
    confirm: `Delete ${sampleCount(r.samples)}`,
  };
}

const sampleCount = (n: number) => `${count(n)} ${n === 1 ? "sample" : "samples"}`;

function bytes(n: number): string {
  if (n < 1000) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** One key of Settings › API keys, as shown. */
export type ApiKeyRow = {
  id: string;
  name: string;
  /** "qbk_1a2b3c4d…": enough to tell keys apart, never the key. */
  prefix: string;
  /** "Readonly" or "Trader". */
  scope: string;
  /** "Created 2027-01-15 09:00". */
  created: string;
  /** "Last used 2027-01-15 10:30", or "Never used". */
  lastUsed: string;
};

/**
 * Keys are the app's own, not a broker's: their times are on this computer's clock, or in UTC when times are shown in
 * UTC. `localOffsetMinutes` is this computer's offset from UTC (injectable for tests).
 */
export function apiKeyRows(keys: readonly ApiKeyView[], shown: TimeShown, localOffsetMinutes = browserOffsetMinutes): ApiKeyRow[] {
  const when = (utcMs: number) => minuteStamp(displaySeconds({ shown: shown === "utc" ? "utc" : "local", rule: null, localOffsetMinutes }, utcMs / 1000));
  return keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: `${k.prefix}…`,
    scope: k.scope === "trader" ? "Trader" : "Readonly",
    created: `Created ${when(k.createdAt)}`,
    lastUsed: k.lastUsedAt === null ? "Never used" : `Last used ${when(k.lastUsedAt)}`,
  }));
}

/** The confirmation for Revoke. */
export function revokeApiKey(k: Pick<ApiKeyView, "name">): { title: string; body: string; confirm: string } {
  return {
    title: `Revoke the API key “${k.name}”?`,
    body: "Anything using it is refused from now on. This cannot be undone: make a new key to give access again.",
    confirm: "Revoke key",
  };
}

type TradingSettings = SettingsView["trading"];

/**
 * Settings › Trading: the trading settings with the app's lot cap or the slippage set to what was typed, or why it
 * cannot be. The server checks the same.
 */
export function tradingChange(trading: TradingSettings, field: "maxLots" | "slippage", text: string): { trading: TradingSettings } | { error: string } {
  const value = text.trim();
  if (field === "maxLots") {
    if (!/^(?:0|[1-9]\d{0,14})(?:\.\d{1,10})?$/.test(value) || !/[1-9]/.test(value)) return { error: "The lot cap is a positive number of lots, such as 0.5." };
    return { trading: { ...trading, maxLots: value } };
  }
  if (!/^\d{1,5}$/.test(value) || Number(value) > 10000) return { error: "Slippage is a whole number of points from 0 to 10000." };
  return { trading: { ...trading, slippage: Number(value) } };
}

type OrderDefaults = SettingsView["orderDefaults"][number];
type Market = Pick<OrderDefaults, "brokerServer" | "symbol">;
/** A market's order defaults as typed in Settings › Trading; empty means not set. */
export type OrderDefaultsText = { lots: string; stopLossPoints: string; takeProfitPoints: string };

/** As the settings store checks it; a copy here, so the dashboard bundle takes nothing of the store's file code. */
const POSITIVE_DECIMAL = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,10})?$/;
/** One market's key, for a row or an option. */
export const marketKey = (m: Market) => JSON.stringify([m.brokerServer, m.symbol]);

/** A market's saved order defaults as their inputs show them. */
export function orderDefaultsText(d: OrderDefaults): OrderDefaultsText {
  return { lots: d.lots ?? "", stopLossPoints: d.stopLossPoints ?? "", takeProfitPoints: d.takeProfitPoints ?? "" };
}

/**
 * Settings › Trading › Order defaults: the list with `market`'s row set to what was typed (in place, or added at the
 * end), or why it cannot be. The server checks the same.
 */
export function orderDefaultsChange(list: readonly OrderDefaults[], market: Market, text: OrderDefaultsText): { orderDefaults: OrderDefaults[] } | { error: string } {
  const read = (value: string) => value.trim() || null;
  const entry: OrderDefaults = { brokerServer: market.brokerServer, symbol: market.symbol, lots: read(text.lots), stopLossPoints: read(text.stopLossPoints), takeProfitPoints: read(text.takeProfitPoints) };
  if (entry.lots === null && entry.stopLossPoints === null && entry.takeProfitPoints === null) return { error: "Set at least one of lots, stop loss or take profit, or remove the market." };
  const bad = (value: string | null) => value !== null && (!POSITIVE_DECIMAL.test(value) || !/[1-9]/.test(value));
  if (bad(entry.lots)) return { error: "Lots is a positive number, such as 0.1." };
  if (bad(entry.stopLossPoints) || bad(entry.takeProfitPoints)) return { error: "A stop distance is a positive number of points, such as 200." };
  const at = list.findIndex((d) => marketKey(d) === marketKey(market));
  return { orderDefaults: at < 0 ? [...list, entry] : list.map((d, i) => (i === at ? entry : d)) };
}

/** The list without `market`'s row. */
export function removeOrderDefaults(list: readonly OrderDefaults[], market: Market): OrderDefaults[] {
  return list.filter((d) => marketKey(d) !== marketKey(market));
}

/** The part of a market's conditions (`GET …/markets/{market}/conditions`) the order defaults form explains. */
export type MarketConditions = {
  bid: string;
  ask: string;
  digits: number;
  point: string;
  tickSize: string;
  tickValue: string;
  minLots: string;
  maxLots: string;
  lotStep: string;
  stopLevel: number;
};

/** A typed value's note: what a stop distance means, and why Preview refuses the value. */
export type FieldNote = { meaning?: string; refused?: string };
/** What the market defines, in sentences, and a note per typed value. */
export type OrderDefaultsFacts = { facts: string[]; notes: Partial<Record<keyof OrderDefaultsText, FieldNote>> };

const SCALE = 10n ** 10n;
/** A positive decimal as an exact count of 1e-10s. */
const units = (value: string): bigint => {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(10, "0").slice(0, 10));
};
const fromUnits = (n: bigint): string => `${n / SCALE}.${(n % SCALE).toString().padStart(10, "0")}`.replace(/\.?0+$/, "");
/** About-money: three significant digits, without trailing zeros. */
const about = (n: number): string => Number(n.toPrecision(3)).toLocaleString("en-US", { maximumFractionDigits: 10 });
const typed = (value: string): string | undefined => {
  const v = value.trim();
  return POSITIVE_DECIMAL.test(v) && /[1-9]/.test(v) ? v : undefined;
};

/**
 * Settings › Trading › Order defaults: the market's own figures (from a terminal's conditions read) for choosing its
 * defaults. Money is in the account's `currency`, from MetaTrader's tick value; notes never stop a save, as Preview
 * checks again against the figures of that moment.
 */
export function orderDefaultsFacts(c: MarketConditions, currency: string | null, lotCap: string, text: OrderDefaultsText): OrderDefaultsFacts {
  const pointMoney = (Number(c.tickValue) * Number(c.point)) / Number(c.tickSize);
  // ", about 10 USD at 0.05 lots", or a lot when none are typed; nothing without the account's currency.
  const money = (points: number, lots?: string) =>
    currency === null ? "" : `, about ${about(points * pointMoney * Number(lots ?? 1))} ${currency} ${lots ? `at ${lots} lots` : "a lot"}`;
  const spread = Number((units(c.ask) - units(c.bid)) / units(c.point));
  const facts = [
    `1 point is ${fromUnits(units(c.point))} in price${money(1)}.`,
    `Lots: ${c.minLots} to ${c.maxLots}, in steps of ${c.lotStep}. The app's lot cap is ${lotCap}.`,
    c.stopLevel > 0
      ? `Stops: at least ${count(c.stopLevel)} points from the closing price (Bid for a buy, Ask for a sell), no maximum.`
      : "Stops: the broker sets no minimum distance, and there is no maximum.",
    `Spread now: ${count(spread)} points. A market order's stop loss also spans it.`,
  ];

  const notes: OrderDefaultsFacts["notes"] = {};
  const lots = typed(text.lots);
  if (lots !== undefined) {
    const n = units(lots);
    const refused =
      n < units(c.minLots) ? `Below the market's minimum of ${c.minLots} lots`
      : n > units(c.maxLots) ? `Above the market's maximum of ${c.maxLots} lots`
      : n > units(lotCap) ? `Above the app's lot cap of ${lotCap}`
      : n % units(c.lotStep) ? `Not a whole number of lot steps of ${c.lotStep}`
      : undefined;
    if (refused) notes.lots = { refused: `${refused}: Preview refuses it.` };
  }
  for (const field of ["stopLossPoints", "takeProfitPoints"] as const) {
    const points = typed(text[field]);
    if (points === undefined) continue;
    const d = Number(points);
    const why = field === "stopLossPoints" ? stopLossTooClose(d, c.stopLevel, spread) : takeProfitTooClose(d, c.stopLevel, spread);
    notes[field] = { meaning: `${fromUnits((units(points) * units(c.point)) / SCALE)} in price${money(d, lots)}.`, ...(why && { refused: why }) };
  }
  return { facts, notes };
}

/*
 * Stops are measured from the closing price (Bid for a buy, Ask for a sell), and a pending order's from its entry; a
 * distance is from the entry, which for a market order is the opening price, a spread away from the closing one. So a
 * market order's stop loss needs the stop level plus the spread, and its take profit the stop level less the spread.
 */
function stopLossTooClose(points: number, stopLevel: number, spread: number): string | undefined {
  if (points >= stopLevel + spread && points > spread) return undefined;
  return stopLevel > 0
    ? `Too close: a market order's stop loss needs at least ${count(stopLevel + spread)} points now (the broker's minimum of ${count(stopLevel)} plus the spread of ${count(spread)}), so Preview refuses it.`
    : `Too close: a market order's stop loss needs more than the spread of ${count(spread)} points now, so Preview refuses it.`;
}
function takeProfitTooClose(points: number, stopLevel: number, spread: number): string | undefined {
  if (points < stopLevel - spread) return `Too close: the broker's minimum is ${count(stopLevel)} points and the spread now ${count(spread)}, so Preview refuses it.`;
  if (points < stopLevel) return `Under the broker's minimum of ${count(stopLevel)} points, so Preview refuses it for a pending order.`;
  return undefined;
}

type FactsAccount = Pick<AccountView, "id" | "brokerServer" | "connected" | "demo">;

/** The account whose terminal the market's figures are read through: a connected one on its broker server, demo first. */
export function factsAccount<A extends FactsAccount>(accounts: readonly A[], market: Market): A | undefined {
  const here = accounts.filter((a) => a.connected && a.brokerServer === market.brokerServer);
  return here.find((a) => a.demo === true) ?? here[0];
}
