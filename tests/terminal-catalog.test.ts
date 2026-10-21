import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { dataFolderNameFor, detectTerminals, runningTerminalsFromProcessList, terminalIdFor } from "../src/shared/terminal-catalog/index.js";
import { MachineFixture, spikeMachine, X64 } from "./terminal-fixtures.js";

const win = String.raw;

test("data folder name is derived from the installation folder (spike's three real terminals)", () => {
  assert.equal(dataFolderNameFor(win`C:\Program Files (x86)\CMC Markets MetaTrader 4`), "B313D8B5E3EEA7D6CF15F515B9125C20");
  assert.equal(dataFolderNameFor(win`C:\Program Files (x86)\MT4 at easy-forex`), "06741A3058418EEB2DECBB1F6BDB7098");
  assert.equal(dataFolderNameFor(win`C:\Program Files\easyMarkets MetaTrader 5`), "FEC98F1D078C037902D797DB372EA18E");
});

test("data folder name ignores case and a trailing backslash", () => {
  assert.equal(dataFolderNameFor("c:\\program files (x86)\\cmc markets metatrader 4\\"), "B313D8B5E3EEA7D6CF15F515B9125C20");
});

const cmcDataFolder = win`C:\Users\Trader\AppData\Roaming\MetaQuotes\Terminal\B313D8B5E3EEA7D6CF15F515B9125C20`;

test("Terminal ID is mt4- plus 12 hex of SHA-256 of the normalised data-folder path", () => {
  // Known-good value computed independently with PowerShell (UTF-8 bytes of the upper-cased path).
  assert.equal(terminalIdFor(cmcDataFolder), "mt4-42a75ef93d82");
});

test("Terminal ID is stable across case and trailing backslash, and differs per data folder", () => {
  assert.equal(terminalIdFor(cmcDataFolder.toLowerCase() + "\\"), "mt4-42a75ef93d82");
  assert.notEqual(terminalIdFor(cmcDataFolder.replace("B313", "0674")), "mt4-42a75ef93d82");
});

test("the spike machine yields its three real terminals and skips shared and leftover folders", async (t) => {
  const fixture = await MachineFixture.create();
  t.after(() => fixture.dispose());
  const machine = await spikeMachine(fixture);

  const terminals = await detectTerminals({ dataRoot: fixture.dataRoot });

  assert.deepEqual(
    terminals.map((terminal) => ({
      name: terminal.name,
      kind: terminal.kind,
      installationFolder: terminal.installationFolder,
      dataFolder: terminal.dataFolder,
      portable: terminal.portable,
      needsConfirmation: terminal.needsConfirmation,
      evidence: terminal.evidence,
    })),
    [
      { name: "CMC Markets MetaTrader 4", kind: "mt4", installationFolder: machine.cmc, dataFolder: machine.cmcData, portable: false, needsConfirmation: false, evidence: ["origin.txt"] },
      { name: "easyMarkets MetaTrader 5", kind: "mt5", installationFolder: machine.easyMarkets, dataFolder: machine.easyMarketsData, portable: false, needsConfirmation: false, evidence: ["origin.txt"] },
      { name: "MT4 at easy-forex", kind: "mt4", installationFolder: machine.easyForex, dataFolder: machine.easyForexData, portable: false, needsConfirmation: false, evidence: ["origin.txt"] },
    ],
  );
  assert.equal(terminals[0]!.terminalId, terminalIdFor(machine.cmcData));
});

test("a data folder without origin.txt is paired with a well-known installation folder by the hash rule", async (t) => {
  const fixture = await MachineFixture.create();
  t.after(() => fixture.dispose());
  const installation = await fixture.installationFolder("Fresh Broker MetaTrader 4", "mt4");
  const dataFolder = await fixture.dataFolder(installation, { mql: "MQL4", origin: null });

  const terminals = await detectTerminals({ dataRoot: fixture.dataRoot, installationRoots: [fixture.programFiles] });

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]!.installationFolder, installation);
  assert.equal(terminals[0]!.dataFolder, dataFolder);
  assert.equal(terminals[0]!.needsConfirmation, false);
  assert.deepEqual(terminals[0]!.evidence, ["folder-name-hash", "well-known-location"]);
});

