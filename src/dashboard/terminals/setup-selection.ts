// Setup screen ticks: every supported terminal with a Terminal ID is ticked unless the user unticked
// it. The rows' checkboxes and the Install request both come from here, so they cannot disagree. Pure.
import type { TerminalView } from "../../server/terminals/index.js";

export interface SetupSelection {
  /** Whether the row shows ticked. */
  checked(t: TerminalView): boolean;
  /** The Terminal IDs Install sends, in the order the rows show. */
  install: string[];
}

export function setupSelection(terminals: TerminalView[], unticked: ReadonlySet<string>): SetupSelection {
  const checked = (t: TerminalView) => t.supported && !!t.terminalId && !unticked.has(t.terminalId);
  return { checked, install: terminals.filter(checked).map((t) => t.terminalId!) };
}

/** The unticked set after the user ticks (`on`) or unticks a terminal. */
export function setTicked(unticked: ReadonlySet<string>, terminalId: string, on: boolean): Set<string> {
  const next = new Set(unticked);
  if (on) next.delete(terminalId);
  else next.add(terminalId);
  return next;
}
