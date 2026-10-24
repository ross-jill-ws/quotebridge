// Seam 1 for the Terminals view and the setup screen: the real bridge server with the bridge
// installer on fake terminals (temp folders) and a fake MetaEditor, driven over HTTP, with a fake EA
// over ZeroMQ. Nothing here touches a real terminal, MetaEditor or %APPDATA%.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase, startServer, type ServerConfig } from "../src/server/index.js";
import { DEFAULT_THRESHOLDS } from "../src/main/supervisor/index.js";
import type { TerminalsState, TerminalView } from "../src/server/terminals/index.js";
import { nodeInstallerFileSystem, type InstallerFileSystem } from "../src/server/installer/index.js";
import type { MetaEditorProcesses } from "../src/shared/metaeditor/index.js";
import { SettingsStore, type Settings } from "../src/shared/settings-store.js";
import type { TerminalSources } from "../src/shared/terminal-catalog/index.js";
import { FakeClock, FakeEA, type FakeEAOptions } from "./fake-ea.js";
import { groupFeeds } from "../src/dashboard/feeds/feed-row.js";
import type { BridgeSnapshot } from "../src/server/bridge/index.js";
import { freePort } from "./free-port.js";
import { InstallerFixture, SUCCESSFUL_COMPILE, EX4, readIfExists } from "./installer-fixtures.js";
import { FAILED_LOG, FakeMetaEditor, type FakeCompile } from "./metaeditor-fixtures.js";
import { MachineFixture, spikeMachine } from "./terminal-fixtures.js";

const TOKEN = "window-token-0123456789";

/** A fake MetaEditor whose behaviour a test can change between installs. */
class SwitchableMetaEditor implements MetaEditorProcesses {
  current: FakeMetaEditor;
  constructor(behaviour: FakeCompile) {
    this.current = new FakeMetaEditor(behaviour);
  }
  set(behaviour: FakeCompile) {
    this.current = new FakeMetaEditor(behaviour);
  }
  start(executable: string, args: string[]) {
    return this.current.start(executable, args);
  }
  runningMetaEditors() {
    return this.current.runningMetaEditors();
  }
}

async function start(t: TestContext, options: { now?: () => number; hintAfterMs?: number; compileTimeoutMs?: number; installerFs?: InstallerFileSystem; recording?: boolean } = {}) {
  const machine = await MachineFixture.create();
  t.after(() => machine.dispose());
  const spike = await spikeMachine(machine);
  const appFixture = await InstallerFixture.create();
  t.after(() => appFixture.cleanup());
  const appData = appFixture.appData;
  const settings = new SettingsStore(appData);
  const database = options.recording ? await openDatabase(appData) : undefined;
  const metaEditor = new SwitchableMetaEditor(SUCCESSFUL_COMPILE);
  const saved: Settings[] = [];
  const sources = async (userAddedFolders: string[]): Promise<TerminalSources> => ({
    dataRoot: machine.dataRoot,
    installationRoots: [machine.programFiles],
    userAddedFolders,
  });
  const cfg: ServerConfig = {
    eaPort: await freePort(),
    httpPort: await freePort(),
    windowToken: TOKEN,
    now: options.now,
    database,
    terminals: {
      appDataFolder: appData,
      settings,
      bundle: await appFixture.bundle(),
      sources,
      metaEditor,
      onSettingsSaved: (s) => saved.push(s),
      ...(options.hintAfterMs !== undefined ? { hintAfterMs: options.hintAfterMs } : {}),
      ...(options.compileTimeoutMs !== undefined ? { compileTimeoutMs: options.compileTimeoutMs } : {}),
      ...(options.installerFs ? { installerFs: options.installerFs } : {}),
    },
  };
  const server = await startServer(cfg);
  t.after(async () => { await server.close(); await database?.checkpointAndClose(); });
  const origin = server.httpOrigin;
  const res = await fetch(`${origin}/session?token=${TOKEN}`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie")!.split(";")[0];

  const get = async <T = TerminalsState>(path = "/api/terminals"): Promise<{ status: number; body: T }> => {
    const r = await fetch(origin + path, { headers: { cookie } });
    return { status: r.status, body: (await r.json()) as T };
  };
  const post = async <T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T }> => {
    const r = await fetch(origin + path, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
  const state = async () => (await get()).body;
  const terminal = async (name: string) => {
    const found = (await state()).terminals.find((x) => x.name === name);
    assert.ok(found, `no terminal ${name}`);
    return found;
  };
  /** Polls until `match` holds for the named terminal. */
  const until = async (name: string, match: (x: TerminalView) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const x = await terminal(name);
      if (match(x)) return x;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(`${name} never matched; last ${JSON.stringify(await terminal(name))}`);
  };
  const ea = (terminalId: string, options: FakeEAOptions = {}) => {
    const dataFolder = server.terminals!.dataFolder(terminalId);
    const installationFolder = dataFolder === spike.cmcData ? spike.cmc : dataFolder === spike.easyForexData ? spike.easyForex : undefined;
    const fake = new FakeEA({ terminal: terminalId, ...(installationFolder && dataFolder ? { identity: { installationFolder, dataFolder } } : {}), ...options }).connect(`tcp://127.0.0.1:${cfg.eaPort}`);
    t.after(() => fake.close());
    return fake;
  };
  return { origin, cookie, get, post, state, terminal, until, ea, machine, spike, appData, settings, saved, metaEditor, server };
}

const CMC = "CMC Markets MetaTrader 4";
const EASY_FOREX = "MT4 at easy-forex";
const EASY_MARKETS = "easyMarkets MetaTrader 5";

test("mixed chart labels in one installation share the Terminals identity and Feeds name", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const terminal = await app.terminal(EASY_FOREX);
  for (const [label, symbol] of [["mt4-main", "EURUSD"], [terminal.terminalId!, "XAUUSD"], [terminal.terminalId!, "Bitcoin"]]) {
    const chart = app.ea(label);
    const wire = `H|1|${chart.session}|${label}|Demo-Broker|${symbol}|5|500|0|ok|60|2000|1|1.11|${app.spike.easyForex}|${app.spike.easyForexData}`;
    assert.equal(await chart.request(wire), `C|1|${chart.session}|1`);
  }
  const snapshot = (await app.get<BridgeSnapshot>("/api/state")).body;
  assert.deepEqual(snapshot.terminals.map((p) => p.terminalId), [terminal.terminalId]);
  const state = await app.state();
  const names = new Map(state.terminals.flatMap((t) => t.terminalId ? [[t.terminalId, t.name] as const] : []));
  const { groups } = groupFeeds(snapshot, names, snapshot.time);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, EASY_FOREX);
  assert.deepEqual(groups[0].feeds.map((f) => f.symbol).sort(), ["Bitcoin", "EURUSD", "XAUUSD"]);
  assert.equal((await app.terminal(EASY_FOREX)).checklist.eaConnected, true);
});

