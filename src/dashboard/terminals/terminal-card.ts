// Terminal card view model: what a terminal's state, EA connection and actions look like. Pure.
import type { TerminalView } from "../../server/terminals/index.js";
import { duration } from "../format.js";

export type Tone = "good" | "warn" | "bad" | "neutral";

export interface TerminalCard {
  /** The install state badge: "Installed v1.08", "Compile failed", … */
  state: { text: string; tone: Tone };
  /** EA connection: "EA connected", "Last heard 3 min ago", "No EA connected yet". */
  connection: { text: string; tone: Tone };
  /** "EA v1.08 running", or null when no EA was heard. */
  eaVersion: string | null;
  /** Which actions the card offers. */
  actions: { install: boolean; recompile: boolean; remove: boolean; decline: boolean; compileLog: boolean };
  /** MetaEditor of this terminal is open: ask the user to close it, then retry. */
  closeMetaEditor: boolean;
  busy: boolean;
}

export const CHECKLIST_STEPS: { key: keyof TerminalView["checklist"]; text: string }[] = [
  { key: "refreshNavigator", text: "In MetaTrader, right-click Expert Advisors in the Navigator and choose Refresh." },
  { key: "applyTemplate", text: "Open a chart, right-click it and choose Template › QuoteBridge." },
  { key: "allowDllImports", text: "On that chart press F7, and on the Common tab tick Allow DLL imports, then OK." },
  { key: "eaConnected", text: "The QuoteBridge EA connects to the app." },
];

export function describeTerminal(t: TerminalView, now: number): TerminalCard {
  return {
    state: stateBadge(t),
    connection: connection(t, now),
    eaVersion: t.presence ? (t.presence.eaVersion ? `EA v${t.presence.eaVersion} running` : "EA version unknown (older than 1.08)") : null,
    actions: {
      install: t.supported && !t.managed,
      recompile: t.supported && t.managed && t.state !== "no-metaeditor",
      remove: t.supported && t.managed,
      decline: t.offered,
      compileLog: t.supported && (t.lastFailure?.stage === "compile" ? !!t.lastFailure.compileLog : t.state === "installed" || t.state === "outdated"),
    },
    closeMetaEditor: t.lastFailure?.reason === "metaeditor-running",
    busy: t.operation !== null,
  };
}

function stateBadge(t: TerminalView): TerminalCard["state"] {
  if (!t.supported) return { text: t.kind === "mt5" ? "MetaTrader 5: not supported yet" : "Not supported", tone: "neutral" };
  if (t.operation === "queued") return { text: "Waiting to install", tone: "neutral" };
  if (t.operation === "installing" || t.state === "installing") return { text: "Installing…", tone: "neutral" };
  if (t.operation === "removing") return { text: "Removing…", tone: "neutral" };
  switch (t.state) {
    case "installed":
      return { text: `Installed v${t.installedEaVersion}`, tone: "good" };
    case "outdated":
      return { text: `Outdated (v${t.installedEaVersion} installed)`, tone: "warn" };
    case "compile-failed":
      return { text: t.lastFailure?.reason === "metaeditor-running" ? "MetaEditor is open" : "Compile failed", tone: "bad" };
    case "no-metaeditor":
      return { text: "No MetaEditor", tone: "bad" };
    case "installed-legacy":
      return { text: "Legacy bridge files", tone: "warn" };
    default:
      return { text: "Not installed", tone: "neutral" };
  }
}

function connection(t: TerminalView, now: number): TerminalCard["connection"] {
  if (!t.presence) return { text: "No EA connected yet", tone: "neutral" };
  if (t.presence.online) return { text: "EA connected", tone: "good" };
  return { text: `Last heard ${duration(now - t.presence.lastHello)} ago`, tone: "warn" };
}
