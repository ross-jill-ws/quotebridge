// Bridge server core: the EA-facing ZeroMQ endpoint, feed registry and terminal presence.
export { BridgeServer, ONLINE_WINDOW_MS, STALE_QUOTE_MS } from "./bridge.js";
export type { BridgeServerOptions, BridgeSnapshot, FeedSnapshot, TerminalPresence } from "./bridge.js";
export { feedKey, parseMessage } from "./protocol.js";
export type { EAMessage, Hello, Sample, TickBatch } from "./protocol.js";