test("a previously verified chart loses its subscription when its identity becomes unverifiable", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const terminal = await app.terminal(EASY_FOREX);
  const chart = app.ea(terminal.terminalId!);
  assert.equal(await chart.request(chart.helloWire()), `C|1|${chart.session}|1`);
  assert.equal(await chart.request(chart.helloWire().split("|").slice(0, 14).join("|")), `C|1|${chart.session}|0`);
  assert.equal(await chart.request(chart.tickWire([{ seq: 1, bid: 1.1, ask: 1.2, quoteTime: 1800000000 }])), `R|1|${chart.session}`);
  assert.deepEqual((await app.get<BridgeSnapshot>("/api/state")).body.feeds, []);
});

test("a broker switch keeps the installation ID but never relabels its old quotes or accepts old-chart samples", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const terminal = await app.terminal(EASY_FOREX);
  const chart = app.ea(terminal.terminalId!, { terminal: "mt4-main", broker: "Demo-Broker" });
  const gold = app.ea(terminal.terminalId!, { symbol: "XAUUSD", broker: "Demo-Broker" });
  await chart.request(chart.helloWire());
  await gold.request(gold.helloWire());
  await chart.request(chart.tickWire([{ seq: 1, bid: 1.1, ask: 1.2, quoteTime: 1800000000 }]));
  const switched = app.ea(terminal.terminalId!, { broker: "Other-Broker" });
  await switched.request(switched.helloWire());
  const snapshot = (await app.get<BridgeSnapshot>("/api/state")).body;
  assert.deepEqual(snapshot.terminals.map((p) => [p.terminalId, p.brokerServer]), [[terminal.terminalId, "Other-Broker"]]);
  assert.deepEqual(snapshot.feeds.map((f) => [f.symbol, f.market.brokerServer, f.latest]), [["EURUSD", "Other-Broker", undefined]]);
  assert.equal(await gold.request(gold.tickWire([{ seq: 1, bid: 2000, ask: 2001, quoteTime: 1800000001 }])), `R|1|${gold.session}`);
  assert.equal(await gold.request(gold.helloWire()), `C|1|${gold.session}|0`, "an old-market session cannot flip the terminal back");
  assert.deepEqual((await app.get<BridgeSnapshot>("/api/state")).body.terminals.map((p) => p.brokerServer), ["Other-Broker"]);
});

test("separate installations sharing broker, login, symbol and default label stay distinct", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const terminals = await Promise.all([app.terminal(CMC), app.terminal(EASY_FOREX)]);
  for (const terminal of terminals) {
    const chart = app.ea(terminal.terminalId!, { terminal: "mt4-main" });
    assert.equal(await chart.request(chart.helloWire()), `C|1|${chart.session}|1`);
    await chart.send(`I|1|${chart.session}|12345678|USD|1|0|1`); // Synthetic login, shared by both fixtures.
    await chart.request(chart.helloWire());
  }
  const snapshot = (await app.get<BridgeSnapshot>("/api/state")).body;
  assert.deepEqual(snapshot.terminals.map((p) => p.terminalId).sort(), terminals.map((t) => t.terminalId).sort());
  assert.equal(snapshot.feeds.length, 2);
  assert.ok(snapshot.feeds.every((f) => f.instances === 1));
  assert.ok((await app.state()).terminals.filter((t) => t.kind === "mt4").every((t) => t.checklist.eaConnected));
});