test("a terminal found both by origin.txt and in a well-known location is listed once", async (t) => {
  const fixture = await MachineFixture.create();
  t.after(() => fixture.dispose());
  const machine = await spikeMachine(fixture);

  const terminals = await detectTerminals({ dataRoot: fixture.dataRoot, installationRoots: [fixture.programFiles] });

  assert.deepEqual(terminals.map((terminal) => terminal.installationFolder), [machine.cmc, machine.easyMarkets, machine.easyForex]);
  assert.deepEqual(terminals[0]!.evidence, ["origin.txt", "well-known-location"]);
});

test("an installation folder containing MQL4 is not portable; unpaired, it asks the user to confirm", async (t) => {
  const fixture = await MachineFixture.create();
  t.after(() => fixture.dispose());
  const installation = await fixture.installationFolder("MT4 at easy-forex", "mt4");
  await fixture.folder(join(installation, "MQL4", "Experts"));

  const terminals = await detectTerminals({ dataRoot: fixture.dataRoot, installationRoots: [fixture.programFiles] });

  assert.deepEqual(terminals, [
    {
      name: "MT4 at easy-forex",
      installationFolder: installation,
      dataFolder: undefined,
      terminalId: undefined,
      kind: "mt4",
      portable: false,
      needsConfirmation: true,
      evidence: ["well-known-location"],
    },
  ]);
});

test("an MQL4 data folder whose terminal.exe is not x86 is not taken for MT4", async (t) => {
  const fixture = await MachineFixture.create();
  t.after(() => fixture.dispose());
  const installation = await fixture.installationFolder("Odd Broker Terminal", "mt4", X64);
  await fixture.dataFolder(installation, { mql: "MQL4" });

  const [terminal] = await detectTerminals({ dataRoot: fixture.dataRoot });

  assert.equal(terminal!.kind, "unknown");
});

test("a terminal running with /portable uses its installation folder as its data folder", async (t) => {
  const fixture = await MachineFixture.create();
  t.after(() => fixture.dispose());
  const machine = await spikeMachine(fixture);
  const portable = await fixture.installationFolder("Portable Broker MT4", "mt4");
  await fixture.folder(join(portable, "MQL4", "Experts"));

  const terminals = await detectTerminals({
    dataRoot: fixture.dataRoot,
    runningTerminals: [
      { executablePath: join(portable, "terminal.exe"), portable: true },
      { executablePath: join(machine.cmc, "terminal.exe"), portable: false },
    ],
  });

  const byName = new Map(terminals.map((terminal) => [terminal.name, terminal]));
  assert.deepEqual(byName.get("Portable Broker MT4"), {
    name: "Portable Broker MT4",
    installationFolder: portable,
    dataFolder: portable,
    terminalId: terminalIdFor(portable),
    kind: "mt4",
    portable: true,
    needsConfirmation: false,
    evidence: ["running-process", "portable-switch"],
  });
  assert.deepEqual(byName.get("CMC Markets MetaTrader 4")!.evidence, ["origin.txt", "running-process"]);
  assert.equal(byName.get("CMC Markets MetaTrader 4")!.portable, false);
  assert.equal(terminals.length, 4);
});

