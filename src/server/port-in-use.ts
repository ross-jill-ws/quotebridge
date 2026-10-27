// "Port in use": structured so the supervisor and app window can explain it (story 61),
// e.g. when the legacy server still holds the EA port.

/** Which of the app's ports: the EA port (ZeroMQ, QuoteBridge EAs) or the HTTP port (dashboard). */
export type PortRole = "ea" | "http";

export class PortInUseError extends Error {
  readonly code = "port-in-use";
  constructor(
    readonly which: PortRole,
    readonly port: number,
  ) {
    super(`The ${which === "ea" ? "EA port" : "HTTP port"} ${port} on ${which === "ea" ? "127.0.0.1" : "127.0.0.1 or ::1"} is already in use by another program.`);
    this.name = "PortInUseError";
  }
}

/** Rethrows an EADDRINUSE bind/listen error as a PortInUseError. */
export function asPortInUse(error: unknown, which: PortRole, port: number): unknown {
  return (error as { code?: unknown } | null)?.code === "EADDRINUSE" ? new PortInUseError(which, port) : error;
}