test("label changes, replay, reconnect and EA restart keep one canonical feed and do not repeat accepted samples", { timeout: 15000 }, async (t) => {
  const clock = new FakeClock();
  const app = await start(t, { now: clock.now });
  const terminal = await app.terminal(EASY_FOREX);
  const chart = app.ea(terminal.terminalId!, { terminal: "mt4-main", session: "chart-reconnect" });
  const samples: unknown[] = [];
  app.server.bridge.onSamples((event) => { if (event.type === "samples") samples.push(...event.samples); });
  await chart.request(chart.helloWire());
  const batch = chart.tickWire([{ seq: 1, bid: 1.1, ask: 1.2, quoteTime: 1800000000 }]);
  await chart.request(batch);
  await chart.request(chart.helloWire().replace("|mt4-main|", `|${terminal.terminalId}|`));
  chart.close();
  const reconnect = app.ea(terminal.terminalId!, { session: chart.session });
  await reconnect.request(reconnect.helloWire());
  await reconnect.request(batch);
  assert.equal(samples.length, 1);
  reconnect.close();
  clock.advance(8000);
  const restart = app.ea(terminal.terminalId!, { terminal: "another-old-label" });
  await restart.request(restart.helloWire());
  const snapshot = (await app.get<BridgeSnapshot>("/api/state")).body;
  assert.deepEqual(snapshot.terminals.map((p) => p.terminalId), [terminal.terminalId]);
  assert.deepEqual(snapshot.feeds.map((f) => [f.terminal, f.symbol, f.instances]), [[terminal.terminalId, "EURUSD", 1]]);
});

test("legacy, unknown and mismatched paths stay unsubscribed even when their label claims a detected terminal", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const terminal = await app.terminal(EASY_FOREX);
  const sources: FakeEAOptions[] = [
    { eaVersion: "1.10" },
    { identity: { installationFolder: "C:\\Unknown MT4", dataFolder: "C:\\Unknown data" } },
    { identity: { installationFolder: app.spike.cmc, dataFolder: app.spike.easyForexData } },
  ];
  for (const source of sources) {
    const chart = app.ea(terminal.terminalId!, source);
    assert.equal(await chart.request(chart.helloWire()), `C|1|${chart.session}|0`);
    assert.equal(await chart.request(chart.tickWire([{ seq: 1, bid: 1.1, ask: 1.2, quoteTime: 1800000000 }])), `R|1|${chart.session}`);
  }
  const snapshot = (await app.get<BridgeSnapshot>("/api/state")).body;
  assert.deepEqual(snapshot.feeds, []);
  assert.deepEqual(snapshot.terminals, []);
  assert.equal(snapshot.rejections.length, 3);
  assert.ok(snapshot.rejections.every((r) => r.code === "terminal-identity"));
  assert.ok(snapshot.rejections.every((r) => r.reason.startsWith("Terminal identity unverified")));
  assert.ok((await app.state()).terminals.every((t) => !t.checklist.eaConnected));
});

test("identity uses normalized paths, not their case, separator or the saved label", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const terminal = await app.terminal(EASY_FOREX);
  const typed = (s: string) => s.toLowerCase().replace(/\\/g, "/") + "/";
  const chart = app.ea(terminal.terminalId!, { terminal: "mt4-main", identity: { installationFolder: typed(app.spike.easyForex), dataFolder: typed(app.spike.easyForexData) } });
  assert.equal(await chart.request(chart.helloWire()), `C|1|${chart.session}|1`);
  assert.deepEqual((await app.get<BridgeSnapshot>("/api/state")).body.terminals.map((p) => p.terminalId), [terminal.terminalId]);
});

test("malformed path extensions are rejected safely and a valid hello recovers without an orphan group", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const terminal = await app.terminal(EASY_FOREX);
  const chart = app.ea(terminal.terminalId!);
  const legacy = chart.helloWire().split("|").slice(0, 14).join("|");
  for (const suffix of ["|C:\\OnlyOnePath", "|relative|C:\\data", "|C:\\MT4\\..\\Other|C:\\data", "|C:\\MT4|C:\\data\u0000", "|C:\\MT4|" + "x".repeat(1001)]) {
    assert.equal(await chart.request(legacy + suffix), `C|1|${chart.session}|0`);
  }
  assert.equal(await chart.request(chart.helloWire()), `C|1|${chart.session}|1`);
  const snapshot = (await app.get<BridgeSnapshot>("/api/state")).body;
  assert.equal(snapshot.invalidMessages, 5);
  assert.deepEqual(snapshot.terminals.map((p) => p.terminalId), [terminal.terminalId]);
  assert.equal(snapshot.feeds.length, 1);
});

