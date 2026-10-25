// REST v1 over real HTTP: a real server and database in temp folders, fake EAs over real ZeroMQ, HST fixtures and a
// fake clock. Readonly and trader keys as the CLI sends them, and the app window's session.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { openDatabase, startServer, type ServerConfig } from "../src/server/index.js";
import { SettingsStore } from "../src/shared/settings-store.js";
import { conditionsWire, deliver, LOGIN, pageWire, type Announcement, type Page } from "./account-fixtures.js";
import { FakeClock, FakeEA, fakeTerminalIdentity, type FakeEAOptions } from "./fake-ea.js";
import { freePort } from "./free-port.js";

export const TOKEN = "window-token-0123456789";
export const HOUR = 3600;
export const DAY = 86400;
export const DEMO = "EasyForex-Demo";
export const REAL = "EasyForex-Real";
export const TERMINAL = "mt4-aaaaaaaaaaaa";
export const OTHER_TERMINAL = "mt4-bbbbbbbbbbbb";
/** The server's clock: 15 January 2027 08:00 UTC, 10:00 on the GMT+2 brokers (winter). */
export const NOW = Date.UTC(2027, 0, 15, 8);
/** Broker seconds of 15 January 2027 00:00. */
export const MIDNIGHT = Date.UTC(2027, 0, 15) / 1000;
/** UTC milliseconds of a broker time in seconds, on the GMT+2 brokers in winter. */
export const utcMs = (broker: number) => (broker - 2 * HOUR) * 1000;
/** UTC ISO of a broker time in seconds, on the GMT+2 brokers in winter. */
export const utcIso = (broker: number) => new Date(utcMs(broker)).toISOString();
/** Broker time in seconds as the API writes it: ISO without an offset. */
export const brokerIso = (broker: number) => new Date(broker * 1000).toISOString().slice(0, 19);

export type Json = Record<string, any>;

