// The Terminals view model: what a terminal card shows (state, EA connection, actions).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TerminalView } from "../src/server/terminals/index.js";
import { describeTerminal } from "../src/dashboard/terminals/terminal-card.js";
import { setTicked, setupSelection } from "../src/dashboard/terminals/setup-selection.js";

const NOW = 1_800_000_000_000;
const NOT_YET = { refreshNavigator: false, applyTemplate: false, allowDllImports: false, eaConnected: false };

function terminal(overrides: Partial<TerminalView> = {}): TerminalView {
  return {
    key: "mt4-0123456789ab",
    terminalId: "mt4-0123456789ab",
    name: "CMC Markets MetaTrader 4",
    kind: "mt4",
    installationFolder: "C:\\Program Files (x86)\\CMC Markets MetaTrader 4",
    dataFolder: "C:\\Users\\me\\AppData\\Roaming\\MetaQuotes\\Terminal\\ABC",
    portable: false,
    needsConfirmation: false,
    detected: true,
    terminalRunning: false,
    supported: true,
    unsupportedReason: null,
    managed: true,
    declined: false,
    offered: false,
    state: "installed",
    operation: null,
    installedEaVersion: "1.08",
    legacyTerminalId: null,
    lastFailure: null,
    pendingRemoval: [],
    presence: null,
    checklist: NOT_YET,
    hint: null,
    attention: null,
    ...overrides,
  };
}

test("an installed terminal shows its EA version, offers Recompile and Remove, and no EA yet", () => {
  const card = describeTerminal(terminal(), NOW);
  assert.deepEqual(card.state, { text: "Installed v1.08", tone: "good" });
  assert.deepEqual(card.connection, { text: "No EA connected yet", tone: "neutral" });
  assert.equal(card.eaVersion, null);
  assert.deepEqual(card.actions, { install: false, recompile: true, remove: true, decline: false, compileLog: true });
});

test("a connected EA shows its running version; a quiet one shows when it was last heard", () => {
  const online = describeTerminal(terminal({ presence: { lastHello: NOW - 1000, eaVersion: "1.08", online: true } }), NOW);
  assert.deepEqual(online.connection, { text: "EA connected", tone: "good" });
  assert.equal(online.eaVersion, "EA v1.08 running");
  const quiet = describeTerminal(terminal({ presence: { lastHello: NOW - 180_000, eaVersion: null, online: false } }), NOW);
  assert.deepEqual(quiet.connection, { text: "Last heard 3 min ago", tone: "warn" });
  assert.equal(quiet.eaVersion, "EA version unknown (older than 1.08)");
});

test("an offered terminal can be installed or declined; MT5 offers nothing", () => {
  const offered = describeTerminal(terminal({ managed: false, offered: true, state: "not-installed", installedEaVersion: null }), NOW);
  assert.deepEqual(offered.actions, { install: true, recompile: false, remove: false, decline: true, compileLog: false });
  const mt5 = describeTerminal(terminal({ kind: "mt5", supported: false, managed: false, state: null }), NOW);
  assert.deepEqual(mt5.state, { text: "MetaTrader 5: not supported yet", tone: "neutral" });
  assert.deepEqual(mt5.actions, { install: false, recompile: false, remove: false, decline: false, compileLog: false });
});

test("an open MetaEditor asks the user to close it; a compile failure offers its log", () => {
  const failure = { stage: "compile" as const, at: "2026-10-21T10:00:00Z", sourceHash: "x" };
  const open = describeTerminal(terminal({ state: "compile-failed", lastFailure: { ...failure, reason: "metaeditor-running", message: "Close it" } }), NOW);
  assert.equal(open.closeMetaEditor, true);
  assert.deepEqual(open.state, { text: "MetaEditor is open", tone: "bad" });
  assert.equal(open.actions.compileLog, false, "no log: MetaEditor never ran");
  const errors = describeTerminal(terminal({ state: "compile-failed", lastFailure: { ...failure, reason: "compile-errors", message: "errors", compileLog: "C:\\log" } }), NOW);
  assert.deepEqual(errors.state, { text: "Compile failed", tone: "bad" });
  assert.equal(errors.closeMetaEditor, false);
  assert.equal(errors.actions.compileLog, true);
});

test("queued and running installs show progress and make the card busy", () => {
  assert.deepEqual(describeTerminal(terminal({ operation: "queued", state: "not-installed" }), NOW).state.text, "Waiting to install");
  const installing = describeTerminal(terminal({ operation: "installing", state: "installing" }), NOW);
  assert.equal(installing.state.text, "Installing…");
  assert.equal(installing.busy, true);
});

// The setup screen: the ticks it shows are exactly what Install sends.
const CMC = terminal({ managed: false, offered: true, state: "not-installed", installedEaVersion: null });
const EASY_FOREX = terminal({ key: "mt4-0f5715a276b2", terminalId: "mt4-0f5715a276b2", name: "MT4 at easy-forex", managed: false, offered: true, state: "not-installed", installedEaVersion: null });
const MT5 = terminal({ key: "mt5-111111111111", terminalId: "mt5-111111111111", name: "easyMarkets MetaTrader 5", kind: "mt5", supported: false, managed: false, state: null });

test("setup pre-ticks every MT4 terminal, never MT5, and Install sends the ticked ones", () => {
  const selection = setupSelection([CMC, EASY_FOREX, MT5], new Set());
  assert.deepEqual([CMC, EASY_FOREX, MT5].map((t) => selection.checked(t)), [true, true, false]);
  assert.deepEqual(selection.install, ["mt4-0123456789ab", "mt4-0f5715a276b2"]);
});

test("an unticked terminal shows unticked and is left out of Install, and a later refresh keeps it unticked", () => {
  const unticked = setTicked(new Set(), CMC.terminalId!, false);
  const selection = setupSelection([CMC, EASY_FOREX, MT5], unticked);
  assert.equal(selection.checked(CMC), false);
  assert.deepEqual(selection.install, ["mt4-0f5715a276b2"]);
  // A poll brings new objects in another order, with a newly found terminal (pre-ticked).
  const added = terminal({ key: "mt4-222222222222", terminalId: "mt4-222222222222", name: "New Broker MetaTrader 4", managed: false, offered: true });
  const refreshed = setupSelection([{ ...EASY_FOREX }, added, { ...MT5 }, { ...CMC }], unticked);
  assert.equal(refreshed.checked({ ...CMC }), false);
  assert.deepEqual(refreshed.install, ["mt4-0f5715a276b2", "mt4-222222222222"]);
  // Ticked again, it is sent again.
  assert.deepEqual(setupSelection([CMC, EASY_FOREX], setTicked(unticked, CMC.terminalId!, true)).install, ["mt4-0123456789ab", "mt4-0f5715a276b2"]);
});

test("a terminal without a Terminal ID yet (portable mode not confirmed) is neither ticked nor sent", () => {
  const unconfirmed = terminal({ key: "folder:C:\Portable MT4", terminalId: null, needsConfirmation: true, managed: false });
  const selection = setupSelection([unconfirmed, EASY_FOREX], new Set());
  assert.equal(selection.checked(unconfirmed), false);
  assert.deepEqual(selection.install, ["mt4-0f5715a276b2"]);
});
