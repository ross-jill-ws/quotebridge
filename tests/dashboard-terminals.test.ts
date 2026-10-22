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
    brokerClock: null,
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
  const online = describeTerminal(terminal({ presence: { lastHello: NOW - 1000, eaVersion: "1.08", online: true, brokerServer: "CMC-Live" } }), NOW);
  assert.deepEqual(online.connection, { text: "EA connected", tone: "good" });
  assert.equal(online.eaVersion, "EA v1.08 running");
  const quiet = describeTerminal(terminal({ presence: { lastHello: NOW - 180_000, eaVersion: null, online: false, brokerServer: "CMC-Live" } }), NOW);
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


// The panel shape: compact when ready, the four-step strip while being set up, dashed when found but not managed, Fault when it needs attention.
const DONE = { refreshNavigator: true, applyTemplate: true, allowDllImports: true, eaConnected: true };
const CONNECTED = { lastHello: NOW - 1000, eaVersion: "1.08", online: true, brokerServer: "CMC-Live" };

test("an installed terminal whose EA has connected is a compact panel without the steps", () => {
  const card = describeTerminal(terminal({ checklist: DONE, presence: CONNECTED }), NOW);
  assert.equal(card.shape, "compact");
  assert.equal(card.steps, null);
});

test("an installed terminal whose EA has not connected yet shows the four MetaTrader steps, the first one not done next", () => {
  const card = describeTerminal(terminal(), NOW);
  assert.equal(card.shape, "setup");
  assert.deepEqual(
    card.steps?.map((s) => [s.title, s.status]),
    [
      ["Refresh the Navigator", "next"],
      ["Apply the template", "todo"],
      ["Allow DLL imports", "todo"],
      ["EA connects", "todo"],
    ],
  );
  const later = describeTerminal(terminal({ checklist: { ...NOT_YET, refreshNavigator: true, applyTemplate: true } }), NOW);
  assert.deepEqual(later.steps?.map((s) => s.status), ["done", "done", "next", "todo"]);
});

test("a terminal found but not managed is dashed, offered or declined, and so is one the app cannot manage", () => {
  assert.equal(describeTerminal(terminal({ managed: false, offered: true, state: "not-installed", installedEaVersion: null }), NOW).shape, "found");
  assert.equal(describeTerminal(terminal({ managed: false, declined: true, state: "not-installed", installedEaVersion: null }), NOW).shape, "found");
  assert.equal(describeTerminal(terminal({ kind: "mt5", supported: false, managed: false, state: null }), NOW).shape, "found");
});

test("a terminal that needs attention is in Fault style with the reason and its fix", () => {
  const failure = { stage: "compile" as const, at: "2026-10-21T10:00:00Z", sourceHash: "x" };
  const open = terminal({
    state: "compile-failed",
    lastFailure: { ...failure, reason: "metaeditor-running", message: "MetaEditor of this terminal is open. Close it, then install again." },
    attention: "MetaEditor of this terminal is open. Close it, then install again.",
  });
  const card = describeTerminal(open, NOW);
  assert.equal(card.shape, "attention");
  assert.deepEqual(card.fault, {
    reason: "MetaEditor of this terminal is open. Close it, then install again.",
    fix: "Close MetaEditor (File › Exit), then retry, so the compile is not sent to your open editor.",
    retry: true,
  });

  const errors = describeTerminal(terminal({ state: "compile-failed", lastFailure: { ...failure, reason: "compile-errors", message: "errors", compileLog: "C:\log" }, attention: "errors" }), NOW);
  assert.equal(errors.fault?.fix, "Open the compile log to see what MetaEditor reported, then retry.");
  const copy = describeTerminal(terminal({ lastFailure: { ...failure, stage: "copy", reason: "copy-failed", message: "Copying failed" }, attention: "Copying failed" }), NOW);
  assert.equal(copy.fault?.fix, "Close MetaTrader if it is running, so it lets go of the bridge files, then retry.");
  const none = describeTerminal(terminal({ state: "no-metaeditor", attention: "no MetaEditor" }), NOW);
  assert.deepEqual(none.fault, { reason: "no MetaEditor", fix: "Repair or reinstall this MetaTrader terminal so its folder has metaeditor.exe, then rescan.", retry: false });
});

test("a healthy terminal has no fault", () => {
  assert.equal(describeTerminal(terminal({ checklist: DONE, presence: CONNECTED }), NOW).fault, null);
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

// The broker clock line: the rule of the broker server the terminal is logged into, its source, and a mismatch.
const US_RULE = { winterOffsetMinutes: 120, dst: "us" } as const;
function clock(overrides: Partial<NonNullable<TerminalView["brokerClock"]>> = {}): NonNullable<TerminalView["brokerClock"]> {
  return {
    brokerServer: "CMC-Live",
    rule: US_RULE,
    source: "inferred",
    description: "GMT+2, GMT+3 in US summer time",
    lastObserved: { offsetMinutes: 120, at: NOW - 1000 },
    mismatch: null,
    ...overrides,
  };
}

test("a terminal shows its broker server's clock rule and whether it was inferred or set", () => {
  const inferred = describeTerminal(terminal({ checklist: DONE, presence: CONNECTED, brokerClock: clock() }), NOW);
  assert.deepEqual(inferred.brokerClock, {
    brokerServer: "CMC-Live",
    text: "Broker clock: GMT+2, GMT+3 in US summer time · inferred",
    rule: US_RULE,
    caution: null,
  });
  const set = describeTerminal(terminal({ checklist: DONE, presence: CONNECTED, brokerClock: clock({ source: "set" }) }), NOW);
  assert.equal(set.brokerClock?.text, "Broker clock: GMT+2, GMT+3 in US summer time · set by you");
  assert.equal(describeTerminal(terminal({ presence: CONNECTED }), NOW).brokerClock, null, "no rule known yet");
});

test("an observed offset that contradicts the rule shows a Caution line", () => {
  // 15 January 2027: winter, so the rule expects GMT+2.
  const now = Date.UTC(2027, 0, 15, 8);
  const card = describeTerminal(
    terminal({ checklist: DONE, presence: CONNECTED, brokerClock: clock({ mismatch: { observedOffsetMinutes: 180, since: now - 25 * 60_000 } }) }),
    now,
  );
  assert.equal(card.brokerClock?.caution, "The broker clock has read GMT+3 for 25 min, but this rule expects GMT+2 now. If the broker changed its clock, change the rule.");
});