export async function tempFolder(t: TestContext, name: string) {
  const folder = await mkdtemp(join(tmpdir(), `quotebridge-${name}-`));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

export type StartOptions = { dataFolders?: Record<string, string>; clock?: FakeClock; overrides?: Partial<ServerConfig>; trading?: boolean };

/** A server with its database in `dbFolder`; each terminal's data folder is `dataFolders[terminalId]`. */
export async function startRest(t: TestContext, dbFolder: string, options: StartOptions = {}) {
  const clock = options.clock ?? new FakeClock(NOW);
  const dataFolders = options.dataFolders ?? {};
  const database = await openDatabase(dbFolder);
  const store = new SettingsStore(join(dbFolder, "settings"));
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    resolveTerminal: fakeTerminalIdentity,
    now: clock.now,
    localOffsetMinutes: () => 0,
    terminalDataFolder: (terminalId) => dataFolders[terminalId],
    database,
    settings: { store },
    ...options.overrides,
  };
  const server = await startServer(cfg);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.close();
    await database.checkpointAndClose();
  };
  t.after(stop);
  const origin = server.httpOrigin;
  const signIn = await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" });
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  /** As the app window. */
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(res.ok, `${path}: ${res.status} ${await res.clone().text()}`);
    return (await res.json()) as Json;
  };
  const windowGet = async (path: string) => (await (await fetch(`${origin}${path}`, { headers: { cookie } })).json()) as Json;
  for (const brokerServer of [DEMO, REAL]) await post("/api/clock-rules", { brokerServer, winterOffsetMinutes: 120, dst: "us" });
  if (options.trading) await post("/api/settings", { trading: { enabled: true, maxLots: "1.0", slippage: 20 } });
  const readonlyKey = (await post("/api/api-keys", { name: "Reader", scope: "readonly" })).key as string;
  const traderKey = (await post("/api/api-keys", { name: "Trader", scope: "trader" })).key as string;
  const otherTraderKey = (await post("/api/api-keys", { name: "Other trader", scope: "trader" })).key as string;
  const url = (path: string, query: Record<string, string | number> = {}) => {
    const search = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    return `${origin}${path}${search.size ? `?${search}` : ""}`;
  };
  /** As the CLI: a Bearer key, no cookie. */
  const cli = (path: string, query: Record<string, string | number> = {}, init: RequestInit & { key?: string } = {}) => {
    const { key = readonlyKey, ...rest } = init;
    return fetch(url(path, query), { ...rest, headers: { authorization: `Bearer ${key}`, ...(rest.body ? { "content-type": "application/json" } : {}) } });
  };
  /** The JSON of a CLI GET, asserting its status. */
  const read = async (path: string, query: Record<string, string | number> = {}, status = 200, key = readonlyKey) => {
    const res = await cli(path, query, { key });
    assert.equal(res.status, status, `${path}: ${await res.clone().text()}`);
    return (await res.json()) as Json;
  };
  /** The JSON of a CLI POST with a trader key, asserting its status. */
  const send = async (path: string, body: unknown, status = 200, key = traderKey) => {
    const res = await cli(path, {}, { key, method: "POST", body: JSON.stringify(body) });
    assert.equal(res.status, status, `${path}: ${await res.clone().text()}`);
    return (await res.json()) as Json;
  };
  const connect = async (options: FakeEAOptions = {}) => {
    const ea = new FakeEA({ terminal: TERMINAL, broker: DEMO, symbol: "EURUSD", digits: 5, ...options }).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
    t.after(() => ea.close());
    await ea.request(ea.helloWire());
    return ea;
  };
  /** Sends quotes and waits until the feed shows the last one. */
  const quote = async (ea: FakeEA, quotes: { seq: number; bid: number; ask: number; quoteTime: number }[]) => {
    await ea.ticks(quotes);
    const last = quotes.at(-1)!;
    for (let i = 0; ; i++) {
      const state = (await windowGet("/api/state")) as { feeds: Json[] };
      if (state.feeds.some((f) => f.terminal === ea.terminal && f.symbol === ea.symbol && f.latest?.seq === last.seq)) return;
      if (i > 100) assert.fail("the quotes did not arrive");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** Announces the chart's account (EA 1.12 I message); answers its ID. */
  const announce = async (ea: FakeEA, a: Announcement = {}) => {
    const fields = ["I", "1", ea.session, a.login ?? LOGIN, a.currency ?? "USD", Number(a.demo ?? true), Number(a.enabled ?? false), Number(a.ready ?? true)];
    if (a.maxLots !== null) fields.push(a.maxLots ?? "0.5000000000");
    await deliver(server.bridge, ea, fields.join("|"));
    const account = server.bridge.accounts.list().find((s) => s.login === (a.login ?? LOGIN) && s.brokerServer === ea.broker);
    assert.ok(account);
    return account.id;
  };
  /** Answers the EA's next account (V) or conditions (P) reads with fresh fixtures, until `count` are answered. */
  const answer = async (ea: FakeEA, count: number, page: Page = {}) => {
    for (let n = 0; n < count; n++) {
      let wire = await ea.receive();
      // A chart that connects is asked for its bars (M3 chart history); these fixtures have none to give.
      while (wire.startsWith("G|")) wire = await ea.receive();
      const f = wire.split("|");
      assert.ok(f[0] === "V" || f[0] === "P", wire);
      const now = Math.floor(clock.now() / 1000) + 2 * HOUR;
      const response = f[0] === "V" ? pageWire(ea, f[3], { capturedAt: now, ...page })
        : conditionsWire(ea, f[3], f[6], page.login ?? LOGIN).replace("|0|1700000002|", `|1|${now}|`);
      await deliver(server.bridge, ea, response);
    }
  };
  return { server, clock, origin, cookie, cli, read, send, post, windowGet, connect, quote, announce, answer, stop, readonlyKey, traderKey, otherTraderKey, url };
}

export type RestApp = Awaited<ReturnType<typeof startRest>>;