test("mixed labels of the same symbol produce one feed and preserve one market recording across a restart", { timeout: 15000 }, async (t) => {
  const clock = new FakeClock();
  const app = await start(t, { recording: true, now: clock.now });
  const terminal = await app.terminal(EASY_FOREX);
  assert.equal((await app.post("/api/clock-rules", { brokerServer: "Demo-Broker", winterOffsetMinutes: 0, dst: "none" })).status, 200);
  const first = app.ea(terminal.terminalId!, { terminal: "mt4-main", bars: () => "loading" });
  const second = app.ea(terminal.terminalId!, { bars: () => "loading" });
  await first.request(first.helloWire());
  assert.equal(await second.request(second.helloWire()), `C|1|${second.session}|0`);
  await first.receive(); // The owner's refreshed subscription after a duplicate chart joined.
  const snapshot = (await app.get<BridgeSnapshot>("/api/state")).body;
  assert.deepEqual(snapshot.feeds.map((f) => [f.terminal, f.instances]), [[terminal.terminalId, 2]]);
  assert.equal((await app.post("/api/markets/recording", { brokerServer: "Demo-Broker", symbol: "EURUSD", on: true })).status, 200);
  const sample = [{ seq: 1, bid: 1.1, ask: 1.2, quoteTime: 1800000000 }];
  await first.request(first.tickWire(sample));
  await second.request(second.tickWire(sample)); // A replay from the other chart must not duplicate storage.
  first.close();
  second.close();
  clock.advance(8000);
  const restarted = app.ea(terminal.terminalId!, { terminal: "mt4-main", bars: () => "loading" });
  await restarted.request(restarted.helloWire());
  await restarted.request(restarted.tickWire(sample));
  const { body } = await app.get<{ recordings: { brokerServer: string; symbol: string; samples: number }[] }>("/api/recordings");
  assert.deepEqual(body.recordings.map((r) => [r.brokerServer, r.symbol, r.samples]), [["Demo-Broker", "EURUSD", 1]]);
});

test("a session cannot switch installations or reset another terminal's broker state", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const cmc = await app.terminal(CMC);
  const easy = await app.terminal(EASY_FOREX);
  const first = app.ea(cmc.terminalId!);
  const other = app.ea(easy.terminalId!);
  await first.request(first.helloWire());
  await other.request(other.helloWire());
  const fields = other.helloWire().split("|");
  fields[2] = first.session;
  fields[4] = "Different-Broker";
  assert.equal(await first.request(fields.join("|")), `C|1|${first.session}|0`);
  assert.equal(await first.request(fields.join("|")), `C|1|${first.session}|0`, "retry cannot erase the original session binding");
  const snapshot = (await app.get<BridgeSnapshot>("/api/state")).body;
  assert.equal(snapshot.rejections[0].reason, "Session identity changed");
  assert.deepEqual(snapshot.terminals.map((p) => [p.terminalId, p.brokerServer]), [[easy.terminalId, "Demo-Broker"]]);
  assert.equal(snapshot.feeds[0].online, true);
});

test("identity refusal and recovery retain replay protection for multiple prices within one broker second", { timeout: 15000 }, async (t) => {
  const app = await start(t, { recording: true, now: new FakeClock().now });
  const terminal = await app.terminal(EASY_FOREX);
  await app.post("/api/clock-rules", { brokerServer: "Demo-Broker", winterOffsetMinutes: 0, dst: "none" });
  const chart = app.ea(terminal.terminalId!, { bars: () => "loading" });
  await chart.request(chart.helloWire());
  await app.post("/api/markets/recording", { brokerServer: "Demo-Broker", symbol: "EURUSD", on: true });
  const batch = chart.tickWire([
    { seq: 1, bid: 1.1, ask: 1.2, quoteTime: 1800000000 },
    { seq: 2, bid: 1.3, ask: 1.4, quoteTime: 1800000000 },
  ]);
  await chart.request(batch);
  const refused = chart.helloWire().split("|").slice(0, 14).join("|");
  await chart.request(refused);
  await chart.request(chart.helloWire());
  await chart.request(batch);
  const { body } = await app.get<{ recordings: { samples: number }[] }>("/api/recordings");
  assert.deepEqual(body.recordings.map((r) => r.samples), [2]);
});

test("a revoked last chart cannot restore its old market after a replacement logs into another broker", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const terminal = await app.terminal(EASY_FOREX);
  const old = app.ea(terminal.terminalId!);
  await old.request(old.helloWire());
  await old.request(old.helloWire().split("|").slice(0, 14).join("|"));
  const replacement = app.ea(terminal.terminalId!, { broker: "Other-Broker" });
  await replacement.request(replacement.helloWire());
  assert.equal(await old.request(old.helloWire()), `C|1|${old.session}|0`);
  assert.deepEqual((await app.get<BridgeSnapshot>("/api/state")).body.terminals.map((p) => p.brokerServer), ["Other-Broker"]);
});

