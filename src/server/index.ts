// The bridge server: EA endpoint (ZeroMQ) plus the HTTP server for the app window.
export { startServer } from "./server.js";
export type { RunningServer, ServerConfig } from "./server.js";
export { PortInUseError } from "./port-in-use.js";
export type { PortRole } from "./port-in-use.js";
export { runServerHost, summarise } from "./host.js";
export type { ServerHostOptions } from "./host.js";
export { openDatabase, DatabaseError, DATABASE_FILE_NAME, SCHEMA_VERSION } from "./database.js";
export type { AppDatabase } from "./database.js";
