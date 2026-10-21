// Terminal catalog: finds the MetaTrader terminals on this computer. Pure logic over a read-only
// filesystem port; the Windows-specific sources (process list, install locations) are an adapter.
export { detectTerminals } from "./catalog.js";
export type { DetectedTerminal, RunningTerminal, TerminalEvidence, TerminalKind, TerminalSources } from "./catalog.js";
export { nodeTerminalFileSystem } from "./file-system.js";
export type { TerminalFileSystem } from "./file-system.js";
export { dataFolderNameFor } from "./paths.js";
export { terminalIdFor } from "./terminal-id.js";
export { runningTerminalsFromProcessList, windowsTerminalSources } from "./windows-sources.js";