test("broker replacement at capacity clears the evicted feed's old-market candles before new samples", { timeout: 60000 }, async (t) => {
  const clock = new FakeClock();
  const app = await start(t, { now: clock.now });
  const terminal = await app.terminal(EASY_FOREX);
  const first = app.ea(terminal.terminalId!, { symbol: "SYM0" });
  await first.request(first.helloWire());
  await first.request(first.tickWire([{ seq: 1, bid: 1.1, ask: 1.2, quoteTime: 1800000000 }]));
  for (let i = 1; i < 1000; i++) {
    const chart = app.ea(terminal.terminalId!, { symbol: `SYM${i}` });
    await chart.request(chart.helloWire());
  }
  const query = new URLSearchParams({ feed: JSON.stringify([terminal.terminalId, "SYM0"]), period: "M1" });
  const page = async () => (await app.get<{ candles: unknown[]; ask: number | null }>(`/api/candles?${query}`)).body;
  assert.equal((await page()).candles.length, 1);
  clock.advance(60001);
  const replacement = app.ea(terminal.terminalId!, { symbol: "SYM0", broker: "Other-Broker" });
  assert.equal(await replacement.request(replacement.helloWire()), `C|1|${replacement.session}|1`);
  assert.deepEqual([(await page()).candles, (await page()).ask], [[], null]);
});

test("a portable terminal becomes verifiable after catalog confirmation, with no EA label edits", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const installationFolder = await app.machine.installationFolder("便携 MT4", "mt4");
  await app.machine.folder(join(installationFolder, "MQL4", "Experts"));
  const chart = app.ea("mt4-main", { identity: { installationFolder, dataFolder: installationFolder } });
  assert.equal(await chart.request(chart.helloWire()), `C|1|${chart.session}|0`);
  const added = await app.post<{ terminal: TerminalView }>("/api/terminals/add-folder", { folder: installationFolder });
  assert.equal(added.status, 200);
  assert.equal(added.body.terminal.portable, true);
  assert.equal(await chart.request(chart.helloWire()), `C|1|${chart.session}|1`);
  assert.deepEqual((await app.get<BridgeSnapshot>("/api/state")).body.terminals.map((p) => p.terminalId), [added.body.terminal.terminalId]);
});

test("the terminals endpoint needs the window session", { timeout: 15000 }, async (t) => {
  const { origin } = await start(t);
  assert.equal((await fetch(origin + "/api/terminals")).status, 401);
  const post = await fetch(origin + "/api/terminals/install", { method: "POST", headers: { "content-type": "application/json", origin }, body: "{}" });
  assert.equal(post.status, 401);
});

test("first run lists every detected terminal: MT4 offered for install, MT5 shown as not yet supported", { timeout: 15000 }, async (t) => {
  const { state } = await start(t);

  const s = await state();
  assert.equal(s.setupCompleted, false);
  assert.equal(s.startWithWindows, true);
  assert.equal(s.bundledEaVersion, "1.11");
  assert.deepEqual(
    s.terminals.map((x) => [x.name, x.kind, x.supported, x.managed, x.offered]),
    [
      [CMC, "mt4", true, false, true],
      [EASY_MARKETS, "mt5", false, false, false],
      [EASY_FOREX, "mt4", true, false, true],
    ],
  );
  const cmc = s.terminals[0];
  assert.equal(cmc.state, "not-installed");
  assert.match(cmc.terminalId ?? "", /^mt4-[0-9a-f]{12}$/);
  assert.match(s.terminals[1].unsupportedReason ?? "", /MetaTrader 5/);
});

test("setup installs into the ticked terminals, declines the others and saves Start with Windows", { timeout: 15000 }, async (t) => {
  const { state, post, until, settings, saved, spike } = await start(t);
  const before = await state();
  const cmcId = before.terminals.find((x) => x.name === CMC)!.terminalId!;
  const easyForexId = before.terminals.find((x) => x.name === EASY_FOREX)!.terminalId!;

  const res = await post("/api/setup", { install: [cmcId], startWithWindows: false });
  assert.equal(res.status, 202);

  const cmc = await until(CMC, (x) => x.state === "installed");
  assert.equal(cmc.managed, true);
  assert.equal(cmc.installedEaVersion, "1.11");
  assert.deepEqual(await readFile(join(spike.cmcData, "MQL4", "Experts", "QuoteBridge.ex4")), EX4);
  const easyForex = (await state()).terminals.find((x) => x.name === EASY_FOREX)!;
  assert.equal(easyForex.managed, false);
  assert.equal(easyForex.offered, false);
  assert.equal(await readIfExists(join(spike.easyForexData, "MQL4", "Experts", "QuoteBridge.ex4")), undefined);

  const s = await settings.read();
  assert.equal(s.setupCompleted, true);
  assert.equal(s.startWithWindows, false);
  assert.deepEqual(s.managedTerminals.map((m) => m.terminalId), [cmcId]);
  assert.deepEqual(s.declinedTerminals.map((d) => d.terminalId), [easyForexId]);
  assert.equal(saved.at(-1)?.setupCompleted, true, "main is told about the saved settings");
  assert.equal((await state()).setupCompleted, true);
});

