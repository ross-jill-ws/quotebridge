// The Settings view's model: reading a typed port, what a port change will do, the note shown when the server
// runs on other ports than the saved ones (a development run's overrides), the Recording list and the API keys.
import type { ApiKeyView } from "../../server/auth/index.js";
import type { RecordingView } from "../../server/recording/index.js";
import type { SettingsView } from "../../server/settings/index.js";
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
