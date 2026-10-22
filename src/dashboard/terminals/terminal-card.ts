// Terminal card view model: what a terminal's state, EA connection and actions look like. Pure.
import type { TerminalView } from "../../server/terminals/index.js";
import { duration } from "../format.js";

export type Tone = "good" | "warn" | "bad" | "neutral";

/**
 * The panel's shape shows the terminal's state: `compact` when ready, `setup` with the four MetaTrader steps
 * while its EA has not connected, `found` (dashed) when not managed, `attention` (Fault) when it needs the user.
 */
export type PanelShape = "compact" | "setup" | "found" | "attention";

export type SetupStep = { key: keyof TerminalView["checklist"]; title: string; text: string; status: "done" | "next" | "todo" };

export interface TerminalCard {
  shape: PanelShape;
  /** The four MetaTrader steps, for the `setup` shape only. */
  steps: SetupStep[] | null;
  /** Why the terminal needs attention and what fixes it; `retry` offers to install again. */
  fault: { reason: string; fix: string; retry: boolean } | null;
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

const CHECKLIST_STEPS: Omit<SetupStep, "status">[] = [
  { key: "refreshNavigator", title: "Refresh the Navigator", text: "In MetaTrader, right-click Expert Advisors in the Navigator and choose Refresh." },
  { key: "applyTemplate", title: "Apply the template", text: "Open a chart, right-click it and choose Template › QuoteBridge." },
  { key: "allowDllImports", title: "Allow DLL imports", text: "On that chart press F7, open the Common tab and tick Allow DLL imports, then OK." },
  { key: "eaConnected", title: "EA connects", text: "This ticks itself once the QuoteBridge EA connects to the app." },
];

const FIXES: Record<string, string> = {
  "metaeditor-running": "Close MetaEditor (File › Exit), then retry, so the compile is not sent to your open editor.",
  "copy-failed": "Close MetaTrader if it is running, so it lets go of the bridge files, then retry.",
  "no-metaeditor": "Repair or reinstall this MetaTrader terminal so its folder has metaeditor.exe, then rescan.",
};
const COMPILE_FIX = "Open the compile log to see what MetaEditor reported, then retry.";
const OTHER_FIX = "Retry. If it fails again, restart the app and try once more.";

export function describeTerminal(t: TerminalView, now: number): TerminalCard {
  const fault = faultOf(t);
  const shape: PanelShape = !t.managed ? "found" : fault ? "attention" : settingUp(t) ? "setup" : "compact";
  return {
    shape,
    steps: shape === "setup" ? steps(t) : null,
    fault,
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

/** Installed, and the EA has not connected yet: the MetaTrader steps are still to do. */
function settingUp(t: TerminalView): boolean {
  return (t.state === "installed" || t.state === "outdated") && Object.values(t.checklist).some((done) => !done);
}

function steps(t: TerminalView): SetupStep[] {
  const next = CHECKLIST_STEPS.find((step) => !t.checklist[step.key]);
  return CHECKLIST_STEPS.map((step) => ({ ...step, status: t.checklist[step.key] ? "done" : step === next ? "next" : "todo" }));
}

function faultOf(t: TerminalView): TerminalCard["fault"] {
  if (!t.managed || !t.attention) return null;
  const reason = t.state === "no-metaeditor" && !t.lastFailure ? "no-metaeditor" : t.lastFailure?.reason;
  const fix = (reason && FIXES[reason]) ?? (t.lastFailure?.stage === "compile" ? COMPILE_FIX : OTHER_FIX);
  return { reason: t.attention, fix, retry: reason !== "no-metaeditor" };
}