test("the checklist ticks itself when a fake EA says hello with that terminal's Terminal ID", { timeout: 15000 }, async (t) => {
  const { state, post, until, ea } = await start(t);
  const cmcId = (await state()).terminals.find((x) => x.name === CMC)!.terminalId!;
  await post("/api/setup", { install: [cmcId], startWithWindows: true });
  const installed = await until(CMC, (x) => x.state === "installed");
  assert.deepEqual(installed.checklist, { refreshNavigator: false, applyTemplate: false, allowDllImports: false, eaConnected: false });
  assert.equal(installed.presence, null);

  // An EA in another terminal changes nothing here.
  const other = ea("mt4-ffffffffffff");
  await other.request(other.helloWire());
  const mine = ea(cmcId);
  await mine.request(mine.helloWire());

  const connected = await until(CMC, (x) => x.checklist.eaConnected);
  assert.deepEqual(connected.checklist, { refreshNavigator: true, applyTemplate: true, allowDllImports: true, eaConnected: true });
  assert.equal(connected.presence?.eaVersion, "1.11");
  assert.equal(connected.presence?.online, true);
  assert.equal(typeof connected.presence?.lastHello, "number");
  const easyForex = (await state()).terminals.find((x) => x.name === EASY_FOREX)!;
  assert.equal(easyForex.checklist.eaConnected, false);
});

/** Completes setup with only the CMC terminal ticked and waits for its first install to end. */
async function setUpCmc(app: Awaited<ReturnType<typeof start>>) {
  const cmcId = (await app.state()).terminals.find((x) => x.name === CMC)!.terminalId!;
  await app.post("/api/setup", { install: [cmcId], startWithWindows: true });
  await app.until(CMC, (x) => x.operation === null && x.state !== "not-installed");
  return cmcId;
}

test("a failed compile shows compile failed with the errors, needs attention and keeps its MetaEditor log", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  app.metaEditor.set({ log: { text: FAILED_LOG, encoding: "utf16le" }, exitCode: 1 });
  const cmcId = await setUpCmc(app);

  const cmc = await app.terminal(CMC);
  assert.equal(cmc.state, "compile-failed");
  assert.equal(cmc.lastFailure?.reason, "compile-errors");
  assert.equal(cmc.lastFailure?.errors?.length, 2);
  assert.match(cmc.attention ?? "", /errors/);
  assert.deepEqual(app.server.terminals!.attention().map((a) => [a.terminalId, a.name]), [[cmcId, CMC]]);

  const log = await app.get<{ text: string; result: { errors: number; warnings: number } }>(`/api/terminals/compile-log?terminalId=${cmcId}`);
  assert.equal(log.status, 200);
  assert.deepEqual(log.body.result, { errors: 2, warnings: 1 });
  assert.match(log.body.text, /undeclared identifier/);

  // Recompile after the problem is fixed.
  app.metaEditor.set(SUCCESSFUL_COMPILE);
  assert.equal((await app.post("/api/terminals/install", { terminalIds: [cmcId] })).status, 202);
  const fixed = await app.until(CMC, (x) => x.state === "installed");
  assert.equal(fixed.attention, null);
  assert.equal(fixed.lastFailure, null);
  assert.deepEqual(app.server.terminals!.attention(), []);
});

test("an open MetaEditor of that terminal stops the install and asks the user to close it", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  app.metaEditor.current.running = [join(app.spike.cmc, "metaeditor.exe")];
  await setUpCmc(app);

  const cmc = await app.terminal(CMC);
  assert.equal(cmc.lastFailure?.reason, "metaeditor-running");
  assert.match(cmc.lastFailure?.message ?? "", /Close it/);
  assert.equal(await readIfExists(join(app.spike.cmcData, "MQL4", "Experts", "QuoteBridge.ex4")), undefined);
});

test("an install that throws (e.g. the MetaEditor process query timed out) shows its failure and needs attention; a retry clears it", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  app.metaEditor.current.runningMetaEditors = async () => {
    throw new Error("Listing processes with PowerShell timed out");
  };
  const cmcId = (await app.state()).terminals.find((x) => x.name === CMC)!.terminalId!;
  await app.post("/api/setup", { install: [cmcId], startWithWindows: true });

  const failed = await app.until(CMC, (x) => x.operation === null && x.lastFailure !== null);
  assert.match(failed.lastFailure?.message ?? "", /PowerShell timed out/);
  assert.match(failed.attention ?? "", /PowerShell timed out/);
  assert.deepEqual(app.server.terminals!.attention().map((a) => a.terminalId), [cmcId]);

  app.metaEditor.set(SUCCESSFUL_COMPILE);
  assert.equal((await app.post("/api/terminals/install", { terminalIds: [cmcId] })).status, 202);
  const fixed = await app.until(CMC, (x) => x.state === "installed" && x.operation === null);
  assert.equal(fixed.lastFailure, null);
  assert.equal(fixed.attention, null);
});