test("a user-added folder pairs like any other, and unpaired counts as a confirmed portable terminal", async (t) => {
  const fixture = await MachineFixture.create();
  t.after(() => fixture.dispose());
  const machine = await spikeMachine(fixture);
  const chosen = await fixture.installationFolder("USB Stick MT4", "mt4");
  await fixture.folder(join(chosen, "MQL4", "Experts"));

  const terminals = await detectTerminals({ dataRoot: fixture.dataRoot, userAddedFolders: [chosen, machine.easyForex] });

  const byName = new Map(terminals.map((terminal) => [terminal.name, terminal]));
  assert.deepEqual(byName.get("USB Stick MT4"), {
    name: "USB Stick MT4",
    installationFolder: chosen,
    dataFolder: chosen,
    terminalId: terminalIdFor(chosen),
    kind: "mt4",
    portable: true,
    needsConfirmation: false,
    evidence: ["user-added"],
  });
  assert.deepEqual(byName.get("MT4 at easy-forex")!.evidence, ["origin.txt", "user-added"]);
  assert.equal(byName.get("MT4 at easy-forex")!.dataFolder, machine.easyForexData);
  assert.equal(terminals.length, 4);
});

test("running terminals are read from the Windows process list, /portable only as an argument", () => {
  const processList = JSON.stringify([
    { ExecutablePath: win`C:\Program Files (x86)\CMC Markets MetaTrader 4\terminal.exe`, CommandLine: win`"C:\Program Files (x86)\CMC Markets MetaTrader 4\terminal.exe"` },
    { ExecutablePath: win`D:\portable\MT4\terminal.exe`, CommandLine: win`"D:\portable\MT4\terminal.exe" /portable` },
    { ExecutablePath: win`D:\portable\Other\terminal.exe`, CommandLine: win`D:\portable\Other\terminal.exe /PORTABLE /skipupdate` },
    { ExecutablePath: win`D:\my /portable copy\terminal.exe`, CommandLine: win`"D:\my /portable copy\terminal.exe"` },
    { ExecutablePath: null, CommandLine: null },
  ]);

  assert.deepEqual(
    runningTerminalsFromProcessList(processList).map((running) => running.portable),
    [false, true, true, false],
  );
  assert.deepEqual(runningTerminalsFromProcessList(""), []);
  assert.equal(runningTerminalsFromProcessList(JSON.stringify(JSON.parse(processList)[1])).length, 1);
});

test("origin.txt in UTF-8 or without a byte-order mark is tolerated", async (t) => {
  const fixture = await MachineFixture.create();
  t.after(() => fixture.dispose());
  const utf8 = await fixture.installationFolder("UTF-8 Broker", "mt4");
  const bomless = await fixture.installationFolder("BOM-less Broker", "mt4");
  await fixture.dataFolder(utf8, { mql: "MQL4", origin: Buffer.from(`${utf8}\r\n`, "utf8") });
  await fixture.dataFolder(bomless, { mql: "MQL4", origin: Buffer.from(bomless, "utf16le") });

  const terminals = await detectTerminals({ dataRoot: fixture.dataRoot });

  assert.deepEqual(terminals.map((terminal) => terminal.installationFolder), [bomless, utf8]);
});

test("Terminal ID and data-folder name do not depend on the slash style of a typed path", () => {
  assert.equal(terminalIdFor(cmcDataFolder.split("\\").join("/")), "mt4-42a75ef93d82");
  assert.equal(dataFolderNameFor(win`C:/Program Files (x86)/CMC Markets MetaTrader 4/`), dataFolderNameFor(win`C:\Program Files (x86)\CMC Markets MetaTrader 4`));
});

test("a UTF-16BE origin.txt with an odd byte count does not stop the scan; the other terminals are still found", async (t) => {
  const fixture = await MachineFixture.create();
  t.after(() => fixture.dispose());
  const good = await fixture.installationFolder("Good Broker", "mt4");
  const odd = await fixture.installationFolder("Odd Broker", "mt4");
  await fixture.dataFolder(good, { mql: "MQL4" });
  const bigEndian = Buffer.from(odd, "utf16le").swap16();
  await fixture.dataFolder(odd, { mql: "MQL4", origin: Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian, Buffer.from([0x00])]) });

  const terminals = await detectTerminals({ dataRoot: fixture.dataRoot });

  assert.ok(terminals.some((terminal) => terminal.installationFolder === good));
});
