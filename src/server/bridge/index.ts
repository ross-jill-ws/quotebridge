// Bridge server core: the EA-facing ZeroMQ endpoint, feed registry and terminal presence.
export { BridgeServer, ONLINE_WINDOW_MS, STALE_QUOTE_MS } from "./bridge.js";
export type { BridgeServerOptions, BridgeSnapshot, FeedSnapshot, SampleEvent, SampleListener, TerminalPresence } from "./bridge.js";
export { feedKey, marketKey, parseMessage } from "./protocol.js";
export type { EAMessage, Hello, Market, Sample, TickBatch } from "./protocol.js";