test("stopping the server mid-install ends MetaEditor and finishes well inside the supervisor's stop deadline, leaving the terminal untouched", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  app.metaEditor.set({ ...SUCCESSFUL_COMPILE, hang: true });
  const s = await app.state();
  const ids = [CMC, EASY_FOREX].map((name) => s.terminals.find((x) => x.name === name)!.terminalId!);
  await app.post("/api/setup", { install: ids, startWithWindows: true });
  await app.until(CMC, (x) => x.operation === "installing");
  const compiling = app.metaEditor.current;
  // Stop while MetaEditor is compiling (a stop before it starts is cancelled before launching it).
  for (let i = 0; i < 200 && compiling.starts.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(compiling.starts.length, 1, "MetaEditor started");

  const began = Date.now();
  await app.server.close();
  const took = Date.now() - began;

  assert.ok(took < DEFAULT_THRESHOLDS.stopDeadlineMs / 2, `close took ${took} ms`);
  assert.equal(compiling.killed, 1);
  assert.equal(compiling.starts.length, 1, "the queued easy-forex install never started");
  assert.equal(await readIfExists(join(app.spike.cmcData, "MQL4", "Experts", "QuoteBridge.ex4")), undefined);
  assert.equal(await readIfExists(join(app.spike.cmcData, "templates", "QuoteBridge.tpl")), undefined);
  const record = await readIfExists(join(app.appData, "installs", ids[0], "record.json"));
  assert.ok(!record || JSON.parse(record.toString()).installed === null, "no install was recorded");
});

test("two Install requests for one terminal at once (a double click) run one install and refuse the other", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const cmcId = await setUpCmc(app);
  app.metaEditor.set(SUCCESSFUL_COMPILE);

  const statuses = (await Promise.all([1, 2].map(() => app.post("/api/terminals/install", { terminalIds: [cmcId] })))).map((r) => r.status);

  assert.deepEqual(statuses.sort(), [202, 409]);
  await app.until(CMC, (x) => x.operation === null);
  assert.equal(app.metaEditor.current.starts.length, 1);
});

test("two setup requests at once complete setup once", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const cmcId = (await app.state()).terminals.find((x) => x.name === CMC)!.terminalId!;

  const statuses = (await Promise.all([1, 2].map(() => app.post("/api/setup", { install: [cmcId], startWithWindows: true })))).map((r) => r.status);

  assert.deepEqual(statuses.sort(), [202, 409]);
  await app.until(CMC, (x) => x.operation === null && x.state === "installed");
  assert.equal(app.metaEditor.current.starts.length, 1);
});

test("Remove takes the bridge files out and stops managing the terminal", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const cmcId = await setUpCmc(app);

  const res = await app.post<{ removed: string[] }>("/api/terminals/remove", { terminalId: cmcId });
  assert.equal(res.status, 200);
  assert.ok(res.body.removed.includes("MQL4/Experts/QuoteBridge.ex4"));
  assert.equal(await readIfExists(join(app.spike.cmcData, "MQL4", "Experts", "QuoteBridge.ex4")), undefined);
  const cmc = await app.terminal(CMC);
  assert.equal(cmc.state, "not-installed");
  assert.equal(cmc.managed, false);
  assert.equal(cmc.declined, true);
  assert.equal(cmc.offered, false);
  assert.deepEqual((await app.settings.read()).managedTerminals, []);
});

test("rescan offers a terminal installed after setup without installing into it", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  await setUpCmc(app);
  const fresh = await app.machine.installationFolder("New Broker MetaTrader 4", "mt4");
  const freshData = await app.machine.dataFolder(fresh, { mql: "MQL4" });

  const res = await app.post<TerminalsState>("/api/terminals/rescan", {});
  assert.equal(res.status, 200);
  const found = res.body.terminals.find((x) => x.name === "New Broker MetaTrader 4");
  assert.ok(found);
  assert.equal(found.offered, true);
  assert.equal(found.managed, false);
  assert.equal(await readIfExists(join(freshData, "MQL4", "Experts", "QuoteBridge.mq4")), undefined);

  // Declined, it is no longer offered.
  assert.equal((await app.post("/api/terminals/decline", { terminalId: found.terminalId })).status, 200);
  assert.equal((await app.terminal("New Broker MetaTrader 4")).offered, false);
});

