// Live bridge snapshots for the views, from the server's /live WebSocket.
import { useEffect, useState } from "preact/hooks";
import type { BridgeSnapshot } from "../server/bridge/index.js";
import { sessionValid } from "./api.js";
import { LiveClient, type LiveSocket, type LiveStatus } from "./live-client.js";

export type Live = {
  status: LiveStatus;
  snapshot?: BridgeSnapshot;
  /** `performance.now()` when the snapshot arrived; the server sends a new one only when something changes. */
  receivedAt: number;
};

export function useLive(): Live {
  const [live, setLive] = useState<Live>({ status: "connecting", receivedAt: 0 });
  useEffect(() => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/live`;
    const client = new LiveClient<BridgeSnapshot>({
      open: () => browserSocket(url),
      onSnapshot: (snapshot) => setLive((l) => ({ ...l, snapshot, receivedAt: performance.now() })),
      onStatus: (status) => setLive((l) => ({ ...l, status })),
      sessionValid,
    });
    client.start();
    return () => client.stop();
  }, []);
  return live;
}

/** Re-renders every `ms` so elapsed times ("unchanged for 42 s") keep counting between snapshots. */
export function useTicker(ms: number): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function browserSocket(url: string): LiveSocket {
  const ws = new WebSocket(url);
  const socket: LiveSocket = { onopen: null, onmessage: null, onclose: null, onerror: null, close: () => ws.close() };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => socket.onmessage?.({ data: event.data });
  ws.onclose = () => socket.onclose?.();
  ws.onerror = () => socket.onerror?.();
  return socket;
}
