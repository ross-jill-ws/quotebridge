// The supervisor's Electron adapter: launches the server entry point as an Electron utility process.
// Structural types only, so this module does not load Electron itself; main passes `utilityProcess.fork`.
import { utilityProcessTransport, type UtilityProcessLike } from "../../shared/host-transport.js";
import type { HostMessage, ServerMessage } from "../../shared/server-host-protocol.js";
import type { ServerProcess } from "./supervisor.js";

/** The part of Electron's `UtilityProcess` the supervisor uses. */
export type UtilityProcessChild = UtilityProcessLike & {
  once(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
};

/** Electron's `utilityProcess.fork`. */
export type UtilityProcessFork = (modulePath: string, args?: string[], options?: { serviceName?: string }) => UtilityProcessChild;

/** A `launch` port for the supervisor: each call starts a new server process from `entryPath` (`dist/server/entry.js`). */
export function utilityProcessLauncher(fork: UtilityProcessFork, entryPath: string): () => ServerProcess {
  return () => {
    const child = fork(entryPath, [], { serviceName: "QuoteBridge server" });
    return {
      transport: utilityProcessTransport<ServerMessage, HostMessage>(child),
      onExit: (listener) => void child.once("exit", listener),
      kill: () => void child.kill(),
    };
  };
}