test("add folder: a portable terminal is added by its folder; a folder without terminal.exe is refused", { timeout: 15000 }, async (t) => {
  const app = await start(t, { compileTimeoutMs: 1500 });
  const portable = join(app.machine.root, "Portable", "My Portable MT4");
  await app.machine.file(join(portable, "terminal.exe"), (await import("./terminal-fixtures.js")).fakeExecutable(0x014c));
  await app.machine.file(join(portable, "metaeditor.exe"), "MZ");
  await app.machine.folder(join(portable, "MQL4", "Experts"));

  const added = await app.post<{ terminal: TerminalView }>("/api/terminals/add-folder", { folder: portable });
  assert.equal(added.status, 200);
  assert.equal(added.body.terminal.portable, true);
  assert.equal(added.body.terminal.dataFolder, portable);
  assert.equal(added.body.terminal.offered, true);

  const empty = await app.post<{ error: string }>("/api/terminals/add-folder", { folder: join(app.machine.root, "Portable") });
  assert.equal(empty.status, 422);
  assert.match(empty.body.error, /terminal\.exe/);
  assert.equal((await app.post("/api/terminals/add-folder", { folder: "relative\path" })).status, 422);
});

test("unsupported and unknown terminals cannot be installed; a second install while one runs is refused", { timeout: 15000 }, async (t) => {
  const app = await start(t);
  const s = await app.state();
  const mt5 = s.terminals.find((x) => x.name === EASY_MARKETS)!;
  const res = await app.post<{ error: string }>("/api/setup", { install: [mt5.terminalId], startWithWindows: true });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /MetaTrader 5/);
  assert.equal((await app.post("/api/terminals/install", { terminalIds: ["mt4-000000000000"] })).status, 404);
  assert.equal((await app.post("/api/terminals/install", { terminalIds: "nope" })).status, 400);

  app.metaEditor.set({ ...SUCCESSFUL_COMPILE, hang: true });
  const cmcId = s.terminals.find((x) => x.name === CMC)!.terminalId!;
  assert.equal((await app.post("/api/setup", { install: [cmcId], startWithWindows: true })).status, 202);
  await app.until(CMC, (x) => x.operation === "installing");
  assert.equal((await app.post("/api/terminals/install", { terminalIds: [cmcId] })).status, 409);
  assert.equal((await app.post("/api/terminals/remove", { terminalId: cmcId })).status, 409);
  assert.equal((await app.post("/api/setup", { install: [], startWithWindows: true })).status, 409, "setup runs once");
});

test("a hint appears when no EA has connected a while after install, and goes when one does", { timeout: 15000 }, async (t) => {
  const clock = new FakeClock(Date.now());
  const app = await start(t, { now: clock.now, hintAfterMs: 60_000 });
  const cmcId = await setUpCmc(app);
  assert.equal((await app.terminal(CMC)).hint, null);

  clock.advance(60_000);
  assert.match((await app.terminal(CMC)).hint ?? "", /checklist/);

  const chart = app.ea(cmcId);
  await chart.request(chart.helloWire());
  const connected = await app.until(CMC, (x) => x.checklist.eaConnected);
  assert.equal(connected.hint, null);
});

test("the terminals state is one consistent snapshot: an install that ends while it is read never shows as installing with busy false", { timeout: 15000 }, async (t) => {
  // The installer's file reads for one terminal can run a hook: here, the moment the state reads
  // the easy-forex status (after it has read CMC's), the held CMC install is let go and runs to its end.
  let onRead: ((path: string) => Promise<void>) | undefined;
  const hooked = (path: string) => onRead?.(path);
  const installerFs: InstallerFileSystem = {
    ...nodeInstallerFileSystem,
    readFile: async (path) => (await hooked(path), nodeInstallerFileSystem.readFile(path)),
    listFolder: async (path) => (await hooked(path), nodeInstallerFileSystem.listFolder(path)),
  };
  const app = await start(t, { installerFs });
  let release!: () => void;
  app.metaEditor.set({ ...SUCCESSFUL_COMPILE, waitFor: new Promise<void>((resolve) => (release = resolve)) });
  const before = await app.state();
  const cmcId = before.terminals.find((x) => x.name === CMC)!.terminalId!;
  const easyForexId = before.terminals.find((x) => x.name === EASY_FOREX)!.terminalId!;
  await app.post("/api/setup", { install: [cmcId], startWithWindows: true });
  await app.until(CMC, (x) => x.state === "installing");

  let installEnded = false;
  onRead = async (path) => {
    if (!path.includes(easyForexId)) return;
    onRead = undefined;
    const ended = new Promise<void>((resolve) => app.server.terminals!.onChange(() => resolve()));
    release();
    await ended;
    installEnded = true;
  };
  const s = await app.state();
  assert.equal(installEnded, true, "the install ended while the state was being read");

  const working = s.terminals.filter((x) => x.state === "installing" || x.operation !== null).map((x) => x.name);
  assert.equal(s.busy, working.length > 0, `busy is ${s.busy} while ${JSON.stringify(working)} show an install or operation`);
});
