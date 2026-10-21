// Bridge installer (orchestration over filesystem and MetaEditor ports) and install record.
// Runs in the server process; transport-free.
export { loadBridgeBundle } from "./bundle.js";
export type { BridgeBundle, BridgeBundleFolders, BundledFile } from "./bundle.js";
export { nodeInstallerFileSystem } from "./file-system.js";
export type { InstallerFileSystem } from "./file-system.js";
export { INSTALL_RECORD_FORMAT } from "./install-record.js";
export type { InstalledBridge, InstallFailure, InstallRecord, RecordedFile } from "./install-record.js";
export { BridgeInstaller, InstallInProgressError } from "./installer.js";
export type {
  BridgeInstallerOptions,
  FileAction,
  InstallResult,
  InstallTarget,
  RemoveResult,
  RollbackReport,
  TerminalInstallState,
  TerminalInstallStatus,
  UpdateReason,
} from "./installer.js";
export { serverEndpointFor, substituteTemplate } from "./template.js";
