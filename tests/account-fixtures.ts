// Synthetic account fixtures use real ZeroMQ; only clock and terminal-catalog identity are substituted.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { BridgeServer } from "../src/server/bridge/index.js";
import type { AccountBinding } from "../src/server/bridge/accounts.js";
import { FakeClock, FakeEA, fakeTerminalIdentity, freeEndpoint, type FakeEAOptions } from "./fake-ea.js";

export const LOGIN = "876543219";
export const OTHER_LOGIN = "876543220";
export const UNUSED_REQUEST = "f".repeat(32);
export type Announcement = { login?: string; currency?: string; demo?: boolean; enabled?: boolean; ready?: boolean; maxLots?: string | null; realEnabled?: boolean };
export type Page = {
  login?: string; broker?: string; currency?: string; demo?: boolean; balance?: string; equity?: string;
  margin?: string; freeMargin?: string; profit?: string; leverage?: number; ready?: boolean;
  capturedAt?: number; total?: number; offset?: number; rows?: string[];
};
export const orderRow = (ticket: number, kind = 0, symbol = "EURUSD") =>
  `${ticket},${kind},${symbol},0.1000000000,1.1000000000,1700000000,0,0,0,-1.25,0,0,-42,1.09`;
export const firstTwenty = () => Array.from({ length: 20 }, (_, i) => orderRow(i + 1));
export const pageWire = (ea: FakeEA, request: string, p: Page = {}) => [
  "V", "1", ea.session, request, p.login ?? LOGIN, p.broker ?? ea.broker, p.currency ?? "USD", Number(p.demo ?? true),
  p.balance ?? "1000.0000000000", p.equity ?? "999.0000000000", p.margin ?? "10.0000000000",
  p.freeMargin ?? "989.0000000000", p.profit ?? "-1.0000000000", p.leverage ?? 100,
  Number(p.ready ?? true), p.capturedAt ?? 1700000001, p.total ?? 0, p.offset ?? 0, (p.rows ?? []).join(";"),
].join("|");
export const conditionsWire = (ea: FakeEA, request: string, symbol = "EURUSD", login = LOGIN) =>
  `P|1|${ea.session}|${request}|${login}|${symbol}|1.1000000000|1.1000200000|5|0.0000100000|0.0000100000|0.0100000000|100.0000000000|0.0100000000|10|5|0|1700000002|1.0000000000|100000.0000000000|1000.0000000000|-1.2500000000|0.5000000000|0|USD|0|0`;
export const resultWire = (ea: FakeEA, request: string, login = LOGIN) =>
  `X|1|${ea.session}|${request}|${login}|succeeded|101|0|MT4 confirmed operation`;

/** Wait for actual handling, not a sleep or a guessed socket delivery interval. Account messages have no ACK. */
export async function deliver(bridge: BridgeServer, ea: FakeEA, wire: string) {
  let off = () => {};
  let timer: NodeJS.Timeout;
  const handled = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(Error("Account fixture message was not handled")), 2000);
    off = bridge.onChange(resolve);
  });
  try { await ea.send(wire); await handled; }
  finally { off(); clearTimeout(timer!); }
}

export async function heartbeat(bridge: BridgeServer, ea: FakeEA, active = 1) {
  await deliver(bridge, ea, ea.helloWire());
  assert.equal(await ea.receive(), `C|1|${ea.session}|${active}`);
}

export async function startAccounts(t: TestContext) {
  const clock = new FakeClock();
  const bridge = new BridgeServer({ now: clock.now, resolveTerminal: fakeTerminalIdentity });
  const endpoint = await freeEndpoint();
  await bridge.start(endpoint);
  t.after(() => bridge.close());
  let serial = 0;
  const connect = async (options: FakeEAOptions = {}) => {
    const n = ++serial;
    // Separate feeds avoid unrelated subscription C replies in the account request inbox.
    const ea = new FakeEA({ terminal: `mt4-account-${n}`, symbol: `FIXTURE${n}`, ...options }).connect(endpoint);
    t.after(() => ea.close());
    await heartbeat(bridge, ea);
    return ea;
  };
  const announce = async (ea: FakeEA, a: Announcement = {}) => {
    const fields = ["I", "1", ea.session, a.login ?? LOGIN, a.currency ?? "USD", Number(a.demo ?? true), Number(a.enabled ?? false), Number(a.ready ?? true)];
    if (a.maxLots !== null) fields.push(a.maxLots ?? "0.5000000000");
    // EA 1.13 appends EnableRealTrading; fixtures without it are the older EA.
    if (a.realEnabled !== undefined) fields.push(String(Number(a.realEnabled)));
    await deliver(bridge, ea, fields.join("|"));
    const account = bridge.accounts.list().find((s) => s.login === (a.login ?? LOGIN) && s.brokerServer === ea.broker);
    assert.ok(account, "announcement exposes an account through the public service");
    return account;
  };
  return { bridge, clock, connect, announce };
}

/** Validate the actual outgoing read, never send an order command. */
export async function readRequest(ea: FakeEA, kind: "V" | "P", login = LOGIN, symbol = "EURUSD") {
  const wire = await ea.receive();
  const fields = wire.split("|");
  assert.match(fields[3], /^[0-9a-f]{32}$/);
  assert.equal(wire, `${kind}|1|${ea.session}|${fields[3]}|${login}|${ea.broker}${kind === "P" ? `|${symbol}` : ""}`);
  return fields[3];
}

export async function publishSnapshot(bridge: BridgeServer, ea: FakeEA, id: string, page: Page = {}) {
  const reading = bridge.accounts.read(id);
  const request = await readRequest(ea, "V", page.login ?? LOGIN);
  await deliver(bridge, ea, pageWire(ea, request, page));
  return reading;
}

export function bindingOf(source: AccountBinding): AccountBinding {
  return { accountId: source.accountId, terminalId: source.terminalId, brokerServer: source.brokerServer, session: source.session, login: source.login };
}
export const readError = (code: string, status: number) => (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal((error as Error & { code: string }).code, code);
  assert.equal((error as Error & { status: number }).status, status);
  return true;
};
